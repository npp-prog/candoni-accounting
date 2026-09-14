/**
 * Bank Reconciliation — matches the app's own book records (Checks, ADA,
 * and Collections and Deposit transactions) plus manually-entered prior-
 * period carryover items against an uploaded bank statement (.xlsx/.xls/
 * .csv) for a chosen fund and period, and produces a categorized Bank
 * Reconciliation Statement plus an exportable 3-sheet .xlsx — modeled after
 * the standalone "BRS Workbench" tool (github.com/npp-prog/brs-workbench,
 * live at npp-prog.github.io/brs-workbench), adapted here to read the book
 * side straight from this app's own Firestore data instead of a second
 * upload, and to carry forward last period's still-outstanding items by
 * hand instead of re-parsing last month's exported workbook.
 *
 * Mirrors the reference tool's workflow in five stages on one page:
 *   1. Fund, period & balances
 *   2. Prior period outstanding items (optional manual carryover)
 *   3. Bank statement upload
 *   4. Automatic reconciliation (tiered ref/amount matching, same engine
 *      as before) with a manual "Reconciling Items" workspace for anything
 *      the automatic pass couldn't pair up
 *   5. Export — a 3-sheet workbook: BR_Statement (balance proof), S_Schedule
 *      (reconciling items by category), Reconciled_Balances (every matched
 *      pair, for audit trail)
 *
 * Runs entirely client-side (SheetJS, loaded via CDN in index.html, does
 * the spreadsheet parsing/export) — no Cloud Function involved, so there's
 * nothing new to deploy on the backend for this feature.
 */
import { db, collection, query, where, getDocs } from '../firebase-init.js';
import { currentFund, onFundChange } from '../state.js';
import { FUND_NAMES, FUND_LIST, fmtMoney, escapeHtml } from '../constants.js';
import { registerPage } from '../nav.js';
import { toast, errorMessage } from '../ui.js';

// ---------------------------------------------------------------- helpers

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

function centsEqual(a, b) {
  return Math.round((Number(a) || 0) * 100) === Math.round((Number(b) || 0) * 100);
}

function normalizeRef(s) {
  return String(s || '').trim().toUpperCase().replace(/^0+(?=\d)/, '').replace(/[\s-]/g, '');
}

function daysBetween(a, b) {
  const da = Date.parse(a), db_ = Date.parse(b);
  if (isNaN(da) || isNaN(db_)) return 9999;
  return Math.abs(da - db_) / 86400000;
}

function monthRange(monthStr) {
  // monthStr = 'YYYY-MM'
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${monthStr}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${monthStr}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

// ------------------------------------------------------- bank file parsing

const HEADER_PATTERNS = {
  date: /\bdate\b/i,
  description: /descri|particular|payee|detail|narration/i,
  ref: /\bref\b|reference|cheque|check\s*no|chq|or\s*no/i,
  debit: /debit|withdrawal|\bdr\b/i,
  credit: /credit|deposit|\bcr\b/i,
  amount: /^amount$/i
};

function detectHeader(rows) {
  let best = { idx: -1, score: 0, cols: {} };
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const cols = {};
    let score = 0;
    row.forEach((cell, ci) => {
      const text = String(cell || '').trim();
      if (!text) return;
      for (const key of Object.keys(HEADER_PATTERNS)) {
        if (cols[key] === undefined && HEADER_PATTERNS[key].test(text)) {
          cols[key] = ci;
          score++;
          break;
        }
      }
    });
    if (score > best.score) best = { idx: i, score, cols };
  }
  return best.score >= 2 ? best : null;
}

