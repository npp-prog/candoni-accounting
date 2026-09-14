/**
 * Report page — Index of Transactions, Journal Entry Vouchers, and
 * Subsidiary Ledger. Reports read straight from Firestore (Security Rules
 * scope every read to the caller's fund access) rather than through a
 * callable, same as Transactions' own list view.
 */
import { db, collection, query, where, orderBy, getDocs } from '../firebase-init.js';
import { currentFund, onFundChange } from '../state.js';
import { FUND_NAMES, TX_TYPE_LABEL, fmtMoney, escapeHtml } from '../constants.js';
import { renderTable, statusPill, toast, errorMessage } from '../ui.js';
import { registerPage, activeSub } from '../nav.js';
import { openJevModal } from './jev.js';

const COA_COLLECTION_BY_FUND = { gf: 'coa_generalFund', sef: 'coa_sef', tf: 'coa_trustFund' };

async function render() {
  const sub = activeSub('reportSubnav') || 'txIndex';
  const panel = document.getElementById('reportPanel');
  panel.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    if (sub === 'txIndex') await renderTxIndex(panel);
    else if (sub === 'jevIndex') await renderJevIndex(panel);
    else await renderLedger(panel);
  } catch (e) {
    panel.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
  }
}

async function fetchByFund(collectionName, fundKey) {
  const clauses = fundKey && fundKey !== 'all' ? [where('fund', '==', FUND_NAMES[fundKey])] : [];
  try {
    const snap = await getDocs(query(collection(db, collectionName), ...clauses, orderBy('date', 'desc')));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // Composite index may still be building — fall back to unordered.
    const snap = await getDocs(query(collection(db, collectionName), ...clauses));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }
}

async function renderTxIndex(panel) {
  const rows = await fetchByFund('transactions', currentFund());
  panel.innerHTML = renderTable([
    { label: 'Date', key: 'date' },
    { label: 'Type', render: (r) => escapeHtml(r.type) },
    { label: 'Ref No.', render: (r) => escapeHtml(r.primaryRefNo) },
    { label: 'Fund', render: (r) => `<span class="fund-tag">${escapeHtml(r.fund)}</span>` },
    { label: 'Name', render: (r) => escapeHtml(r.name) },
    { label: 'Particulars', render: (r) => escapeHtml(r.particulars) },
    { label: 'Net', num: true, render: (r) => fmtMoney(r.netAmount) },
    { label: 'Status', render: (r) => statusPill(r.status) },
    { label: 'JEV', render: (r) => r.jevNo ? escapeHtml(r.jevNo) : '<span class="muted">—</span>' }
  ], rows, { emptyLabel: 'No transactions recorded yet.' });
}

async function renderJevIndex(panel) {
  const rows = await fetchByFund('jev', currentFund());
  panel.innerHTML = `
    <div class="inline-actions" style="margin-bottom:14px;"><button class="btn-primary" id="jevNewBtn">+ New JEV</button></div>
    <div id="jevTableWrap"></div>`;
  document.getElementById('jevTableWrap').innerHTML = renderTable([
    { label: 'JEV No.', render: (r) => escapeHtml(r.jevNo) },
    { label: 'Date', key: 'date' },
    { label: 'Fund', render: (r) => `<span class="fund-tag">${escapeHtml(r.fund)}</span>` },
    { label: 'Source', render: (r) => r.sourceRef ? `${escapeHtml(r.sourceType)} ${escapeHtml(r.sourceRef)}` : '<span class="muted">Manual</span>' },
    { label: 'Lines', num: true, render: (r) => (r.lines || []).length },
    { label: 'Total Debit', num: true, render: (r) => fmtMoney(r.totalDebit) },
    { label: 'Total Credit', num: true, render: (r) => fmtMoney(r.totalCredit) }
  ], rows, { emptyLabel: 'No Journal Entry Vouchers posted yet.' });

  document.getElementById('jevNewBtn').addEventListener('click', () => {
    const f = currentFund();
    openJevModal({ fundKey: f && f !== 'all' ? f : 'gf' }, () => render());
  });
}

async function loadAccountOptions() {
  const fundKey = currentFund();
  const fundsToLoad = fundKey && fundKey !== 'all' ? [fundKey] : Object.keys(COA_COLLECTION_BY_FUND);
  const all = [];
  for (const fk of fundsToLoad) {
    const snap = await getDocs(collection(db, COA_COLLECTION_BY_FUND[fk]));
    snap.docs.forEach((d) => all.push(d.data()));
  }
  return all.sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)));
}

async function renderLedger(panel) {
  const accounts = await loadAccountOptions();
  panel.innerHTML = `
    <div class="range-row">
      <select id="ledgerAccountSelect" style="padding:7px 10px; border-radius:8px; border:1px solid var(--gridline);">
        <option value="">Select an account…</option>
        ${accounts.map((a) => `<option value="${escapeHtml(a.accountCode)}">${escapeHtml(a.accountCode)} — ${escapeHtml(a.accountName)}</option>`).join('')}
      </select>
      <button class="btn-secondary" id="ledgerLoadBtn">Load</button>
    </div>
    <div id="ledgerWrap"></div>`;
  document.getElementById('ledgerLoadBtn').addEventListener('click', () => loadLedgerFor(document.getElementById('ledgerAccountSelect').value));
}

async function loadLedgerFor(accountCode) {
  const wrap = document.getElementById('ledgerWrap');
  if (!accountCode) { wrap.innerHTML = '<div class="empty-state">Pick an account above, then Load.</div>'; return; }
  wrap.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const snap = await getDocs(query(collection(db, 'jevLines'), where('accountCode', '==', accountCode), orderBy('date', 'asc')));
    let running = 0;
    const rows = snap.docs.map((d) => {
      const l = d.data();
      running += (Number(l.debit) || 0) - (Number(l.credit) || 0);
      return { ...l, running };
    });
    wrap.innerHTML = renderTable([
      { label: 'Date', key: 'date' },
      { label: 'JEV No.', render: (r) => escapeHtml(r.jevNo) },
      { label: 'Fund', render: (r) => `<span class="fund-tag">${escapeHtml(r.fund)}</span>` },
      { label: 'Subsidiary', render: (r) => escapeHtml(r.subsidiary) },
      { label: 'Debit', num: true, render: (r) => fmtMoney(r.debit) },
      { label: 'Credit', num: true, render: (r) => fmtMoney(r.credit) },
      { label: 'Running Balance', num: true, render: (r) => fmtMoney(r.running) }
    ], rows, { emptyLabel: 'No ledger activity yet for this account.' });
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
    toast('Could not load ledger: ' + errorMessage(e), true);
  }
}

export function initReportPage() {
  registerPage('report', render);
  document.getElementById('reportSubnav').addEventListener('subnav-change', render);
  onFundChange(() => {
    if (document.getElementById('page-report').classList.contains('active')) render();
  });
}
