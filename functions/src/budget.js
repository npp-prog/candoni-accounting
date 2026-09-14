/**
 * Budget module — Appropriation / Allotment / Supplemental / Augmentation
 * and Obligation Requests. Ported from the Budget Allotment + Obligation
 * Request sections of Code.gs.
 *
 * A budget line is identified by Fund + Office/Function Code + FPP Code +
 * Allotment Class (Expense Code/Name were removed from Appropriation in
 * the original spec, same here). Balance = Allotment + Supplemental +
 * Augmentation - Obligation, where Obligation is computed live from the
 * matching Obligation Request rows rather than stored, so it can never
 * drift out of sync.
 *
 * Some of the finer validation nuances from later rounds of the original
 * spreadsheet (the full 14-sector taxonomy, per-sector rollups) were
 * simplified here — Sector is kept as a free-text/selectable field but not
 * enforced against a fixed taxonomy. The core appropriation/allotment/
 * augmentation rules (can't reduce Appropriation, ordinance numbers
 * required, Allotment needs an existing Appropriation line) are preserved.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./lib/admin');
const { FieldValue } = require('firebase-admin/firestore');
const { requireRole, requireFundAccess } = require('./lib/roles');
const { logAudit } = require('./lib/audit');
const { allocateRefNo } = require('./lib/refno');
const {
  FUND_NAMES, ROLE_CAN_EDIT_BUDGET, ROLE_CAN_ENCODE_BUDGET
} = require('./lib/constants');

const BUDGET_LINES = 'budgetLines';
const BUDGET_REFERENCE_LOG = 'budgetReferenceLog';
const OBLIGATION_REQUESTS = 'obligationRequests';

function lineKey(fundKey, officeFunctionCode, fppCode, allotmentClass) {
  return [fundKey, officeFunctionCode || '-', fppCode || '-', allotmentClass || '-'].join('__');
}

async function logBudgetReference(entry) {
  await db.collection(BUDGET_REFERENCE_LOG).add({
    ...entry,
    createdAt: FieldValue.serverTimestamp()
  });
}

// payload: { fund, officeFunctionCode, fppCode, fppName, allotmentClass,
//   sector, notes, createIfMissing,
//   annualAppropriation, continuingAppropriation, supplemental, allotment,
//   augmentation, ordinanceNo (covers general/continuing/supplemental —
//   caller sends the one relevant to whichever amount field it's setting),
//   allotmentOrderNo, augmentationOrderNo }
// Only the fields actually present on payload are changed; everything else
// on the existing line is left untouched.
const saveBudgetLine = onCall({ invoker: 'public' }, async (request) => {
  const p = request.data || {};
  const isEncodeOnly = !p.editingExistingAmount; // Budget Staff may only add brand-new lines/appropriation
  const auth = requireRole(request, isEncodeOnly ? ROLE_CAN_ENCODE_BUDGET : ROLE_CAN_EDIT_BUDGET);
  if (!p.fund || !FUND_NAMES[p.fund]) throw new HttpsError('invalid-argument', 'A valid Fund is required.');
  requireFundAccess(auth, p.fund);
  const fundName = FUND_NAMES[p.fund];
  const key = lineKey(p.fund, p.officeFunctionCode, p.fppCode, p.allotmentClass);
  const ref = db.collection(BUDGET_LINES).doc(key);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : null;
    const base = existing || {
      fund: fundName, fundKey: p.fund,
      officeFunctionCode: p.officeFunctionCode || '', fppCode: p.fppCode || '', fppName: p.fppName || '',
      allotmentClass: p.allotmentClass || '', sector: p.sector || '', notes: p.notes || '',
      annualAppropriation: 0, continuingAppropriations: 0, supplemental: 0, allotment: 0, augmentation: 0,
      generalOrdinanceNo: '', continuingOrdinanceNo: '', supplementalOrdinanceNo: '',
      allotmentOrderNo: '', augmentationOrderNo: ''
    };

    const creatingViaContinuing = p.createIfMissing && p.continuingAppropriation !== undefined;
    if (!existing && p.annualAppropriation === undefined && !creatingViaContinuing) {
      throw new HttpsError('failed-precondition', 'No budget line exists yet for this Fund + Office/Function Code + FPP Code + Allotment Class. Encode it under Appropriation first.');
    }
    if (creatingViaContinuing && p.allotmentClass !== 'CO') {
      throw new HttpsError('failed-precondition', 'A brand-new budget line can only be created under Continuing Appropriation when its Allotment Class is CO.');
    }

    const patch = { ...base };

    if (p.annualAppropriation !== undefined) {
      const newVal = Number(p.annualAppropriation) || 0;
      if (existing && newVal < (Number(base.annualAppropriation) || 0)) {
        throw new HttpsError('failed-precondition', `General Appropriation cannot be reduced (was ${base.annualAppropriation}, tried to set ${newVal}).`);
      }
      if (!p.ordinanceNo) throw new HttpsError('invalid-argument', 'General Appropriation requires a Municipal Ordinance No.');
      patch.annualAppropriation = newVal;
      patch.generalOrdinanceNo = p.ordinanceNo;
    }
    if (p.continuingAppropriation !== undefined) {
      const newVal = Number(p.continuingAppropriation) || 0;
      if (existing && newVal < (Number(base.continuingAppropriations) || 0)) {
        throw new HttpsError('failed-precondition', `Continuing Appropriation cannot be reduced (was ${base.continuingAppropriations}, tried to set ${newVal}).`);
      }
      if (!p.ordinanceNo) throw new HttpsError('invalid-argument', 'Continuing Appropriation requires a Municipal Ordinance No.');
      patch.continuingAppropriations = newVal;
      patch.continuingOrdinanceNo = p.ordinanceNo;
    }
    if (p.supplemental !== undefined) {
      if (!p.ordinanceNo) throw new HttpsError('invalid-argument', 'Supplemental Appropriation requires a Municipal Ordinance No.');
      patch.supplemental = (Number(base.supplemental) || 0) + Number(p.supplemental);
      patch.supplementalOrdinanceNo = p.ordinanceNo;
    }
    if (p.allotment !== undefined) {
      if (!existing) throw new HttpsError('failed-precondition', 'You cannot make an Allotment without an existing item in the Appropriation.');
      if (!p.allotmentOrderNo) throw new HttpsError('invalid-argument', 'Allotment requires an Allotment Order No.');
      const totalAppropriation = (Number(base.annualAppropriation) || 0) + (Number(base.continuingAppropriations) || 0) + (Number(base.supplemental) || 0);
      const newAllotment = (Number(base.allotment) || 0) + Number(p.allotment);
      if (newAllotment > totalAppropriation) {
        throw new HttpsError('failed-precondition', `Allotment (${newAllotment}) cannot exceed Total Appropriation (${totalAppropriation}).`);
      }
      patch.allotment = newAllotment;
      patch.allotmentOrderNo = p.allotmentOrderNo;
    }
    if (p.augmentation !== undefined) {
      if (!existing) throw new HttpsError('failed-precondition', 'You cannot Augment a line that does not exist yet.');
      if (!p.augmentationOrderNo) throw new HttpsError('invalid-argument', 'Augmentation requires an Augmentation Order No.');
      patch.augmentation = (Number(base.augmentation) || 0) + Number(p.augmentation);
      patch.augmentationOrderNo = p.augmentationOrderNo;
    }
    if (p.fppName !== undefined) patch.fppName = p.fppName;
    if (p.sector !== undefined) patch.sector = p.sector;
    if (p.notes !== undefined) patch.notes = p.notes;

    patch.updatedAt = new Date().toISOString();
    patch.updatedBy = auth.email;
    tx.set(ref, patch, { merge: true });
  });

  const changedModule = p.annualAppropriation !== undefined ? 'Appropriation - General'
    : p.continuingAppropriation !== undefined ? 'Appropriation - Continuing'
    : p.supplemental !== undefined ? 'Appropriation - Supplemental'
    : p.allotment !== undefined ? 'Allotment'
    : p.augmentation !== undefined ? 'Augmentation' : 'Budget Line';
  const amount = p.annualAppropriation ?? p.continuingAppropriation ?? p.supplemental ?? p.allotment ?? p.augmentation ?? 0;
  await logBudgetReference({
    referenceNo: p.ordinanceNo || p.allotmentOrderNo || p.augmentationOrderNo || '',
    module: changedModule,
    fund: fundName,
    lineKey: key,
    amount: Number(amount) || 0
  });
  await logAudit(auth, 'Save', changedModule, key, 'Amount ' + amount);
  return { ok: true, lineKey: key };
});

// Obligation Request — one row per distribution line, same as the
// original. A repeated OBR No. always APPENDS another line under that OBR
// rather than being rejected, so an Obligation can be split across
// accounts/offices over more than one submission.
async function saveObligationRequestCore(auth, p) {
  if (!p.fund || !FUND_NAMES[p.fund]) throw new HttpsError('invalid-argument', 'A valid Fund is required.');
  requireFundAccess(auth, p.fund);
  const fundName = FUND_NAMES[p.fund];

  // "Encoded FPP should only be limited for a certain calendar year. After
  // lapse of calendar year the FPP should be reencoded." An FPP with no
  // Year set is grandfathered in as still valid.
  if (p.fpp) {
    const fppSnap = await db.collection('createFpp').doc(String(p.fpp)).get();
    if (fppSnap.exists) {
      const fppRow = fppSnap.data();
      const currentYear = String(new Date().getFullYear());
      if (fppRow.year && String(fppRow.year) !== currentYear) {
        throw new HttpsError('failed-precondition', `FPP "${p.fpp}" was encoded for ${fppRow.year} and has lapsed. Re-encode it under Settings > FPP for ${currentYear} before using it.`);
      }
    }
  }

  let obrNo = p.obrNo;
  let isAddedLine = false;
  if (obrNo) {
    const existing = await db.collection(OBLIGATION_REQUESTS).where('obrNo', '==', obrNo).limit(1).get();
    isAddedLine = !existing.empty;
  } else {
    obrNo = await db.runTransaction((tx) => allocateRefNo(tx, 'obr', {}));
  }

  const docRef = db.collection(OBLIGATION_REQUESTS).doc();
  await docRef.set({
    obrNo,
    date: p.date || '',
    office: p.office || '',
    fund: fundName,
    fundKey: p.fund,
    fpp: p.fpp || '',
    particulars: p.particulars || '',
    amount: Number(p.amount) || 0,
    status: p.status || 'Pending',
    payee: p.payee || '',
    officeFunctionCode: p.officeFunctionCode || '',
    accountCode: p.accountCode || '',
    allotmentClass: p.allotmentClass || '',
    sector: p.sector || '',
    jevNo: '',
    createdAt: FieldValue.serverTimestamp(),
    createdBy: auth.email
  });
  await logAudit(auth, isAddedLine ? 'Add Line' : 'Create', 'Obligation Request', obrNo, 'Amount ' + p.amount);
  return { ok: true, obrNo };
}

const saveObligationRequest = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_CAN_ENCODE_BUDGET);
  return saveObligationRequestCore(auth, request.data || {});
});

const saveObligationRequestBatch = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_CAN_ENCODE_BUDGET);
  const rows = (request.data && request.data.rows) || [];
  if (!Array.isArray(rows) || !rows.length) throw new HttpsError('invalid-argument', 'No Obligation Request rows to save.');
  if (rows.length > 100) throw new HttpsError('invalid-argument', `Cannot save more than 100 Obligation Requests in one batch (got ${rows.length}).`);

  // Runs the same per-row logic directly (not via another onCall) so one
  // bad row doesn't throw the whole batch out.
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = await saveObligationRequestCore(auth, rows[i]);
      results.push({ index: i, ok: true, obrNo: r.obrNo });
    } catch (e) {
      results.push({ index: i, ok: false, error: e.message });
    }
  }
  return results;
});

module.exports = { saveBudgetLine, saveObligationRequest, saveObligationRequestBatch };
