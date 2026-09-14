/**
 * Monthly closing lock — a Closed_Periods row for a Fund + Period (YYYY-MM)
 * blocks create/edit on Transactions dated that month for everyone except
 * the Municipal Accountant. Type 'Others' is exempt, same as the original.
 */
const { db } = require('./admin');
const { HttpsError } = require('firebase-functions/v2/https');

function periodDocId(fundName, period) {
  return `${fundName}__${period}`;
}

async function checkPeriodOpen(auth, fundName, dateStr, txType) {
  if (txType === 'Others') return;
  if (auth.role === 'Municipal Accountant') return;
  if (!dateStr) return;
  const period = String(dateStr).slice(0, 7); // YYYY-MM
  const snap = await db.collection('closedPeriods').doc(periodDocId(fundName, period)).get();
  if (snap.exists) {
    throw new HttpsError(
      'failed-precondition',
      `${fundName} — ${period} has been closed for the month. Only the Municipal Accountant can create or edit transactions dated in a closed period.`
    );
  }
}

module.exports = { checkPeriodOpen, periodDocId };
