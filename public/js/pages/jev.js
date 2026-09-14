/**
 * Journal Entry Voucher modal — used both from Transactions ("Post JEV" on
 * an Approved record) and from Report > Journal Entry Vouchers ("+ New
 * JEV", a manual/unlinked entry). Ported from the JEV modal in
 * dashboard.html: pick Fund + Date, add Debit/Credit lines against a
 * Chart-of-Accounts code, and Save once Total Debit == Total Credit.
 */
import { db, fn, collection, getDocs, query, where } from '../firebase-init.js';
import { FUND_LIST, FUND_NAMES, fmtMoney, todayStr, escapeHtml } from '../constants.js';
import { showFormModal, closeFormModal, toast, errorMessage, setButtonBusy } from '../ui.js';

const COA_COLLECTION_BY_FUND = { gf: 'coa_generalFund', sef: 'coa_sef', tf: 'coa_trustFund' };
let lineSeq = 0;
let coaCache = {};

async function loadCoa(fundKey) {
  if (coaCache[fundKey]) return coaCache[fundKey];
  const snap = await getDocs(query(collection(db, COA_COLLECTION_BY_FUND[fundKey]), where('status', '==', 'Active')));
  const rows = snap.docs.map((d) => d.data()).sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)));
  coaCache[fundKey] = rows;
  return rows;
}

function lineRowHtml(l) {
  l = l || {};
  const id = ++lineSeq;
  return `<tr data-line-id="${id}">
    <td><input class="jevAccountCode" list="coaOptions" value="${escapeHtml(l.accountCode || '')}" placeholder="Code"></td>
    <td><input class="jevAccountName" value="${escapeHtml(l.accountName || '')}" placeholder="Account name"></td>
    <td><input class="jevSubsidiary" value="${escapeHtml(l.subsidiary || '')}" placeholder="Optional"></td>
    <td><input class="jevDebit" type="number" step="0.01" value="${l.debit || ''}"></td>
    <td><input class="jevCredit" type="number" step="0.01" value="${l.credit || ''}"></td>
    <td><input class="jevBankAccount" value="${escapeHtml(l.bankAccount || '')}" placeholder="Optional"></td>
    <td><button type="button" class="btn-danger jev-remove-line" data-id="${id}">&times;</button></td>
  </tr>`;
}

function recomputeTotals(box) {
  let dr = 0, cr = 0;
  box.querySelectorAll('tr[data-line-id]').forEach((tr) => {
    dr += Number(tr.querySelector('.jevDebit').value) || 0;
    cr += Number(tr.querySelector('.jevCredit').value) || 0;
  });
  const totalsEl = box.querySelector('#jevTotals');
  const balanced = Math.abs(dr - cr) < 0.005;
  totalsEl.innerHTML = `<span>Total Debit: ${fmtMoney(dr)}</span><span>Total Credit: ${fmtMoney(cr)}</span>
    <span class="${balanced ? 'balanced' : 'unbalanced'}">${balanced ? 'Balanced' : 'Not Balanced'}</span>`;
  return { dr, cr, balanced };
}

function wireLineEvents(box) {
  box.querySelectorAll('.jev-remove-line').forEach((b) => {
    b.addEventListener('click', () => {
      const rows = box.querySelectorAll('tr[data-line-id]');
      if (rows.length <= 1) { toast('A JEV needs at least one line.', true); return; }
      box.querySelector(`tr[data-line-id="${b.dataset.id}"]`).remove();
      recomputeTotals(box);
    });
  });
  box.querySelectorAll('.jevDebit, .jevCredit').forEach((el) => el.addEventListener('input', () => recomputeTotals(box)));
}

async function refreshCoaDatalist(box, fundKey) {
  const rows = await loadCoa(fundKey);
  const dl = box.querySelector('#coaOptions');
  dl.innerHTML = rows.map((r) => `<option value="${escapeHtml(r.accountCode)}">${escapeHtml(r.accountName)}</option>`).join('');
}

