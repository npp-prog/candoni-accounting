/**
 * Journal Entry Voucher module — ported from getNextJevNo/saveJEV in
 * Code.gs. A JEV's lines are stored both embedded on the JEV document
 * itself (for display) and denormalized one-row-per-line into `jevLines`
 * (for account-code / bank-account / subsidiary-ledger style report
 * queries, the same shape the flat Journal_Entry_Voucher sheet gave the
 * original reports).
 *
 * The Property & Inventory redirect prompts the original saveJEV returned
 * (PPE/Semi-Expendable/Consumable "Property Link" accounts offering to
 * jump to Add Item) are dropped along with the rest of the Property module.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./lib/admin');
const { FieldValue } = require('firebase-admin/firestore');
const { requireRole, requireFundAccess } = require('./lib/roles');
const { logAudit } = require('./lib/audit');
const { checkPeriodOpen } = require('./lib/closedPeriods');
const { allocateRefNo, peekRefNo } = require('./lib/refno');
const { FUND_NAMES, ROLE_CAN_CREATE_TX } = require('./lib/constants');

const JEV = 'jev';
const JEV_LINES = 'jevLines';
const TRANSACTIONS = 'transactions';
const OBLIGATION_REQUESTS = 'obligationRequests';

const getNextJevNo = onCall({ invoker: 'public' }, async (request) => {
  requireRole(request, ROLE_CAN_CREATE_TX);
  const { fund } = request.data || {};
  return { jevNo: await peekRefNo('jev', { fund }) };
});

const saveJEV = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_CAN_CREATE_TX);
  const { header, lines } = request.data || {};
  if (!header || !header.fund || !FUND_NAMES[header.fund]) {
    throw new HttpsError('invalid-argument', 'A valid Fund is required.');
  }
  requireFundAccess(auth, header.fund);
  if (!Array.isArray(lines) || !lines.length) {
    throw new HttpsError('invalid-argument', 'A JEV needs at least one line.');
  }
  let totalDr = 0, totalCr = 0;
  lines.forEach((l) => { totalDr += Number(l.debit) || 0; totalCr += Number(l.credit) || 0; });
  if (Math.abs(totalDr - totalCr) > 0.01) {
    throw new HttpsError('failed-precondition', `JEV is not balanced. Total Debit ${totalDr.toFixed(2)} vs Total Credit ${totalCr.toFixed(2)}`);
  }

  const fundName = FUND_NAMES[header.fund];
  let sourceTxSnap = null;
  if (header.sourceRef) {
    const q = await db.collection(TRANSACTIONS).where('primaryRefNo', '==', header.sourceRef).limit(1).get();
    if (!q.empty) {
      sourceTxSnap = q.docs[0];
      const tx = sourceTxSnap.data();
      if (tx.status !== 'Approved') {
        throw new HttpsError('failed-precondition', `This transaction is "${tx.status}" — only Approved transactions can be posted to a Journal Entry Voucher.`);
      }
      await checkPeriodOpen(auth, tx.fund, tx.date, tx.type);
    }
  }

  if (header.jevNo) {
    const dup = await db.collection(JEV).where('jevNo', '==', header.jevNo).limit(1).get();
    if (!dup.empty) throw new HttpsError('already-exists', `JEV No. ${header.jevNo} already exists — pick a different number.`);
  }

  const batch = db.batch();
  const jevDocRef = db.collection(JEV).doc();

  const jevNo = await db.runTransaction(async (tx) => {
    return header.jevNo || allocateRefNo(tx, 'jev', { date: header.date, fund: header.fund });
  });

  const cleanLines = lines.map((l) => ({
    accountCode: l.accountCode || '',
    accountName: l.accountName || '',
    debit: Number(l.debit) || 0,
    credit: Number(l.credit) || 0,
    subsidiary: l.subsidiary || '',
    fpp: l.fpp || '',
    bankAccount: l.bankAccount || '',
    dueDate: l.dueDate || '',
    listedItems: l.listedItems || ''
  }));

  batch.set(jevDocRef, {
    jevNo,
    date: header.date,
    fund: fundName,
    fundKey: header.fund,
    sourceType: header.sourceType || '',
    sourceRef: header.sourceRef || '',
    lines: cleanLines,
    totalDebit: totalDr,
    totalCredit: totalCr,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: auth.email
  });

  cleanLines.forEach((l) => {
    const lineRef = db.collection(JEV_LINES).doc();
    batch.set(lineRef, {
      jevId: jevDocRef.id,
      jevNo,
      date: header.date,
      fund: fundName,
      fundKey: header.fund,
      sourceType: header.sourceType || '',
      sourceRef: header.sourceRef || '',
      ...l,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  if (sourceTxSnap) {
    batch.update(sourceTxSnap.ref, { jevNo });
  }

  await batch.commit();

  if (header.sourceRef) {
    const obrQ = await db.collection(OBLIGATION_REQUESTS).where('obrNo', '==', header.sourceRef).get();
    if (!obrQ.empty) {
      const obrBatch = db.batch();
      obrQ.docs.forEach((d) => obrBatch.update(d.ref, { jevNo }));
      await obrBatch.commit();
    }
  }

  await logAudit(auth, 'Post JEV', header.sourceType || 'Manual', jevNo, 'Dr/Cr ' + totalDr.toFixed(2));
  return { ok: true, jevNo, docId: jevDocRef.id };
});

module.exports = { getNextJevNo, saveJEV };