function parseBankRows(rows) {
  const header = detectHeader(rows);
  if (!header) throw new Error('Could not find a header row (Date/Debit/Credit/Reference) in this file.');
  const out = [];
  for (let i = header.idx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rawDate = header.cols.date !== undefined ? row[header.cols.date] : '';
    if (!rawDate && row.every((c) => !String(c || '').trim())) continue; // blank row
    const description = header.cols.description !== undefined ? String(row[header.cols.description] || '').trim() : '';
    const ref = header.cols.ref !== undefined ? String(row[header.cols.ref] || '').trim() : '';
    let debit = header.cols.debit !== undefined ? toNumber(row[header.cols.debit]) : 0;
    let credit = header.cols.credit !== undefined ? toNumber(row[header.cols.credit]) : 0;
    if (!header.cols.debit && !header.cols.credit && header.cols.amount !== undefined) {
      const amt = toNumber(row[header.cols.amount]);
      if (amt < 0) debit = Math.abs(amt); else credit = amt;
    }
    if (!debit && !credit) continue;
    out.push({
      date: String(rawDate || '').trim(),
      description, ref: normalizeRef(ref), refDisplay: ref,
      debit: Math.abs(debit), credit: Math.abs(credit),
      matched: false, manual: false
    });
  }
  return out;
}

function readWorkbookFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' });
        resolve(rows);
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsArrayBuffer(file);
  });
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
    // Composite index may not exist — fetch by type+fund and filter client-side.
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
    id: r.id, date: r.date, ref: normalizeRef(r.primaryRefNo), refDisplay: r.primaryRefNo,
    amount: Number(r.netAmount) || 0, direction: 'debit', name: r.name, particulars: r.particulars,
    source: 'Check', matched: false, manual: false, carryover: false
  }));
  adas.filter((r) => r.status !== 'Cancelled').forEach((r) => entries.push({
    id: r.id, date: r.date, ref: normalizeRef(r.secondaryRefNo || r.primaryRefNo), refDisplay: r.primaryRefNo,
    amount: Number(r.netAmount) || 0, direction: 'debit', name: r.name, particulars: r.particulars,
    source: 'ADA', matched: false, manual: false, carryover: false
  }));
  deposits.filter((r) => r.status !== 'Cancelled').forEach((r) => entries.push({
    id: r.id, date: r.date, ref: normalizeRef(r.primaryRefNo), refDisplay: r.primaryRefNo,
    amount: Number(r.netAmount) || 0, direction: 'credit', name: r.name, particulars: r.particulars,
    source: 'Collections and Deposit', matched: false, manual: false, carryover: false
  }));
  return entries;
}

// ----------------------------------------------------- carryover (Step 2)

function readCarryoverRows() {
  const rows = [];
  document.querySelectorAll('#brCarryBody tr').forEach((tr) => {
    const date = tr.querySelector('.cf-date').value;
    const direction = tr.querySelector('.cf-type').value;
    const refInput = tr.querySelector('.cf-ref').value;
    const name = tr.querySelector('.cf-name').value;
    const amount = toNumber(tr.querySelector('.cf-amount').value);
    if (!amount) return; // skip empty/incomplete rows silently
    rows.push({
      id: null, date: date || '', ref: normalizeRef(refInput), refDisplay: refInput,
      amount, direction, name, particulars: name,
      source: direction === 'debit' ? 'Carryover — Outstanding Check/ADA' : 'Carryover — Deposit in Transit',
      matched: false, manual: false, carryover: true
    });
  });
  return rows;
}