// prefill: { sourceType, sourceRef, fundKey, date }. onDone is called after
// a successful save (typically the caller's own list-refresh function).
export async function openJevModal(prefill, onDone) {
  prefill = prefill || {};
  lineSeq = 0;
  const initialFund = prefill.fundKey || 'gf';
  let suggested = '';
  try {
    const { data } = await fn('getNextJevNo')({ fund: initialFund });
    suggested = data.jevNo;
  } catch (e) { /* non-fatal — server still assigns one on Save if left blank */ }

  showFormModal({
    title: 'Journal Entry Voucher',
    sub: prefill.sourceRef ? `Posting for ${prefill.sourceType || ''} ${prefill.sourceRef}` : 'Manual entry',
    wide: true,
    bodyHtml: `
      <form id="jevForm">
        <div class="form-grid" style="margin-bottom:14px;">
          <div class="form-field"><label>JEV No.</label><input id="jevNo" value="${escapeHtml(suggested)}" placeholder="Auto-generated if left blank"></div>
          <div class="form-field"><label>Date</label><input type="date" id="jevDate" value="${prefill.date || todayStr()}" required></div>
          <div class="form-field"><label>Fund</label><select id="jevFund">${FUND_LIST.map(([k, v]) => `<option value="${k}" ${k === initialFund ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>
        <datalist id="coaOptions"></datalist>
        <table class="jev-lines-table">
          <thead><tr><th>Account Code</th><th>Account Name</th><th>Subsidiary</th><th>Debit</th><th>Credit</th><th>Bank Account</th><th></th></tr></thead>
          <tbody id="jevLinesBody">${lineRowHtml()}${lineRowHtml()}</tbody>
        </table>
        <div class="inline-actions" style="margin-bottom:10px;">
          <button type="button" class="btn-ghost" id="jevAddLineBtn">+ Add Line</button>
        </div>
        <div class="jev-total-row" id="jevTotals"></div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="jevCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="jevSaveBtn">Save JEV</button>
        </div>
      </form>`
  });

  const box = document.getElementById('formModalBody');
  wireLineEvents(box);
  recomputeTotals(box);
  await refreshCoaDatalist(box, initialFund);

  document.getElementById('jevFund').addEventListener('change', (e) => refreshCoaDatalist(box, e.target.value));
  document.getElementById('jevAddLineBtn').addEventListener('click', () => {
    document.getElementById('jevLinesBody').insertAdjacentHTML('beforeend', lineRowHtml());
    wireLineEvents(box);
  });
  document.getElementById('jevCancelBtn').addEventListener('click', closeFormModal);

  document.getElementById('jevForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('jevSaveBtn');
    setButtonBusy(btn, true, 'Posting…');
    try {
      const lines = Array.from(box.querySelectorAll('tr[data-line-id]')).map((tr) => ({
        accountCode: tr.querySelector('.jevAccountCode').value,
        accountName: tr.querySelector('.jevAccountName').value,
        subsidiary: tr.querySelector('.jevSubsidiary').value,
        debit: Number(tr.querySelector('.jevDebit').value) || 0,
        credit: Number(tr.querySelector('.jevCredit').value) || 0,
        bankAccount: tr.querySelector('.jevBankAccount').value
      })).filter((l) => l.accountCode || l.debit || l.credit);

      const header = {
        jevNo: document.getElementById('jevNo').value || '',
        date: document.getElementById('jevDate').value,
        fund: document.getElementById('jevFund').value,
        sourceType: prefill.sourceType || '',
        sourceRef: prefill.sourceRef || ''
      };
      const { data } = await fn('saveJEV')({ header, lines });
      toast(`Posted as ${data.jevNo}.`);
      closeFormModal();
      if (onDone) onDone();
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      setButtonBusy(btn, false);
    }
  });
}
