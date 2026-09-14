/**
 * Reference-number generation — ported from the Apps Script suggestRefNo_/
 * scanMaxSeq_ pair. The original scanned the whole Transactions/JEV sheet
 * for the highest existing number matching a per-kind regex; Firestore has
 * no cheap "regex scan a column" operation, so this uses a small atomic
 * counter document per scope (kind + fund/officer/year/month, whichever the
 * format calls for) instead. The formats themselves — what's zero-padded,
 * what resets/scopes by year vs. year+month, fund codes — are unchanged.
 */
const { db } = require('./admin');
const { FUND_CODE } = require('./constants');

function pad(n, width) {
  return String(n).padStart(width, '0');
}

// Returns { counterId, format(seq) } for a given kind/opts combination.
// format(seq) renders the final human-facing reference number.
function scopeFor(kind, opts) {
  opts = opts || {};
  const d = opts.date ? new Date(opts.date) : new Date();
  const y = d.getFullYear();
  const yy = String(y).slice(-2);
  const mm = pad(d.getMonth() + 1, 2);
  const fundCode = FUND_CODE[opts.fund] || '100';

  switch (kind) {
    case 'dv': // DV No.: YYYY-MM-NNNN — scope year+month, shared across funds
    case 'ada': // ADA No.: same format
      return {
        counterId: `${kind}_${y}-${mm}`,
        format: (seq) => `${y}-${mm}-${pad(seq, 4)}`
      };
    case 'rcd': // Report of Collections and Deposit No.: YY-NNNN — scope year only
      return {
        counterId: `rcd_${y}`,
        format: (seq) => `${yy}-${pad(seq, 4)}`
      };
    case 'lr': // Liquidation Report No.: FFF-YY-MM-NNNN — scope fund+year+month
      return {
        counterId: `lr_${fundCode}_${y}-${mm}`,
        format: (seq) => `${fundCode}-${yy}-${mm}-${pad(seq, 4)}`
      };
    case 'rcdisb': { // Report of Cash Disbursement No. (Payroll): OO-YYYY-MM-NNNN
      const officerCode = opts.officerCode || '00';
      return {
        counterId: `rcdisb_${officerCode}_${y}-${mm}`,
        format: (seq) => `${officerCode}-${y}-${mm}-${pad(seq, 4)}`
      };
    }
    case 'adj': // Adjustment No.: YYYY-MM-NNNN — scope year+month
      return {
        counterId: `adj_${y}-${mm}`,
        format: (seq) => `${y}-${mm}-${pad(seq, 4)}`
      };
    case 'jev': // JEV No.: FFF-YYYY-MM-NNNN — independent per-fund series, scoped by fund+year
      return {
        counterId: `jev_${fundCode}_${y}`,
        format: (seq) => `${fundCode}-${y}-${mm}-${pad(seq, 4)}`
      };
    case 'obr':
      return {
        counterId: `obr_${y}`,
        format: (seq) => `OBR-${y}-${pad(seq, 4)}`
      };
    default:
      throw new Error('Unknown reference number kind: ' + kind);
  }
}

// Read-only peek at what the NEXT number would be, without reserving it —
// used to show a suggested value on the form before Save.
async function peekRefNo(kind, opts) {
  const { counterId, format } = scopeFor(kind, opts);
  const snap = await db.collection('counters').doc(counterId).get();
  const current = snap.exists ? snap.data().seq || 0 : 0;
  return format(current + 1);
}

// Atomically reserves and returns the next number for this scope. Must be
// called from inside the same Firestore transaction that writes the
// document the number is being assigned to, so a crash between the two
// never burns a number silently... in practice callers pass `tx` (a
// Firestore Transaction) so the counter increment and the record write
// commit together.
async function allocateRefNo(tx, kind, opts) {
  const { counterId, format } = scopeFor(kind, opts);
  const ref = db.collection('counters').doc(counterId);
  const snap = await tx.get(ref);
  const next = (snap.exists ? snap.data().seq || 0 : 0) + 1;
  tx.set(ref, { seq: next, kind, updatedAt: new Date().toISOString() }, { merge: true });
  return format(next);
}

module.exports = { peekRefNo, allocateRefNo };