function addCarryoverRow(tbody) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="date" class="cf-date"></td>
    <td>
      <select class="cf-type">
        <option value="debit">Outstanding Check/ADA</option>
        <option value="credit">Deposit in Transit</option>
      </select>
    </td>
    <td><input class="cf-ref" placeholder="Ref No."></td>
    <td><input class="cf-name" placeholder="Payee / description"></td>
    <td><input type="number" step="0.01" class="cf-amount" placeholder="0.00"></td>
    <td><button type="button" class="btn-ghost cf-remove" title="Remove row">✕</button></td>
  `;
  tr.querySelector('.cf-remove').addEventListener('click', () => tr.remove());
  tbody.appendChild(tr);
}

// ------------------------------------------------------------- matching

function subsetSum(items, targetCents, maxItems) {
  // items: array of {idx, cents}. Returns array of idx summing to targetCents, or null.
  const pool = items.slice(0, maxItems);
  const n = pool.length;
  if (!n || targetCents <= 0) return null;
  const found = new Map(); // sum -> [poolIndex,...]
  found.set(0, []);
  for (let i = 0; i < n; i++) {
    const c = pool[i].cents;
    const snapshot = Array.from(found.entries());
    for (const [sum, combo] of snapshot) {
      const ns = sum + c;
      if (ns > targetCents) continue;
      if (!found.has(ns)) found.set(ns, combo.concat([i]));
      if (ns === targetCents) {
        return found.get(ns).map((pi) => pool[pi].idx);
      }
    }
  }
  return null;
}

function runReconciliation(bookEntries, bankRows) {
  const discrepancies = [];
  const matches = [];

  for (const dir of ['debit', 'credit']) {
    const bookItems = bookEntries.filter((b) => b.direction === dir);
    const bankItems = bankRows.filter((b) => (dir === 'debit' ? b.debit > 0 : b.credit > 0));
    const bankAmt = (b) => (dir === 'debit' ? b.debit : b.credit);

    // Tier 1: exact ref match.
    for (const book of bookItems) {
      if (book.matched || !book.ref) continue;
      const bank = bankItems.find((bk) => !bk.matched && bk.ref && bk.ref === book.ref);
      if (bank) {
        book.matched = true; bank.matched = true;
        if (!centsEqual(book.amount, bankAmt(bank))) {
          discrepancies.push({ direction: dir, book, bank, diff: bankAmt(bank) - book.amount });
        } else {
          matches.push({ tier: 'Exact reference match', direction: dir,
            bookDate: book.date, bookRef: book.refDisplay, bookName: book.name, bookTotal: book.amount,
            bankDate: bank.date, bankRef: bank.refDisplay, bankDescription: bank.description, bankTotal: bankAmt(bank) });
        }
      }
    }

    // Tier 2: group remaining book items sharing a ref, match sum to one bank row.
    const remainingBook = bookItems.filter((b) => !b.matched && b.ref);
    const groups = {};
    remainingBook.forEach((b) => { (groups[b.ref] = groups[b.ref] || []).push(b); });
    for (const ref of Object.keys(groups)) {
      const group = groups[ref];
      if (group.length < 2) continue;
      const total = group.reduce((s, b) => s + b.amount, 0);
      const bank = bankItems.find((bk) => !bk.matched && centsEqual(bankAmt(bk), total));
      if (bank) {
        group.forEach((b) => { b.matched = true; });
        bank.matched = true;
        matches.push({ tier: 'Grouped by reference', direction: dir,
          bookDate: group.map((g) => g.date).join('; '), bookRef: ref, bookName: group.map((g) => g.name).join('; '),
          bookTotal: total, bankDate: bank.date, bankRef: bank.refDisplay, bankDescription: bank.description, bankTotal: bankAmt(bank) });
      }
    }

    // Tier 3a: single book item ↔ subset of unmatched bank rows (split postings),
    // restricted to bank rows within 10 days of the book date.
    for (const book of bookItems) {
      if (book.matched) continue;
      const candidates = bankItems
        .map((bk, idx) => ({ bk, idx }))
        .filter((x) => !x.bk.matched && daysBetween(x.bk.date, book.date) <= 10)
        .sort((a, b) => daysBetween(a.bk.date, book.date) - daysBetween(b.bk.date, book.date))
        .map((x) => ({ idx: x.idx, cents: Math.round(bankAmt(x.bk) * 100) }));
      const hit = subsetSum(candidates, Math.round(book.amount * 100), 20);
      if (hit) {
        book.matched = true;
        const hitRows = hit.map((i) => bankItems[i]);
        hitRows.forEach((r) => { r.matched = true; });
        matches.push({ tier: 'Split postings (1 book ↔ many bank rows)', direction: dir,
          bookDate: book.date, bookRef: book.refDisplay, bookName: book.name, bookTotal: book.amount,
          bankDate: hitRows.map((r) => r.date).join('; '), bankRef: hitRows.map((r) => r.refDisplay).join('; '),
          bankDescription: hitRows.map((r) => r.description).join('; '), bankTotal: book.amount });
      }
    }

    // Tier 3b: single bank row ↔ subset of unmatched book items (batched issuances).
    for (const bank of bankItems) {
      if (bank.matched) continue;
      const candidates = bookItems
        .map((b, idx) => ({ b, idx }))
        .filter((x) => !x.b.matched && daysBetween(x.b.date, bank.date) <= 10)
        .sort((a, b) => daysBetween(a.b.date, bank.date) - daysBetween(b.b.date, bank.date))
        .map((x) => ({ idx: x.idx, cents: Math.round(x.b.amount * 100) }));
      const hit = subsetSum(candidates, Math.round(bankAmt(bank) * 100), 20);
      if (hit) {
        bank.matched = true;
        const hitRows = hit.map((i) => bookItems[i]);
        hitRows.forEach((r) => { r.matched = true; });
        matches.push({ tier: 'Batched issuances (many book ↔ 1 bank row)', direction: dir,
          bookDate: hitRows.map((r) => r.date).join('; '), bookRef: hitRows.map((r) => r.refDisplay).join('; '),
          bookName: hitRows.map((r) => r.name).join('; '), bookTotal: bankAmt(bank),
          bankDate: bank.date, bankRef: bank.refDisplay, bankDescription: bank.description, bankTotal: bankAmt(bank) });
      }
    }
  }

  return { discrepancies, matches };
}

function deriveCategories(bookEntries, bankRows) {
  return {
    outstandingChecks: bookEntries.filter((b) => b.direction === 'debit' && !b.matched),
    depositsInTransit: bookEntries.filter((b) => b.direction === 'credit' && !b.matched),
    bankDebitMemos: bankRows.filter((b) => b.debit > 0 && !b.matched),
    bankCreditMemos: bankRows.filter((b) => b.credit > 0 && !b.matched)
  };
}

// -------------------------------------------------------------- rendering

function sumOf(list, key) { return list.reduce((s, r) => s + (Number(r[key]) || Number(r.amount) || 0), 0); }

function catTableHtml(title, rows, columns, emptyLabel, checkClass) {
  const total = rows.reduce((s, r) => s + (columns.sumKey ? Number(r[columns.sumKey]) || 0 : 0), 0);
  let body;
  if (!rows.length) {
    body = `<div class="empty-state">${emptyLabel}</div>`;
  } else {
    const checkHead = checkClass ? '<th></th>' : '';
    const checkCell = (r, i) => checkClass ? `<td><input type="checkbox" class="${checkClass}" data-gidx="${r._gidx}"></td>` : '';
    body = `<div class="table-scroll"><table class="data"><thead><tr>${checkHead}${columns.heads.map((h) => `<th${h.num ? ' class="num"' : ''}>${h.label}</th>`).join('')}</tr></thead><tbody>` +
      rows.map((r, i) => `<tr>${checkCell(r, i)}${columns.heads.map((h) => `<td${h.num ? ' class="num"' : ''}>${h.render(r)}</td>`).join('')}</tr>`).join('') +
      `</tbody></table></div>`;
  }
  return `<div class="br-cat"><h4><span>${title}</span>${(columns.sumKey && rows.length) ? `<span class="amt">${fmtMoney(total)}</span>` : ''}</h4>${body}</div>`;
}

function renderResults(container, state) {
  const { bookEntries, bankRows, matches, discrepancies, meta } = state;
  bookEntries.forEach((r, i) => { r._gidx = i; });
  bankRows.forEach((r, i) => { r._gidx = i; });

  const { outstandingChecks, depositsInTransit, bankDebitMemos, bankCreditMemos } = deriveCategories(bookEntries, bankRows);

  const outstandingTotal = sumOf(outstandingChecks, 'amount');
  const depositsTotal = sumOf(depositsInTransit, 'amount');
  const debitMemoTotal = bankDebitMemos.reduce((s, r) => s + r.debit, 0);
  const creditMemoTotal = bankCreditMemos.reduce((s, r) => s + r.credit, 0);

  let bookAdj = 0;
  discrepancies.forEach((d) => {
    bookAdj += d.direction === 'debit' ? d.diff : -d.diff; // reconcile book to the bank's actual cleared amount
  });

  const adjustedBank = meta.bankBalance + depositsTotal - outstandingTotal;
  const adjustedBook = meta.bookBalance + creditMemoTotal - debitMemoTotal + bookAdj;
  const variance = Math.round((adjustedBank - adjustedBook) * 100) / 100;

  state.derived = { outstandingChecks, depositsInTransit, bankDebitMemos, bankCreditMemos, outstandingTotal, depositsTotal, debitMemoTotal, creditMemoTotal, adjustedBank, adjustedBook, variance };

  const nameCol = (r) => escapeHtml(r.name) + (r.carryover ? ' <span class="tag-cf">C/F</span>' : '');

  const html = `
    <div class="br-card">
      <h3>Balance Proof — ${escapeHtml(meta.fundLabel)} · ${escapeHtml(meta.periodLabel)}</h3>
      <div class="br-summary-grid">
        <div class="br-summary-item"><div class="lbl">Unadjusted Book Balance</div><div class="val">${fmtMoney(meta.bookBalance)}</div></div>
        <div class="br-summary-item"><div class="lbl">Unadjusted Bank Balance</div><div class="val">${fmtMoney(meta.bankBalance)}</div></div>
        <div class="br-summary-item"><div class="lbl">Adjusted Book Balance</div><div class="val">${fmtMoney(adjustedBook)}</div></div>
        <div class="br-summary-item"><div class="lbl">Adjusted Bank Balance</div><div class="val">${fmtMoney(adjustedBank)}</div></div>
        <div class="br-summary-item ${variance === 0 ? 'variance-ok' : 'variance-bad'}">
          <div class="lbl">Variance</div><div class="val">${fmtMoney(variance)}</div>
        </div>
      </div>
    </div>

    <div class="br-card">
      <h3>Reconciling Items</h3>
      ${catTableHtml('Checks / ADA Issued — Not Yet Cleared by the Bank', outstandingChecks,
        { heads: [
            { label: 'Date', render: (r) => escapeHtml(r.date) },
            { label: 'Ref No.', render: (r) => escapeHtml(r.refDisplay) },
            { label: 'Payee', render: nameCol },
            { label: 'Amount', num: true, render: (r) => fmtMoney(r.amount) }
          ], sumKey: 'amount' }, 'None — every check/ADA issued has cleared the bank.', 'br-chk-book')}
      ${catTableHtml('Deposits / Collections — Not Yet Reflected in the Bank Statement', depositsInTransit,
        { heads: [
            { label: 'Date', render: (r) => escapeHtml(r.date) },
            { label: 'Ref No.', render: (r) => escapeHtml(r.refDisplay) },
            { label: 'Collector', render: nameCol },
            { label: 'Amount', num: true, render: (r) => fmtMoney(r.amount) }
          ], sumKey: 'amount' }, 'None — every deposit has been credited by the bank.', 'br-dep-book')}
      ${catTableHtml('Bank Debit Memos — Not Yet Taken Up in the Books', bankDebitMemos,
        { heads: [
            { label: 'Date', render: (r) => escapeHtml(r.date) },
            { label: 'Description', render: (r) => escapeHtml(r.description) },
            { label: 'Ref', render: (r) => escapeHtml(r.refDisplay) },
            { label: 'Amount', num: true, render: (r) => fmtMoney(r.debit) }
          ], sumKey: 'debit' }, 'None.', 'br-chk-bank')}
      ${catTableHtml('Bank Credit Memos — Not Yet Taken Up in the Books', bankCreditMemos,
        { heads: [
            { label: 'Date', render: (r) => escapeHtml(r.date) },
            { label: 'Description', render: (r) => escapeHtml(r.description) },
            { label: 'Ref', render: (r) => escapeHtml(r.refDisplay) },
            { label: 'Amount', num: true, render: (r) => fmtMoney(r.credit) }
          ], sumKey: 'credit' }, 'None.', 'br-dep-bank')}
      ${catTableHtml('Reconciling Differences — Same Reference, Different Amount', discrepancies,
        { heads: [
            { label: 'Ref No.', render: (r) => escapeHtml(r.book.refDisplay) },
            { label: 'Per Books', num: true, render: (r) => fmtMoney(r.book.amount) },
            { label: 'Per Bank', num: true, render: (r) => fmtMoney(r.direction === 'debit' ? r.bank.debit : r.bank.credit) },
            { label: 'Difference', num: true, render: (r) => fmtMoney(r.diff) }
          ], sumKey: null }, 'None.')}
    </div>

    <div class="br-card">
      <h3>Manual Matching <span class="hint">(for anything the automatic pass above couldn't pair up — tick one or more on each side, then match them)</span></h3>
      <div class="br-manual-grid">
        <div>
          <div class="br-manual-label">Checks / ADA not yet cleared ↔ Bank debit memos</div>
          <button type="button" class="btn-ghost" id="brMatchDebitBtn">Match checked items</button>
        </div>
        <div>
          <div class="br-manual-label">Deposits not yet reflected ↔ Bank credit memos</div>
          <button type="button" class="btn-ghost" id="brMatchCreditBtn">Match checked items</button>
        </div>
      </div>
    </div>

    <div class="inline-actions">
      <button class="btn-primary" id="brExportBtn">Export Bank Reconciliation Statement (.xlsx)</button>
    </div>
  `;
  container.innerHTML = html;

  document.getElementById('brExportBtn').addEventListener('click', () => {
    exportWorkbook(state);
  });

  document.getElementById('brMatchDebitBtn').addEventListener('click', () => {
    manualMatch(state, 'debit', 'br-chk-book', 'br-chk-bank', container);
  });
  document.getElementById('brMatchCreditBtn').addEventListener('click', () => {
    manualMatch(state, 'credit', 'br-dep-book', 'br-dep-bank', container);
  });
}

function manualMatch(state, direction, bookClass, bankClass, container) {
  const bookIdx = Array.from(container.querySelectorAll('.' + bookClass + ':checked')).map((el) => Number(el.dataset.gidx));
  const bankIdx = Array.from(container.querySelectorAll('.' + bankClass + ':checked')).map((el) => Number(el.dataset.gidx));
  if (!bookIdx.length && !bankIdx.length) { toast('Tick at least one item on either side first.', true); return; }

  const bookRows = bookIdx.map((i) => state.bookEntries[i]);
  const bankRows = bankIdx.map((i) => state.bankRows[i]);
  const bookTotal = bookRows.reduce((s, r) => s + r.amount, 0);
  const bankTotal = bankRows.reduce((s, r) => s + (direction === 'debit' ? r.debit : r.credit), 0);

  bookRows.forEach((r) => { r.matched = true; r.manual = true; });
  bankRows.forEach((r) => { r.matched = true; r.manual = true; });

  const pseudoBook = {
    refDisplay: bookRows.map((r) => r.refDisplay).join('; ') || '—',
    date: bookRows.map((r) => r.date).join('; ') || '—',
    name: bookRows.map((r) => r.name).join('; '),
    amount: bookTotal
  };
  const pseudoBank = {
    refDisplay: bankRows.map((r) => r.refDisplay).join('; ') || '—',
    date: bankRows.map((r) => r.date).join('; ') || '—',
    description: bankRows.map((r) => r.description).join('; '),
    debit: direction === 'debit' ? bankTotal : 0,
    credit: direction === 'credit' ? bankTotal : 0
  };

  if (centsEqual(bookTotal, bankTotal)) {
    state.matches.push({ tier: 'Manual match', direction,
      bookDate: pseudoBook.date, bookRef: pseudoBook.refDisplay, bookName: pseudoBook.name, bookTotal,
      bankDate: pseudoBank.date, bankRef: pseudoBank.refDisplay, bankDescription: pseudoBank.description, bankTotal });
    toast('Matched — balances agree.');
  } else {
    state.discrepancies.push({ direction, book: pseudoBook, bank: pseudoBank, diff: bankTotal - bookTotal, manual: true });
    toast('Matched with a difference — added to Reconciling Differences.', true);
  }

  renderResults(document.getElementById('brResults'), state);
}

function exportWorkbook(state) {
  const { meta, derived, matches, discrepancies } = state;
  const wb = XLSX.utils.book_new();

  // Sheet 1 — BR_Statement: the balance-proof summary.
  const statement = [
    ['MUNICIPAL GOVERNMENT OF CANDONI — MGO CANDONI ACCOUNTING SYSTEM'],
    ['Bank Reconciliation Statement'],
    [meta.fundLabel + ' — ' + meta.periodLabel + (meta.bankLabel ? ' — ' + meta.bankLabel : '')],
    [],
    ['Unadjusted Book Balance', meta.bookBalance],
    ['Add: Bank Credit Memos not yet taken up', derived.creditMemoTotal],
    ['Less: Bank Debit Memos not yet taken up', -derived.debitMemoTotal],
    ['Adjusted Book Balance', derived.adjustedBook],
    [],
    ['Unadjusted Bank Balance', meta.bankBalance],
    ['Add: Deposits/Collections not yet reflected', derived.depositsTotal],
    ['Less: Checks/ADA not yet cleared', -derived.outstandingTotal],
    ['Adjusted Bank Balance', derived.adjustedBank],
    [],
    ['Variance (should be zero)', derived.variance]
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(statement), 'BR_Statement');

  // Sheet 2 — S_Schedule: reconciling items by category, same as on screen.
  const schedule = [['Category', 'Date', 'Reference', 'Name / Description', 'Amount']];
  derived.outstandingChecks.forEach((r) => schedule.push([r.carryover ? 'Checks/ADA Not Yet Cleared (C/F)' : 'Checks/ADA Not Yet Cleared', r.date, r.refDisplay, r.name, r.amount]));
  derived.depositsInTransit.forEach((r) => schedule.push([r.carryover ? 'Deposits Not Yet Reflected (C/F)' : 'Deposits Not Yet Reflected', r.date, r.refDisplay, r.name, r.amount]));
  derived.bankDebitMemos.forEach((r) => schedule.push(['Bank Debit Memo', r.date, r.refDisplay, r.description, r.debit]));
  derived.bankCreditMemos.forEach((r) => schedule.push(['Bank Credit Memo', r.date, r.refDisplay, r.description, r.credit]));
  discrepancies.forEach((r) => schedule.push(['Reconciling Difference', r.book.date, r.book.refDisplay,
    `Books ${r.book.amount} vs Bank ${r.direction === 'debit' ? r.bank.debit : r.bank.credit}`, r.diff]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(schedule), 'S_Schedule');

  // Sheet 3 — Reconciled_Balances: every matched pair, as an audit trail proof.
  const proof = [['Match Type', 'Book Date', 'Book Ref', 'Book Payee/Desc.', 'Book Amount', 'Bank Date', 'Bank Ref', 'Bank Description', 'Bank Amount']];
  matches.forEach((m) => proof.push([m.tier, m.bookDate, m.bookRef, m.bookName, m.bookTotal, m.bankDate, m.bankRef, m.bankDescription, m.bankTotal]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(proof), 'Reconciled_Balances');

  const fname = `BRS_${meta.fundKey}_${meta.period}.xlsx`;
  XLSX.writeFile(wb, fname);
  toast('Downloaded ' + fname + '.');
}

// ------------------------------------------------------------------ page

let uploadedRows = null;
let uploadedFileName = '';

function renderForm() {
  const panel = document.getElementById('brPanel');
  const fund = currentFund();
  const defaultFundKey = fund && fund !== 'all' ? fund : 'gf';
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  panel.innerHTML = `
    <div class="br-card">
      <h3>1. Fund, Period &amp; Balances</h3>
      <div class="form-grid">
        <div class="form-field">
          <label>Fund</label>
          <select id="brFund">${FUND_LIST.map(([k, v]) => `<option value="${k}" ${k === defaultFundKey ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <div class="form-field">
          <label>Period (Month)</label>
          <input type="month" id="brMonth" value="${defaultMonth}">
        </div>
        <div class="form-field">
          <label>Bank Account / Statement Label</label>
          <input id="brBankLabel" placeholder="e.g. LBP Current Account No. 1234">
        </div>
        <div class="form-field">
          <label>Unadjusted Book Balance (end of period)</label>
          <input type="number" step="0.01" id="brBookBalance" value="0">
        </div>
        <div class="form-field">
          <label>Unadjusted Bank Balance (per statement, end of period)</label>
          <input type="number" step="0.01" id="brBankBalance" value="0">
        </div>
      </div>
    </div>

    <div class="br-card">
      <h3>2. Prior Period Outstanding Items <span class="hint">(optional — checks or deposits from an earlier month still not cleared by the bank; carried forward from your last reconciliation)</span></h3>
      <div class="table-scroll">
        <table class="data" id="brCarryTable">
          <thead><tr><th>Date</th><th>Type</th><th>Ref No.</th><th>Payee / Description</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody id="brCarryBody"></tbody>
        </table>
      </div>
      <button type="button" class="btn-ghost" id="brCarryAddBtn" style="margin-top:8px;">+ Add Row</button>
    </div>

    <div class="br-card">
      <h3>3. Bank Statement (.xlsx, .xls or .csv)</h3>
      <div class="br-dropzone" id="brDropzone">
        <div>Click to choose a file, or drag one here.</div>
        <div class="field-hint">Expected columns: Date, Description, Reference/Cheque No., Debit, Credit (or a single signed Amount column).</div>
        <div class="fname" id="brFileName">${uploadedFileName ? 'Loaded: ' + escapeHtml(uploadedFileName) : ''}</div>
      </div>
      <input type="file" id="brFileInput" accept=".xlsx,.xls,.csv" style="display:none;">
    </div>

    <div class="inline-actions" style="margin-bottom:18px;">
      <button class="btn-primary" id="brRunBtn">4. Run Reconciliation</button>
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
      const rows = await readWorkbookFile(file);
      uploadedRows = rows;
      uploadedFileName = file.name;
      document.getElementById('brFileName').textContent = 'Loaded: ' + file.name;
    } catch (e) {
      toast('Could not read that file: ' + (e.message || e), true);
    }
  }

  document.getElementById('brRunBtn').addEventListener('click', async () => {
    const fundKey = document.getElementById('brFund').value;
    const month = document.getElementById('brMonth').value;
    const bankLabel = document.getElementById('brBankLabel').value || 'Bank Account';
    const bookBalance = Number(document.getElementById('brBookBalance').value) || 0;
    const bankBalance = Number(document.getElementById('brBankBalance').value) || 0;
    if (!month) { toast('Choose a period.', true); return; }
    if (!uploadedRows) { toast('Upload a bank statement first.', true); return; }

    const results = document.getElementById('brResults');
    results.innerHTML = '<div class="empty-state">Reconciling…</div>';
    try {
      const { start, end } = monthRange(month);
      const [fetchedEntries, bankRows] = await Promise.all([
        fetchBookEntries(fundKey, start, end),
        Promise.resolve(parseBankRows(uploadedRows))
      ]);
      const carryoverRows = readCarryoverRows();
      const bookEntries = fetchedEntries.concat(carryoverRows);
      const { discrepancies, matches } = runReconciliation(bookEntries, bankRows);

      const state = {
        bookEntries, bankRows, discrepancies, matches,
        meta: {
          fundKey, fundLabel: FUND_NAMES[fundKey], period: month,
          periodLabel: new Date(month + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
          bankLabel, bookBalance, bankBalance
        }
      };
      renderResults(results, state);
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
