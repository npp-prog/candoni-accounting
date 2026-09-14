/**
 * Monthly closing — Settings > Closing. Ported from closeMonth/reopenMonth.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./lib/admin');
const { requireRole } = require('./lib/roles');
const { logAudit } = require('./lib/audit');
const { periodDocId } = require('./lib/closedPeriods');
const { FUND_NAMES, ROLE_ACCOUNTANT_ONLY } = require('./lib/constants');

const closeMonth = onCall(async (request) => {
  const auth = requireRole(request, ROLE_ACCOUNTANT_ONLY);
  const { fund, period } = request.data || {};
  const fundName = FUND_NAMES[fund] || fund;
  if (!period || !/^\d{4}-\d{2}$/.test(period)) throw new HttpsError('invalid-argument', 'period must be YYYY-MM.');
  const ref = db.collection('closedPeriods').doc(periodDocId(fundName, period));
  const snap = await ref.get();
  if (snap.exists) throw new HttpsError('already-exists', `${fundName} — ${period} is already closed.`);
  await ref.set({
    fund: fundName, fundKey: fund, period,
    closedBy: auth.name || auth.email, closedAt: new Date().toISOString()
  });
  await logAudit(auth, 'Close Month', 'Closing', period, fundName);
  return { ok: true };
});

const reopenMonth = onCall(async (request) => {
  const auth = requireRole(request, ROLE_ACCOUNTANT_ONLY);
  const { fund, period } = request.data || {};
  const fundName = FUND_NAMES[fund] || fund;
  const ref = db.collection('closedPeriods').doc(periodDocId(fundName, period));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That period is not closed.');
  await ref.delete();
  await logAudit(auth, 'Reopen Month', 'Closing', period, fundName);
  return { ok: true };
});

module.exports = { closeMonth, reopenMonth };
