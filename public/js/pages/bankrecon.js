/**
 * Bank Reconciliation — ported to match, category-for-category and
 * tier-for-tier, the standalone "BRS Workbench" reference tool
 * (github.com/npp-prog/brs-workbench, live at npp-prog.github.io/brs-workbench)
 * that this module is meant to replicate. The matching engine, the six
 * reconciling-item categories, the editable/removable line items, the
 * unified manual-matching workspace, and the 3-sheet export layout below
 * are a direct port of that tool's logic — adapted here to read the book
 * side straight from this app's own Firestore transactions instead of a
 * second upload, since that's real ledger data this app already has.
 *
 * Six reconciling-item categories (CATS), each tagged with which side of
 * the reconciliation it adjusts:
 *   checks         — Checks/ADA Issued not taken up by Bank        (adjusts bank, −)
 *   deposits       — Deposits not taken up by Bank                 (adjusts bank, +)
 *   chkoverunder   — Checks/ADA Issued — Overstated/Understated    (adjusts book)
 *   deposoverunder — Deposits — Overstated/Understated             (adjusts book)
 *   memos          — Bank Debit/Credit Memos not taken up by LGU   (adjusts book)
 *   other          — Other Reconciling Items                       (adjusts book, manual only)
 *
 * Matching runs in tiers, each touching only what the previous tier left
 * unmatched:
 *   0. prior-period carryover items — clear against this month's bank
 *      statement if they finally cleared, else carry forward as-is
 *   1. exact reference-number match (same amount = clean match; different
 *      amount = an overstated/understated item)
 *   2. remaining book rows grouped by shared reference (an ADA batch, a
 *      deposit slip) — group TOTAL matched to one bank row
 *   3. whatever's left matched by amount against a SUBSET of nearby
 *      unmatched bank rows (handles split deposits/memos with no shared ref)
 * Anything still unmatched after that is a genuine reconciling item, shown
 * with a checkbox (include/exclude), an editable amount, a remarks field,
 * and a delete button — plus a manual-matching workspace below for tying
 * together anything the automatic tiers couldn't (a typo'd reference no.,
 * a slightly different amount).
 *
 * Runs entirely client-side (SheetJS, loaded via CDN in index.html, does
 * the spreadsheet parsing/export) — no Cloud Function involved.
 */
import { db, collection, query, where, getDocs } from '../firebase-init.js';
import { currentFund, onFundChange } from '../state.js';
import { FUND_NAMES, FUND_LIST, fmtMoney, escapeHtml } from '../constants.js';
import { registerPage } from '../nav.js';
import { toast, errorMessage } from '../ui.js';

// ---------------------------------------------------------------- helpers

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function uid() { return Math.random().toString(36).slice(2, 10); }

function toNumber(v) {
  if (v == null || v === '') return 0;
  let s = String(v).trim();
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[,₱$\s]/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return neg ? -n : n;
}

function normRef(s) {
  return (s == null) ? '' : String(s).trim().replace(/^0+(?=\d)/, '').toUpperCase();
}

// True only when BOTH sides carry a reference number and those numbers
// disagree. A coincidental amount match never overrides this — two
// different checks for the same peso amount aren't the same transaction —
// but a lump/batch match (one side has no reference at all) can still go
// through on amount alone.
function refsConflict(a, b) {
  const na = normRef(a), nb = normRef(b);
  return !!na && !!nb && na !== nb;
}

function dateVal(d) { const t = Date.parse(d); return isNaN(t) ? null : t; }
function daysBetween(a, b) {
  const da = dateVal(a), db_ = dateVal(b);
  if (da == null || db_ == null) return 9e15;
  return Math.abs(da - db_) / 86400000;
}
function fmtDate(d) {
  if (!d) return '';
  const t = Date.parse(d);
  if (isNaN(t)) return String(d);
  const dt = new Date(t);
  return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
}
function joinDates(dates) {
  const seen = {}; const out = [];
  dates.forEach((d) => { const s = fmtDate(d); if (s && !seen[s]) { seen[s] = true; out.push(s); } });
  return out.join('; ');
}
function oneOrJoinDates(dates) {
  const seen = {}; const uniq = [];
  dates.forEach((d) => { const s = fmtDate(d); if (s && !seen[s]) { seen[s] = true; uniq.push(d); } });
  return uniq.length === 1 ? uniq[0] : joinDates(dates);
}
function joinRefs(refs) {
  const seen = {}; const out = [];
  refs.forEach((r) => { const s = (r == null ? '' : String(r)).trim(); if (s && !seen[s]) { seen[s] = true; out.push(s); } });
  return out.join('; ');
}

function monthRange(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${monthStr}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${monthStr}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

// ------------------------------------------------------------ categories

const CATS = [
  { key: 'checks', label: 'Checks/ADA Issued not taken up by Bank', side: 'bank' },
  { key: 'deposits', label: 'Deposits not taken up by Bank', side: 'bank' },
  { key: 'chkoverunder', label: 'Checks/ADA Issued — Overstated / Understated by Books', side: 'book' },
  { key: 'deposoverunder', label: 'Deposits — Overstated / Understated by Books', side: 'book' },
  { key: 'memos', label: 'Bank Debit/Credit Memos not taken up by the LGU', side: 'book' },
  { key: 'other', label: 'Other Reconciling Items', side: 'book' }
];
const PRIOR_CAT_SHORT = {
  checks: 'Outstanding check/ADA', deposits: 'Deposit in transit',
  chkoverunder: 'Check over/understated', deposoverunder: 'Deposit over/understated',
  memos: 'Bank memo', other: 'Other item'
};

// ------------------------------------------------------- bank file parsing

function findHeaderRow(rows, keywords, maxScan) {
  maxScan = Math.min(maxScan || 15, rows.length);
  let best = -1, bestScore = 0;
  for (let r = 0; r < maxScan; r++) {
    const row = rows[r] || [];
    let score = 0;
    row.forEach((c) => {
      if (typeof c === 'string') {
        const cl = c.toLowerCase();
        keywords.forEach((k) => { if (cl.indexOf(k) > -1) score++; });
      }
    });
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= 2 ? best : -1;
}
function colIndexByKeyword(headerRow, keywords) {
  for (let i = 0; i < headerRow.length; i++) {
    const c = headerRow[i];
    if (typeof c === 'string') {
      const cl = c.toLowerCase();
      for (const k of keywords) { if (cl.indexOf(k) > -1) return i; }
    }
  }
  return -1;
}

function readWorkbookFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        resolve(wb);
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsArrayBuffer(file);
  });
}
function sheetToRows(ws) { return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }); }

