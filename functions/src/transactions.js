/**
 * Transactions module — Disbursement Voucher, Check, ADA, Collections and
 * Deposit, Liquidation, Payroll, RSMI, Depreciation, Others. Ported from
 * saveTransaction/updateTransaction/updateTransactionStatus in Code.gs.
 *
 * Reads are direct Firestore queries from the client (Security Rules scope
 * them to authenticated users); writes go through these callables so the
 * role checks, monthly-closing lock, and reference-number generation stay
 * server-enforced exactly as they were in Apps Script.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./lib/admin');
const { FieldValue } = require('firebase-admin/firestore');
const { requireRole, requireFundAccess } = require('./lib/roles');
const { logAudit } = require('./lib/audit');
const { checkPeriodOpen } = require('./lib/closedPeriods');
const { allocateRefNo, peekRefNo } = require('./lib/refno');
const {
  FUND_NAMES, TX_TYPE_LABEL, TX_REF_KIND, DV_CATEGORIES, TX_STATUSES,
  ROLE_CAN_CREATE_TX, ROLE_CAN_EDIT_TX
} = require('./lib/constants');

const TRANSACTIONS = 'transactions';

function validateTxPayload(payload, typeKey) {
  if (!payload || !payload.date) throw new HttpsError('invalid-argument', 'Date is required.');
  if (!payload.fund) throw new HttpsError('invalid-argument', 'Fund is required.');
  if (!FUND_NAMES[payload.fund]) throw new HttpsError('invalid-argument', 'Unknown fund: ' + payload.fund);
  if (!payload.particulars) throw new HttpsError('invalid-argument', 'Particulars is required.');
  if (typeKey === 'disbursement_voucher' && !payload.subType) {
    throw new HttpsError('invalid-argument', 'DV Type (Procurement/Non-Procurement) is required.');
  }
  if ((typeKey === 'check' || typeKey === 'rsmi') && !payload.primaryRefNo) {
    throw new HttpsError('invalid-argument', TX_TYPE_LABEL[typeKey] + ' requires a manually-encoded reference number.');
  }
}

// "Once used as a non-cancelled Check/ADA's Secondary Ref No., a DV No.
// can't be reused by another Check/ADA in the same Fund." excludeDocId lets
// an edit of the same record pass without tripping on itself.
async function assertDvSecondaryRefAvailable(typeKey, fundName, secondaryRefNo, excludeDocId) {
  if ((typeKey !== 'check' && typeKey !== 'ada') || !secondaryRefNo) return;
  const snap = await db.collection(TRANSACTIONS)
    .where('fund', '==', fundName)
    .where('secondaryRefNo', '==', secondaryRefNo)
    .where('status', '!=', 'Cancelled')
    .get();
  const clash = snap.docs.find((d) => d.id !== excludeDocId && (d.data().type === 'Check' || d.data().type === 'ADA'));
  if (clash) {
    throw new HttpsError('failed-precondition', `DV No. ${secondaryRefNo} is already used by another Check/ADA in ${fundName}.`);
  }
}

const getSuggestedRefNo = onCall({ invoker: 'public' }, async (request) => {
  requireRole(request, ROLE_CAN_CREATE_TX.concat(['Budget Officer', 'Budget Staff', 'Viewer']));
  const { kind, opts } = request.data || {};
  return { refNo: await peekRefNo(kind, opts || {}) };
});

const saveTransaction = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_CAN_CREATE_TX);
  const { typeKey, payload } = request.data || {};
  const type = TX_TYPE_LABEL[typeKey];
  if (!type) throw new HttpsError('invalid-argument', 'Unknown transaction type: ' + typeKey);
  validateTxPayload(payload, typeKey);
  requireFundAccess(auth, payload.fund);
  const fundName = FUND_NAMES[payload.fund];
  await checkPeriodOpen(auth, fundName, payload.date, type);
  await assertDvSecondaryRefAvailable(typeKey, fundName, payload.secondaryRefNo, null);

  const gross = Number(payload.grossAmount) || 0;
  const wtax = Number(payload.wtax) || 0;
  const other = Number(payload.otherDeductions) || 0;

  const result = await db.runTransaction(async (tx) => {
    let primaryRef = payload.primaryRefNo;
    if (!primaryRef) {
      const kind = TX_REF_KIND[typeKey];
      if (!kind) throw new HttpsError('invalid-argument', 'Primary Ref No. is required and must be encoded manually for ' + type + '.');
      primaryRef = await allocateRefNo(tx, kind, { date: payload.date, fund: payload.fund, officerCode: payload.officerCode });
    }
    const docRef = db.collection(TRANSACTIONS).doc();
    tx.set(docRef, {
      type,
      subType: payload.subType || '',
      dvCategory: typeKey === 'disbursement_voucher' ? (payload.dvCategory || '') : '',
      date: payload.date,
      primaryRefNo: primaryRef,
      secondaryRefNo: payload.secondaryRefNo || '',
      tertiaryRefNo: payload.tertiaryRefNo || '',
      name: payload.name || '',
      particulars: payload.particulars || '',
      fund: fundName,
      fundKey: payload.fund,
      office: payload.office || '',
      emailAddress: payload.emailAddress || '',
      collector: payload.collector || '',
      attachmentUrl: payload.attachmentUrl || '',
      attachmentName: payload.attachmentName || '',
      grossAmount: gross,
      wtax,
      otherDeductions: other,
      netAmount: gross - wtax - other,
      status: 'Pending',
      jevNo: '',
      createdAt: FieldValue.serverTimestamp(),
      createdBy: auth.email
    });
    return { docId: docRef.id, primaryRef };
  });

  await logAudit(auth, 'Create', type, result.primaryRef, 'Gross ' + gross);
  return { ok: true, docId: result.docId, refNo: result.primaryRef };
});

const updateTransaction = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_CAN_EDIT_TX);
  const { docId, payload } = request.data || {};
  if (!docId) throw new HttpsError('invalid-argument', 'docId is required.');
  const ref = db.collection(TRANSACTIONS).doc(docId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Transaction not found.');
  const match = snap.data();
  const typeKey = Object.keys(TX_TYPE_LABEL).find((k) => TX_TYPE_LABEL[k] === match.type) || null;
  validateTxPayload(payload, typeKey);
  requireFundAccess(auth, payload.fund);
  const fundName = FUND_NAMES[payload.fund] || match.fund;
  await checkPeriodOpen(auth, match.fund, match.date, match.type);
  await checkPeriodOpen(auth, fundName, payload.date, match.type);
  await assertDvSecondaryRefAvailable(typeKey, fundName, payload.secondaryRefNo, docId);

  const gross = Number(payload.grossAmount) || 0;
  const wtax = Number(payload.wtax) || 0;
  const other = Number(payload.otherDeductions) || 0;

  await ref.update({
    date: payload.date,
    secondaryRefNo: payload.secondaryRefNo || '',
    tertiaryRefNo: payload.tertiaryRefNo || '',
    subType: payload.subType !== undefined ? payload.subType : (match.subType || ''),
    dvCategory: payload.dvCategory !== undefined ? payload.dvCategory : (match.dvCategory || ''),
    name: payload.name || '',
    particulars: payload.particulars || '',
    fund: fundName,
    fundKey: payload.fund,
    office: payload.office || '',
    emailAddress: payload.emailAddress || '',
    attachmentUrl: payload.attachmentUrl !== undefined ? payload.attachmentUrl : (match.attachmentUrl || ''),
    attachmentName: payload.attachmentName !== undefined ? payload.attachmentName : (match.attachmentName || ''),
    grossAmount: gross,
    wtax,
    otherDeductions: other,
    netAmount: gross - wtax - other,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: auth.email
  });
  await logAudit(auth, 'Edit', match.type, match.primaryRefNo, 'Edited by ' + auth.name);
  return { ok: true };
});

const updateTransactionStatus = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_CAN_EDIT_TX);
  const { docId, status } = request.data || {};
  if (!TX_STATUSES.includes(status)) throw new HttpsError('invalid-argument', 'Unknown status: ' + status);
  const ref = db.collection(TRANSACTIONS).doc(docId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Transaction not found.');
  const match = snap.data();
  await checkPeriodOpen(auth, match.fund, match.date, match.type);
  await ref.update({ status, statusUpdatedAt: FieldValue.serverTimestamp(), statusUpdatedBy: auth.email });
  await logAudit(auth, 'Status change', match.type, match.primaryRefNo, 'New status: ' + status);
  return { ok: true };
});

module.exports = {
  getSuggestedRefNo,
  saveTransaction,
  updateTransaction,
  updateTransactionStatus,
  DV_CATEGORIES_EXPORT: DV_CATEGORIES
};
