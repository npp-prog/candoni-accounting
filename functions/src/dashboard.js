/**
 * Dashboard summary tiles — pending/approved transaction counts and totals,
 * scoped by fund. Kept as a callable (rather than a client-side aggregate
 * query) so it's one round-trip and easy to extend later.
 */
const { onCall } = require('firebase-functions/v2/https');
const { db } = require('./lib/admin');
const { requireAuth, requireFundAccess } = require('./lib/roles');
const { FUND_NAMES } = require('./lib/constants');

const getDashboardSummary = onCall(async (request) => {
  const auth = requireAuth(request);
  const { fund } = request.data || {};
  requireFundAccess(auth, fund);
  const fundName = fund && fund !== 'all' ? FUND_NAMES[fund] : null;

  let q = db.collection('transactions');
  if (fundName) q = q.where('fund', '==', fundName);
  const snap = await q.get();

  let pending = 0, approved = 0, cancelled = 0;
  let pendingAmount = 0, approvedAmount = 0;
  const byType = {};
  snap.forEach((doc) => {
    const t = doc.data();
    if (t.status === 'Pending') { pending++; pendingAmount += Number(t.netAmount) || 0; }
    else if (t.status === 'Approved') { approved++; approvedAmount += Number(t.netAmount) || 0; }
    else if (t.status === 'Cancelled') cancelled++;
    byType[t.type] = (byType[t.type] || 0) + 1;
  });

  let jevQ = db.collection('jev');
  if (fundName) jevQ = jevQ.where('fund', '==', fundName);
  const jevSnap = await jevQ.get();
  let jevCount = 0, jevTotal = 0;
  jevSnap.forEach((doc) => { jevCount++; jevTotal += Number(doc.data().totalDebit) || 0; });

  return {
    pending, approved, cancelled, pendingAmount, approvedAmount, byType,
    jevCount, jevTotal
  };
});

module.exports = { getDashboardSummary };