function excelDateToJS(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); if (d) return new Date(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0); }
  if (typeof v === 'string') { const t = Date.parse(v); if (!isNaN(t)) return new Date(t); }
  return null;
}
function toISO(d) {
  const dt = (d instanceof Date) ? d : excelDateToJS(d);
  if (!dt || isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

async function parseBankFile(file) {
  const wb = await readWorkbookFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = sheetToRows(ws);
  const hIdx = findHeaderRow(rows, ['date', 'description', 'debit', 'credit', 'balance', 'cheque', 'check']);
  if (hIdx === -1) throw new Error('Could not find bank-statement columns (Date/Debit/Credit) in that file.');
  const header = rows[hIdx];
  const cDate = colIndexByKeyword(header, ['date']);
  const cDesc = colIndexByKeyword(header, ['description', 'particulars']);
  const cDebit = colIndexByKeyword(header, ['debit']);
  const cCredit = colIndexByKeyword(header, ['credit']);
  const cBal = colIndexByKeyword(header, ['balance']);
  const cRef = colIndexByKeyword(header, ['cheque', 'check no', 'check number', 'reference']);
  const out = [];
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const dRaw = cDate > -1 ? row[cDate] : null;
    const desc = cDesc > -1 ? row[cDesc] : '';
    const debit = cDebit > -1 ? (parseFloat(row[cDebit]) || 0) : 0;
    const credit = cCredit > -1 ? (parseFloat(row[cCredit]) || 0) : 0;
    const bal = cBal > -1 ? parseFloat(row[cBal]) : NaN;
    const ref = cRef > -1 ? row[cRef] : '';
    if (dRaw == null && !desc && !debit && !credit) continue;
    if (typeof desc === 'string' && /^account number|^currency|^account type/i.test(desc.trim())) continue;
    out.push({ date: toISO(dRaw), desc: desc || '', debit, credit, balance: isNaN(bal) ? null : bal, ref: ref == null ? '' : String(ref), matched: false });
  }
  if (!out.length) throw new Error('No bank transactions found in that file.');
  return out;
}

// Statement export order varies — find the row with the latest valid date
// to read the period-end running balance from, rather than assuming row 0.
function latestBalanceRow(rows) {
  let best = null;
  rows.forEach((r) => {
    if (r.balance == null || !r.date) return;
    if (!best || r.date > best.date) best = r;
  });
  return best || rows[0];
}

// -------------------------------------------------------- book-side fetch

async function fetchByType(typeLabel, fundName, start, end) {
  const base = collection(db, 'transactions');
  try {
    const snap = await getDocs(query(base,
      where('type', '==', typeLabel), where('fund', '==', fundName),
      where('date', '>=', start), where('date', '<=', end)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    const snap = await getDocs(query(base, where('type', '==', typeLabel), where('fund', '==', fundName)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((r) => r.date >= start && r.date <= end);
  }
}

async function fetchBookEntries(fundKey, start, end) {
  const fundName = FUND_NAMES[fundKey];
  const [checks, adas, deposits] = await Promise.all([
    fetchByType('Check', fundName, start, end),
    fetchByType('ADA', fundName, start, end),
    fetchByType('Collections and Deposit', fundName, start, end)
  ]);
  const entries = [];
  checks.filter((r) => r.status !== 'Cancelled').forEach((r) => entries.push({
    date: r.date, type: 'check', ref: r.primaryRefNo || '', name: r.name || '', amount: Number(r.netAmount) || 0, matched: false
  }));
  adas.filter((r) => r.status !== 'Cancelled').forEach((r) => entries.push({
    date: r.date, type: 'check', ref: r.secondaryRefNo || r.primaryRefNo || '', name: r.name || '', amount: Number(r.netAmount) || 0, matched: false
  }));
  deposits.filter((r) => r.status !== 'Cancelled').forEach((r) => entries.push({
    date: r.date, type: 'deposit', ref: r.primaryRefNo || '', name: r.name || '', amount: Number(r.netAmount) || 0, matched: false
  }));
  return entries;
}

// ----------------------------------------------------- carryover (Step 2)

function readCarryoverRows() {
  const rows = [];
  document.querySelectorAll('#brCarryBody tr').forEach((tr) => {
    const date = tr.querySelector('.cf-date').value;
    const cat = tr.querySelector('.cf-cat').value;
    const refInput = tr.querySelector('.cf-ref').value;
    const name = tr.querySelector('.cf-name').value;
    let amount = toNumber(tr.querySelector('.cf-amount').value);
    if (!date || !amount) return; // skip empty/incomplete rows silently
    // checks/deposits are always carried as a magnitude — runReconciliation
    // applies its own sign when it turns an unmatched one into a reconciling
    // item; only chkoverunder/deposoverunder/memos/other carry a signed value.
    if (cat === 'checks' || cat === 'deposits') amount = Math.abs(amount);
    rows.push({ id: uid(), cat, date, ref: refInput, name, amount });
  });
  return rows;
}

function addCarryoverRow(tbody) {
  const tr = document.createElement('tr');
  const opts = CATS.map((c) => `<option value="${c.key}">${PRIOR_CAT_SHORT[c.key]}</option>`).join('');
  tr.innerHTML = `
    <td><input type="date" class="cf-date"></td>
    <td><select class="cf-cat">${opts}</select></td>
    <td><input class="cf-ref" placeholder="Ref No."></td>
    <td><input class="cf-name" placeholder="Payee / description"></td>
    <td><input type="number" step="0.01" class="cf-amount" placeholder="0.00"></td>
    <td><button type="button" class="btn-ghost cf-remove" title="Remove row">✕</button></td>
  `;
  tr.querySelector('.cf-remove').addEventListener('click', () => tr.remove());
  tbody.appendChild(tr);
}

// ------------------------------------------------------------- matching

function subsetSumMatch(targetCents, cents, cap) {
  cap = Math.min(cap || 18, cents.length);
  const sums = new Map(); sums.set(0, []);
  for (let i = 0; i < cap; i++) {
    const c = cents[i];
    const snapshot = Array.from(sums.entries());
    for (const [s, path] of snapshot) {
      const ns = s + c;
      if (ns === targetCents) return path.concat([i]);
      if (!sums.has(ns) && sums.size < 8000) sums.set(ns, path.concat([i]));
    }
  }
  return null;
}

function bankSideAmt(k, isDisb) { return isDisb ? k.debit : k.credit; }

function runReconciliation(bookRowsIn, bankRowsIn, priorOutstanding) {
  const bank = bankRowsIn.map((r) => ({ ...r, _used: false }));
  const book = bookRowsIn.map((r) => ({ ...r, _used: false }));

  const items = [];
  let matchedBook = 0, matchedBank = 0;
  const matchedPairs = [];
  function pushMatch(bookDate, bankDate, bookRef, bankRef, amtBook, amtBank, note) {
    matchedPairs.push({ bookDate, bankDate, bookRef: bookRef || '', bankRef: bankRef || '', amtBook: round2(amtBook), amtBank: round2(amtBank), proof: round2(amtBook - amtBank), note: note || '' });
  }

  // TIER 0: prior-period carryover items. Check whether the bank statement
  // shows them finally clearing this month; if so they're resolved and
  // dropped. Still-unmatched checks/deposits carry forward automatically;
  // over/understated, memo, and "other" carryover items have no bank-side
  // transaction to clear against, so they simply carry forward as-is.
  let priorCleared = 0, priorCarried = 0;
  (priorOutstanding || []).forEach((p) => {
    if (p.cat === 'checks' || p.cat === 'deposits') {
      const isDisb = p.cat !== 'deposits';
      const rn = p.ref ? normRef(p.ref) : '';
      let cand = rn ? bank.find((k) => !k._used && normRef(k.ref) === rn && Math.abs(bankSideAmt(k, isDisb) - p.amount) < 0.01) : null;
      if (!cand) {
        const pool = bank.filter((k) => !k._used && Math.abs(bankSideAmt(k, isDisb) - p.amount) < 0.01 && !refsConflict(p.ref, k.ref));
        if (pool.length) {
          pool.sort((x, y) => daysBetween(x.date, p.date) - daysBetween(y.date, p.date));
          cand = pool[0];
        }
      }
      if (cand) {
        cand._used = true; matchedBank++; priorCleared++;
        pushMatch(p.date, cand.date, p.ref, cand.ref, p.amount, bankSideAmt(cand, isDisb));
      } else {
        items.push({ id: uid(), cat: p.cat, date: p.date, ref: p.ref, name: p.name,
          amount: isDisb ? -p.amount : p.amount, side: 'bank', include: true,
          remarks: 'Carried forward — outstanding since ' + fmtDate(p.date) });
        priorCarried++;
      }
    } else {
      items.push({ id: uid(), cat: p.cat, date: p.date, ref: p.ref, name: p.name,
        amount: p.amount, side: 'book', include: true,
        remarks: 'Carried forward — outstanding since ' + fmtDate(p.date) });
      priorCarried++;
    }
  });

  // TIER 1 + 1b: exact reference-number match.
  book.forEach((b) => {
    if (b._used || !b.ref) return;
    const isDisb = b.type !== 'deposit';
    const rn = normRef(b.ref);
    const cands = bank.filter((k) => !k._used && normRef(k.ref) === rn && bankSideAmt(k, isDisb) > 0);
    if (!cands.length) return;
    const exact = cands.find((k) => Math.abs(bankSideAmt(k, isDisb) - b.amount) < 0.01);
    const k = exact || cands[0];
    const bAmt = bankSideAmt(k, isDisb);
    b._used = true; k._used = true; matchedBook++; matchedBank++;
    if (!exact) {
      const diff = round2(bAmt - b.amount);
      const adj = isDisb ? round2(b.amount - bAmt) : round2(bAmt - b.amount);
      const word = diff > 0 ? 'Understated' : 'Overstated';
      items.push({ id: uid(), cat: isDisb ? 'chkoverunder' : 'deposoverunder',
        date: b.date, ref: b.ref, name: (b.name || k.desc || '') + ' — ' + word + ' by books',
        amount: adj, side: 'book', include: true, remarks: 'Book ' + fmtMoney(b.amount) + ' vs bank ' + fmtMoney(bAmt) });
    }
    pushMatch(b.date, k.date, b.ref, k.ref, b.amount, bAmt);
  });

  // TIER 2 + 3: group remaining book rows by shared reference (ADA batch,
  // deposit slip); a bare row with no reference is its own single-row unit.
  const groups = {}; const singles = [];
  book.forEach((b) => {
    if (b._used) return;
    if (b.ref) { const key = b.type + '|' + normRef(b.ref); (groups[key] = groups[key] || []).push(b); }
    else singles.push([b]);
  });
  const units = Object.keys(groups).map((k) => groups[k]).concat(singles);
  units.forEach((u) => {
    u._total = round2(u.reduce((s, x) => s + x.amount, 0));
    u._isDisb = u[0].type !== 'deposit';
    u._date = u[u.length - 1].date;
  });
  units.sort((a, b) => b._total - a._total);

  units.forEach((u) => {
    const isDisb = u._isDisb, total = u._total;

    // TIER 2: group/row total == a single unmatched bank row.
    const cand = bank.find((k) => !k._used && bankSideAmt(k, isDisb) > 0 && Math.abs(bankSideAmt(k, isDisb) - total) < 0.01 && !refsConflict(u[0].ref, k.ref));
    if (cand) {
      u.forEach((x) => { x._used = true; matchedBook++; });
      cand._used = true; matchedBank++;
      pushMatch(u._date, cand.date, u[0].ref, cand.ref, total, bankSideAmt(cand, isDisb));
      return;
    }

    // TIER 3: group/row total == sum of a subset of nearby unmatched bank rows.
    const pool = bank.filter((k) => !k._used && bankSideAmt(k, isDisb) > 0 && !refsConflict(u[0].ref, k.ref));
    pool.sort((x, y) => daysBetween(x.date, u._date) - daysBetween(y.date, u._date));
    const capN = Math.min(18, pool.length);
    const cents = pool.slice(0, capN).map((k) => Math.round(bankSideAmt(k, isDisb) * 100));
    const res = subsetSumMatch(Math.round(total * 100), cents, capN);
    if (res) {
      u.forEach((x) => { x._used = true; matchedBook++; });
      const hitRows = res.map((idx) => { pool[idx]._used = true; matchedBank++; return pool[idx]; });
      const bankTotal = round2(hitRows.reduce((s, k) => s + bankSideAmt(k, isDisb), 0));
      pushMatch(u._date, oneOrJoinDates(hitRows.map((k) => k.date)), u[0].ref, joinRefs(hitRows.map((k) => k.ref)), total, bankTotal);
    }
  });

  // Leftover book -> checks/deposits not taken up by bank.
  book.filter((b) => !b._used).forEach((b) => {
    const isDep = b.type === 'deposit';
    items.push({ id: uid(), cat: isDep ? 'deposits' : 'checks', date: b.date, ref: b.ref, name: b.name,
      amount: isDep ? b.amount : -b.amount, side: 'bank', include: true, remarks: '' });
  });

  // Leftover bank -> debit/credit memos not taken up by the LGU.
  bank.filter((k) => !k._used && (k.debit > 0 || k.credit > 0)).forEach((k) => {
    const isDebit = k.debit > 0;
    items.push({ id: uid(), cat: 'memos', date: k.date, ref: k.ref, name: k.desc,
      amount: isDebit ? -k.debit : k.credit, side: 'book', include: true, remarks: isDebit ? 'Debit memo' : 'Credit memo' });
  });

  return { items, matchedBook, matchedBank, matchedPairs, priorCleared, priorCarried };
}

// -------------------------------------------------------------- rendering

function catSum(items, key) {
  return items.filter((it) => it.cat === key && it.include).reduce((s, it) => s + it.amount, 0);
}
function sideSum(items, side) {
  return items.filter((it) => it.side === side && it.include).reduce((s, it) => s + it.amount, 0);
}

function renderResults(container, RS) {
  const { items, meta } = RS;

  let html = `
    <div class="br-card">
      <h3>Status</h3>
      <div class="br-summary-grid">
        <div class="br-summary-item"><div class="lbl">Unadjusted Book</div><div class="val">${fmtMoney(meta.unadjBook)}</div></div>
        <div class="br-summary-item"><div class="lbl">Unadjusted Bank</div><div class="val">${fmtMoney(meta.unadjBank)}</div></div>
        <div class="br-summary-item"><div class="lbl">Matched Transactions</div><div class="val">${RS.matchedBook}${RS.matchedBank !== RS.matchedBook ? ' book · ' + RS.matchedBank + ' bank' : ''}</div></div>
        <div class="br-summary-item variance-placeholder" id="brVarianceCell"><div class="lbl">Adjusted Variance</div><div class="val" id="brVarianceVal">—</div></div>
      </div>
    </div>
    <div id="brCatGroups"></div>
    <div class="br-card" id="brManualCard" hidden>
      <h3>Manually Match Remaining Items <span class="hint">Couldn't be auto-matched — a typo in the reference number, or a slightly different amount. Tick one or more items on each side that together are really the same transaction, then match them: everything checked drops out of the reconciling items above and moves into the Reconciled Balances proof sheet instead.</span></h3>
      <div class="br-manual-grid">
        <div>
          <div class="br-manual-label">Book items (outstanding checks/ADA &amp; deposits) <span id="mmBookTotal" class="amt"></span></div>
          <div class="mm-list" id="mmBookList"></div>
        </div>
        <div>
          <div class="br-manual-label">Bank items (memos) <span id="mmBankTotal" class="amt"></span></div>
          <div class="mm-list" id="mmBankList"></div>
        </div>
      </div>
      <div class="inline-actions" style="margin-top:10px;"><button class="btn-primary" id="brMatchBtn">Match checked items</button></div>
    </div>
    <div class="br-card">
      <div class="balances-grid">
        <div><h4>Adjusted Book Balance</h4><div id="brBookLines"></div></div>
        <div><h4>Adjusted Bank Balance</h4><div id="brBankLines"></div></div>
      </div>
    </div>
    <div class="inline-actions">
      <button class="btn-primary" id="brExportBtn">Export Bank Reconciliation Statement (.xlsx)</button>
    </div>
  `;
  container.innerHTML = html;

  renderCatGroups(RS);
  renderBalances(RS);
  renderManualMatch(RS, container);

  document.getElementById('brExportBtn').addEventListener('click', () => exportWorkbook(RS));
}

function renderCatGroups(RS) {
  const host = document.getElementById('brCatGroups');
  host.innerHTML = '';
  CATS.forEach((cat) => {
    const rows = RS.items.filter((it) => it.cat === cat.key);
    const sub = rows.filter((r) => r.include).reduce((s, r) => s + r.amount, 0);
    const group = document.createElement('div');
    group.className = 'br-cat-group';
    const stripeColor = cat.side === 'bank' ? 'var(--brand-500)' : 'var(--gold, #8c6a22)';
    group.innerHTML = `<div class="br-cat-head"><span class="stripe" style="background:${stripeColor}"></span>
      <h4>${cat.label}</h4><span class="side">adjusts ${cat.side}</span><span class="amt">${fmtMoney(sub)}</span></div>`;
    if (rows.length) {
      const wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      const table = document.createElement('table');
      table.className = 'data';
      table.innerHTML = '<thead><tr><th></th><th>Date</th><th>Reference</th><th>Description</th><th class="num">Amount</th><th>Remarks</th><th></th></tr></thead>';
      const tb = document.createElement('tbody');
      rows.forEach((it) => {
        const tr = document.createElement('tr');
        if (!it.include) tr.style.opacity = '0.45';
        tr.innerHTML = `
          <td><input type="checkbox" class="br-inc" ${it.include ? 'checked' : ''}></td>
          <td>${escapeHtml(fmtDate(it.date))}</td>
          <td>${escapeHtml(it.ref || '')}</td>
          <td>${escapeHtml(it.name || '')}</td>
          <td class="num"><input type="number" step="0.01" class="br-amt-edit" value="${it.amount.toFixed(2)}"></td>
          <td><input type="text" class="br-remark-edit" value="${escapeHtml(it.remarks || '')}" placeholder="Remarks"></td>
          <td><button type="button" class="btn-ghost br-del" title="Remove">✕</button></td>
        `;
        tr.querySelector('.br-inc').addEventListener('change', (e) => { it.include = e.target.checked; renderCatGroups(RS); renderBalances(RS); renderManualMatch(RS, document.getElementById('brResults')); });
        tr.querySelector('.br-amt-edit').addEventListener('input', (e) => { it.amount = Number(e.target.value) || 0; renderCatGroups(RS); renderBalances(RS); });
        tr.querySelector('.br-remark-edit').addEventListener('input', (e) => { it.remarks = e.target.value; });
        tr.querySelector('.br-del').addEventListener('click', () => { RS.items = RS.items.filter((x) => x.id !== it.id); renderCatGroups(RS); renderBalances(RS); renderManualMatch(RS, document.getElementById('brResults')); });
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      wrap.appendChild(table);
      group.appendChild(wrap);
    } else {
      const e = document.createElement('div');
      e.className = 'empty-state';
      e.textContent = 'No items in this category.';
      group.appendChild(e);
    }
    const addLine = document.createElement('div');
    addLine.className = 'br-addrow-line';
    const addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn-ghost'; addBtn.textContent = '+ Add item';
    addBtn.addEventListener('click', () => {
      RS.items.push({ id: uid(), cat: cat.key, date: new Date().toISOString().slice(0, 10), ref: '', name: '', amount: 0, side: cat.side, include: true, remarks: '' });
      renderCatGroups(RS); renderBalances(RS);
    });
    addLine.appendChild(addBtn);
    group.appendChild(addLine);
    host.appendChild(group);
  });
}

function renderBalances(RS) {
  const { items, meta } = RS;
  const bookAdj = sideSum(items, 'book');
  const bankAdj = sideSum(items, 'bank');
  const adjBook = round2(meta.unadjBook + bookAdj);
  const adjBank = round2(meta.unadjBank + bankAdj);
  const variance = round2(adjBook - adjBank);
  RS.derived = { adjBook, adjBank, variance };

  const line = (label, val, muted) => `<div class="line${muted ? ' muted' : ''}"><span>${label}</span><span class="num">${fmtMoney(val)}</span></div>`;
  document.getElementById('brBookLines').innerHTML =
    line('Unadjusted book balance', meta.unadjBook, true) +
    CATS.filter((c) => c.side === 'book').map((c) => line(c.label, catSum(items, c.key))).join('') +
    `<div class="line total"><span>Adjusted book balance</span><span>${fmtMoney(adjBook)}</span></div>`;
  document.getElementById('brBankLines').innerHTML =
    line('Unadjusted bank balance', meta.unadjBank, true) +
    CATS.filter((c) => c.side === 'bank').map((c) => line(c.label, catSum(items, c.key))).join('') +
    `<div class="line total"><span>Adjusted bank balance</span><span>${fmtMoney(adjBank)}</span></div>`;

  const cell = document.getElementById('brVarianceCell');
  const ok = Math.abs(variance) < 0.01;
  cell.className = 'br-summary-item ' + (ok ? 'variance-ok' : 'variance-bad');
  document.getElementById('brVarianceVal').textContent = fmtMoney(variance);
}

// ---------------------------------------------------- manual matching UI

function manualMatchPools(items) {
  return {
    bookPool: items.filter((it) => it.side === 'bank' && (it.cat === 'checks' || it.cat === 'deposits')),
    bankPool: items.filter((it) => it.side === 'book' && it.cat === 'memos')
  };
}
function mmRowHtml(it) {
  return `<label class="mm-row"><input type="checkbox" data-id="${it.id}">
    <span>${escapeHtml(fmtDate(it.date) + ' · ' + (it.ref || 'no ref') + ' · ' + (it.name || '').slice(0, 34))}</span>
    <span class="mm-amt">${fmtMoney(Math.abs(it.amount))}</span></label>`;
}
function renderManualMatch(RS, container) {
  const card = document.getElementById('brManualCard');
  const pools = manualMatchPools(RS.items);
  if (!pools.bookPool.length || !pools.bankPool.length) { card.hidden = true; return; }
  card.hidden = false;

  // This function can be called many times for the same live #brManualCard
  // (any checkbox/delete edit in the category tables above re-invokes it
  // without a full re-render) — the list/button elements below persist
  // across those calls, so a plain addEventListener would pile up one more
  // duplicate listener per call. Clone-and-replace each interactive element
  // first so every call starts from a listener-free node.
  const freshBookList = document.getElementById('mmBookList').cloneNode(false);
  document.getElementById('mmBookList').replaceWith(freshBookList);
  const freshBankList = document.getElementById('mmBankList').cloneNode(false);
  document.getElementById('mmBankList').replaceWith(freshBankList);
  const freshBtn = document.getElementById('brMatchBtn').cloneNode(true);
  document.getElementById('brMatchBtn').replaceWith(freshBtn);

  freshBookList.innerHTML = pools.bookPool.map(mmRowHtml).join('') || '<div class="mm-empty">None.</div>';
  freshBankList.innerHTML = pools.bankPool.map(mmRowHtml).join('') || '<div class="mm-empty">None.</div>';
  document.getElementById('mmBookTotal').textContent = '';
  document.getElementById('mmBankTotal').textContent = '';

  const updateTotal = (listEl, outEl, pool) => {
    let sum = 0;
    listEl.querySelectorAll('input:checked').forEach((cb) => {
      const it = pool.find((x) => x.id === cb.dataset.id);
      if (it) sum += Math.abs(it.amount);
    });
    outEl.textContent = sum ? fmtMoney(sum) : '';
  };
  freshBookList.addEventListener('change', function () { updateTotal(this, document.getElementById('mmBookTotal'), manualMatchPools(RS.items).bookPool); });
  freshBankList.addEventListener('change', function () { updateTotal(this, document.getElementById('mmBankTotal'), manualMatchPools(RS.items).bankPool); });

  freshBtn.addEventListener('click', () => {
    const pools2 = manualMatchPools(RS.items);
    const bookIds = Array.from(document.querySelectorAll('#mmBookList input:checked')).map((cb) => cb.dataset.id);
    const bankIds = Array.from(document.querySelectorAll('#mmBankList input:checked')).map((cb) => cb.dataset.id);
    const bookIts = pools2.bookPool.filter((it) => bookIds.includes(it.id));
    const bankIts = pools2.bankPool.filter((it) => bankIds.includes(it.id));
    if (!bookIts.length || !bankIts.length) { toast('Check at least one item on each side.', true); return; }
    const cats = {}; bookIts.forEach((it) => { cats[it.cat] = true; });
    if (Object.keys(cats).length > 1) { toast('Match checks/ADA items and deposits separately — checked book items must be all one type.', true); return; }
    const isDisb = bookIts[0].cat === 'checks';

    const bookIdSet = new Set(bookIts.map((it) => it.id));
    const bankIdSet = new Set(bankIts.map((it) => it.id));
    RS.items = RS.items.filter((it) => !bookIdSet.has(it.id) && !bankIdSet.has(it.id));

    const amtBook = round2(bookIts.reduce((s, it) => s + Math.abs(it.amount), 0));
    const amtBank = round2(bankIts.reduce((s, it) => s + Math.abs(it.amount), 0));
    const bookDate = oneOrJoinDates(bookIts.map((it) => it.date));
    const bankDate = oneOrJoinDates(bankIts.map((it) => it.date));
    const bookRef = joinRefs(bookIts.map((it) => it.ref));
    const bankRef = joinRefs(bankIts.map((it) => it.ref));
    const repName = bookIts[0].name || bankIts[0].name || '';

    if (Math.abs(amtBook - amtBank) >= 0.01) {
      const diff = round2(amtBank - amtBook);
      const adj = isDisb ? round2(amtBook - amtBank) : round2(amtBank - amtBook);
      const word = diff > 0 ? 'Understated' : 'Overstated';
      RS.items.push({ id: uid(), cat: isDisb ? 'chkoverunder' : 'deposoverunder',
        date: bookIts[0].date, ref: bookRef || bankRef, name: repName + ' — ' + word + ' by books',
        amount: adj, side: 'book', include: true, remarks: 'Book ' + fmtMoney(amtBook) + ' vs bank ' + fmtMoney(amtBank) + ' (manually matched)' });
    }

    const count = bookIts.length + bankIts.length;
    RS.matchedPairs = (RS.matchedPairs || []).concat([{
      bookDate, bankDate, bookRef, bankRef, amtBook, amtBank, proof: round2(amtBook - amtBank),
      note: 'Manually matched' + (count > 2 ? ` (${bookIts.length} book · ${bankIts.length} bank)` : '')
    }]);
    RS.matchedBook += bookIts.length; RS.matchedBank += bankIts.length;
    renderResults(container, RS);
    toast(`Matched manually — ${count} item${count === 1 ? '' : 's'} moved to Reconciled Balances.`);
  }, { once: true });
}

// -------------------------------------------------------------- export

function exportWorkbook(RS) {
  const { items, meta, matchedPairs, derived } = RS;
  const catAmt = (k) => round2(catSum(items, k));

  const wb = XLSX.utils.book_new();

  const br = [
    [meta.org], [' BANK RECONCILIATION STATEMENT'], [' For the Month of ' + meta.periodLabel],
    ['', 'Bank Name', '', meta.bankName, '', 'Fund', meta.fundLabel],
    ['', 'Branch:', '', meta.branch],
    ['', 'Account No.', '', meta.acctNo],
    ['Particular', '', '', '', 'Book', 'Bank', 'Explanatory Note'],
    ['Unadjusted Balances', '', '', '', meta.unadjBook, meta.unadjBank, ''],
    ['Reconciling Items'],
    ['', 'Checks/ADA Issued not taken up by', '', '', '', catAmt('checks')],
    ['', 'Checks/ADA Issued Overstated/Understated by', '', '', catAmt('chkoverunder'), ''],
    ['', 'Deposits not taken up by', '', '', '', catAmt('deposits')],
    ['', 'Deposit Overstated/Understated by', '', '', catAmt('deposoverunder'), ''],
    ['', 'Bank Debit/Credit Memos, not taken up by the LGU', '', '', catAmt('memos'), ''],
    ['', 'Other Reconciling Items', '', '', catAmt('other'), ''],
    ['Adjusted Balances', '', '', '', derived.adjBook, derived.adjBank, '', derived.variance],
    ['', 'Prepared by:', '', '', 'Certified Correct'],
    ['', meta.preparedBy, '', '', meta.certifiedBy]
  ];
  const wsBR = XLSX.utils.aoa_to_sheet(br);
  wsBR['!cols'] = [{ wch: 4 }, { wch: 32 }, { wch: 4 }, { wch: 26 }, { wch: 16 }, { wch: 16 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, wsBR, ('BR_' + meta.tag).slice(0, 31));

  const sch = [['Schedules'], ['Bank Reconciliation Month:', '', meta.periodLabel], ['Account No.:', '', meta.acctNo], []];
  CATS.forEach((cat) => {
    sch.push([cat.label]);
    sch.push(['Date', 'Reference No', 'Name', 'Amount', 'Remarks']);
    const rows = items.filter((it) => it.cat === cat.key && it.include);
    if (!rows.length) sch.push(['', '', '', 0, '']);
    rows.forEach((it) => sch.push([fmtDate(it.date), it.ref || '', it.name || '', it.amount, it.remarks || '']));
    sch.push(['', '', 'Subtotal', catAmt(cat.key), '']);
    sch.push([]);
  });
  const wsS = XLSX.utils.aoa_to_sheet(sch);
  wsS['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 40 }, { wch: 14 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsS, ('S_' + meta.tag).slice(0, 31));

  const pairs = (matchedPairs || []).slice().sort((a, b) => (Date.parse(b.bookDate) || 0) - (Date.parse(a.bookDate) || 0));
  const rec = [
    [meta.org], [' RECONCILED ITEMS'], [' For the Month of ' + meta.periodLabel + ' — Account No. ' + meta.acctNo], [],
    ['Book Date', 'Bank Date', 'Book Reference No.', 'Bank Reference No.', 'Amount per Book', 'Amount per Bank', 'Proof (Book − Bank)', 'Notes']
  ];
  if (!pairs.length) rec.push(['No items were matched between book and bank this period.', '', '', '', '', '', '', '']);
  pairs.forEach((p) => rec.push([fmtDate(p.bookDate), fmtDate(p.bankDate), p.bookRef || '', p.bankRef || '', p.amtBook, p.amtBank, p.proof, p.note || '']));
  const totBook = round2(pairs.reduce((s, p) => s + p.amtBook, 0));
  const totBank = round2(pairs.reduce((s, p) => s + p.amtBank, 0));
  const totProof = round2(pairs.reduce((s, p) => s + p.proof, 0));
  rec.push([]);
  rec.push(['', '', '', 'Total', totBook, totBank, totProof, '']);
  const wsRec = XLSX.utils.aoa_to_sheet(rec);
  wsRec['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsRec, 'Reconciled Balances');

  const fname = `BRS_${meta.acctNo || meta.fundKey}_${meta.tag}.xlsx`;
  XLSX.writeFile(wb, fname);
  toast('Downloaded ' + fname + '.');
}

// ------------------------------------------------------------------ page

let uploadedBankRows = null;
let uploadedFileName = '';

function renderForm() {
  const panel = document.getElementById('brPanel');
  const fund = currentFund();
  const defaultFundKey = fund && fund !== 'all' ? fund : 'gf';
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  panel.innerHTML = `
    <div class="br-card">
      <h3>1. Account &amp; Period</h3>
      <div class="form-grid">
        <div class="form-field">
          <label>Agency</label>
          <input id="brOrg" value="MUNICIPAL GOVERNMENT OF CANDONI">
        </div>
        <div class="form-field">
          <label>Fund</label>
          <select id="brFund">${FUND_LIST.map(([k, v]) => `<option value="${k}" ${k === defaultFundKey ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <div class="form-field">
          <label>Period (Month)</label>
          <input type="month" id="brMonth" value="${defaultMonth}">
        </div>
        <div class="form-field">
          <label>Bank Name</label>
          <input id="brBankName" placeholder="e.g. Land Bank of the Philippines">
        </div>
        <div class="form-field">
          <label>Branch</label>
          <input id="brBranch" placeholder="e.g. Kabankalan City">
        </div>
        <div class="form-field">
          <label>Account No.</label>
          <input id="brAcctNo" placeholder="e.g. 1172-1020-22">
        </div>
        <div class="form-field">
          <label>Prepared By</label>
          <input id="brPrep" placeholder="Name of preparer">
        </div>
        <div class="form-field">
          <label>Certified Correct By</label>
          <input id="brCert" placeholder="Name of certifying officer">
        </div>
        <div class="form-field">
          <label>Unadjusted Book Balance (per general ledger)</label>
          <input type="number" step="0.01" id="brBookBalance" value="0">
        </div>
        <div class="form-field">
          <label>Unadjusted Bank Balance <span class="field-hint">(auto-fills from statement)</span></label>
          <input type="number" step="0.01" id="brBankBalance" value="0">
        </div>
      </div>
    </div>

    <div class="br-card">
      <h3>2. Prior Period Outstanding Items <span class="hint">(optional — carries forward last month's still-outstanding checks and deposits so they're recognized when they finally clear, not misread as bank memos)</span></h3>
      <div class="table-scroll">
        <table class="data" id="brCarryTable">
          <thead><tr><th>Date</th><th>Category</th><th>Ref No.</th><th>Payee / Description</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody id="brCarryBody"></tbody>
        </table>
      </div>
      <button type="button" class="btn-ghost" id="brCarryAddBtn" style="margin-top:8px;">+ Add Row</button>
    </div>

    <div class="br-card">
      <h3>3. Bank Statement (.xlsx, .xls or .csv)</h3>
      <div class="field-hint" style="margin-bottom:8px;">Columns expected: Date, Description, Debit, Credit, Balance, Cheque Number — the format your bank export already uses.</div>
      <div class="br-dropzone" id="brDropzone">
        <div>Click to choose a file, or drag one here.</div>
        <div class="fname" id="brFileName">${uploadedFileName ? 'Loaded: ' + escapeHtml(uploadedFileName) : ''}</div>
      </div>
      <input type="file" id="brFileInput" accept=".xlsx,.xls,.csv" style="display:none;">
    </div>

    <div class="inline-actions" style="margin-bottom:18px;">
      <button class="btn-primary" id="brRunBtn">4. Run Reconciliation →</button>
    </div>
    <div id="brResults"></div>
  `;

  const carryBody = document.getElementById('brCarryBody');
  document.getElementById('brCarryAddBtn').addEventListener('click', () => addCarryoverRow(carryBody));
  addCarryoverRow(carryBody); // start with one blank row so the section isn't empty

  const dropzone = document.getElementById('brDropzone');
  const fileInput = document.getElementById('brFileInput');
  dropzone.addEventListener('click', () => fileInput.click());
  ['dragenter', 'dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  async function handleFile(file) {
    try {
      const rows = await parseBankFile(file);
      uploadedBankRows = rows;
      uploadedFileName = file.name;
      document.getElementById('brFileName').textContent = 'Loaded: ' + file.name;
      const last = latestBalanceRow(rows);
      if (last && last.balance != null) document.getElementById('brBankBalance').value = last.balance.toFixed(2);
      toast('Loaded ' + rows.length + ' bank transactions.');
    } catch (e) {
      toast('Could not read that file: ' + (e.message || e), true);
    }
  }

  document.getElementById('brRunBtn').addEventListener('click', async () => {
    const fundKey = document.getElementById('brFund').value;
    const month = document.getElementById('brMonth').value;
    if (!month) { toast('Choose a period.', true); return; }
    if (!uploadedBankRows) { toast('Upload a bank statement first.', true); return; }

    const results = document.getElementById('brResults');
    results.innerHTML = '<div class="empty-state">Reconciling…</div>';
    try {
      const { start, end } = monthRange(month);
      const bookRows = await fetchBookEntries(fundKey, start, end);
      const priorOutstanding = readCarryoverRows();
      const { items, matchedBook, matchedBank, matchedPairs, priorCleared, priorCarried } = runReconciliation(bookRows, uploadedBankRows, priorOutstanding);

      const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const [yy, mm] = month.split('-').map(Number);
      const monthName = MONTH_NAMES[mm - 1];
      const tag = monthName.slice(0, 3) + yy;

      const RS = {
        items, matchedBook, matchedBank, matchedPairs,
        meta: {
          org: document.getElementById('brOrg').value || 'MUNICIPAL GOVERNMENT OF CANDONI',
          fundKey, fundLabel: FUND_NAMES[fundKey],
          bankName: document.getElementById('brBankName').value,
          branch: document.getElementById('brBranch').value,
          acctNo: document.getElementById('brAcctNo').value,
          preparedBy: document.getElementById('brPrep').value,
          certifiedBy: document.getElementById('brCert').value,
          unadjBook: Number(document.getElementById('brBookBalance').value) || 0,
          unadjBank: Number(document.getElementById('brBankBalance').value) || 0,
          periodLabel: `${monthName} ${yy}`, tag
        }
      };
      renderResults(results, RS);
      results.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (priorCleared || priorCarried) {
        const msgs = [];
        if (priorCleared) msgs.push(priorCleared + ' prior-period item' + (priorCleared === 1 ? '' : 's') + ' cleared this month');
        if (priorCarried) msgs.push(priorCarried + ' still outstanding, carried forward');
        toast(msgs.join(' · ') + '.');
      }
    } catch (e) {
      results.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
      toast(errorMessage(e), true);
    }
  });
}

export function initBankReconPage() {
  registerPage('bankrecon', renderForm);
  onFundChange(() => {
    if (document.getElementById('page-bankrecon').classList.contains('active')) renderForm();
  });
}
