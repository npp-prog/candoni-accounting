/**
 * Create page — Name (Database), Bank Account, and Subsidiary Ledger
 * Accounts. Name/Bank Account are plain generic master-data lists (see
 * masterData.js); Subsidiary Ledger Accounts keeps its own dedicated form
 * (a Name picker + an Account Code picker scoped to a chosen Fund), same
 * as the original — see Create_SubsidiaryLedgerAccounts in Code.gs.
 */
import { db, fn, collection, getDocs, query, orderBy } from '../firebase-init.js';
import { hasRole } from '../state.js';
import { FUND_LIST, FUND_NAMES, fmtMoney, escapeHtml } from '../constants.js';
import { renderTable, toast, errorMessage, showFormModal, closeFormModal, setButtonBusy, confirmAction } from '../ui.js';
import { registerPage, activeSub } from '../nav.js';
import { renderMasterDataList } from './masterData.js';

const ROLE_CAN_EDIT_TRANSACTIONS = ['Municipal Accountant', 'Accounting Supervisor', 'Accounting Staff'];
const COA_COLLECTION_BY_FUND = { gf: 'coa_generalFund', sef: 'coa_sef', tf: 'coa_trustFund' };

function slaCode(name, qualifier, fund, accountCode) {
  return [name, qualifier, fund, accountCode].filter(Boolean).join('__')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function render() {
  const sub = activeSub('createSubnav') || 'names';
  const panel = document.getElementById('createPanel');
  panel.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    if (sub === 'names') await renderMasterDataList(panel, 'names', ROLE_CAN_EDIT_TRANSACTIONS);
    else if (sub === 'bankAccount') await renderMasterDataList(panel, 'bankAccount', ROLE_CAN_EDIT_TRANSACTIONS);
    else await renderSubsidiaryLedgerAccounts(panel);
  } catch (e) {
    panel.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
  }
}

async function renderSubsidiaryLedgerAccounts(panel) {
  const canEdit = hasRole(...ROLE_CAN_EDIT_TRANSACTIONS);
  const snap = await getDocs(query(collection(db, 'createSubsidiaryLedgerAccounts'), orderBy('name')));
  const rows = snap.docs.map((d) => d.data());
  panel.innerHTML = `
    ${canEdit ? `<div class="inline-actions" style="margin-bottom:14px;"><button class="btn-primary" id="slaNewBtn">+ New Subsidiary Ledger Account</button></div>` : ''}
    <div id="slaTableWrap"></div>`;
  document.getElementById('slaTableWrap').innerHTML = renderTable([
    { label: 'Name', render: (r) => escapeHtml(r.name) },
    { label: 'Qualifier', render: (r) => escapeHtml(r.qualifier) },
    { label: 'Fund', render: (r) => `<span class="fund-tag">${escapeHtml(r.fund)}</span>` },
    { label: 'Account Code', render: (r) => escapeHtml(r.accountCode) },
    { label: 'Account Name', render: (r) => escapeHtml(r.accountName) },
    { label: 'Beginning Balance', num: true, render: (r) => fmtMoney(r.beginningBalance) },
    { label: 'Status', render: (r) => escapeHtml(r.status) },
    {
      label: '', render: (r) => canEdit
        ? `<div class="list-actions"><button class="btn-danger sla-del-btn" data-code="${escapeHtml(r.code)}">Delete</button></div>`
        : ''
    }
  ], rows, { emptyLabel: 'No Subsidiary Ledger Accounts registered yet.' });

  if (canEdit) {
    document.getElementById('slaNewBtn').addEventListener('click', () => openSlaModal(() => render()));
    panel.querySelectorAll('.sla-del-btn').forEach((b) => b.addEventListener('click', async () => {
      if (!confirmAction('Delete this Subsidiary Ledger Account?')) return;
      try {
        await fn('deleteCreateRecord')({ key: 'subsidiaryLedgerAccounts', keyValue: b.dataset.code });
        toast('Deleted.');
        render();
      } catch (e) { toast(errorMessage(e), true); }
    }));
  }
}

async function openSlaModal(onSaved) {
  const [namesSnap] = await Promise.all([getDocs(query(collection(db, 'createNames'), orderBy('name')))]);
  const names = namesSnap.docs.map((d) => d.data().name).filter(Boolean);

  showFormModal({
    title: 'New Subsidiary Ledger Account',
    sub: 'Pick a registered Name (register it under Create > Name (Database) first if it is not there yet), optionally add a Qualifier, then the Fund + Account this Beginning Balance belongs to.',
    wide: true,
    bodyHtml: `
      <form id="slaForm">
        <div class="form-grid">
          <div class="form-field"><label>Name</label><input name="name" list="slaNameList" required></div>
          <div class="form-field"><label>Qualifier (optional)</label><input name="qualifier" placeholder="e.g. Withholding Tax"></div>
          <div class="form-field"><label>Fund</label><select name="fund" id="slaFund">${FUND_LIST.map(([k, v]) => `<option value="${v}" data-fk="${k}">${v}</option>`).join('')}</select></div>
          <div class="form-field"><label>Account Code</label><input name="accountCode" list="slaAccountList" required></div>
          <div class="form-field span2"><label>Account Name</label><input name="accountName"></div>
          <div class="form-field"><label>Beginning Balance</label><input name="beginningBalance" type="number" step="0.01" value="0"></div>
          <div class="form-field"><label>Status</label><select name="status"><option>Active</option><option>Inactive</option></select></div>
        </div>
        <datalist id="slaNameList">${names.map((n) => `<option value="${escapeHtml(n)}">`).join('')}</datalist>
        <datalist id="slaAccountList"></datalist>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="slaCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="slaSaveBtn">Save</button>
        </div>
      </form>`
  });

  async function refreshAccountList() {
    const opt = document.getElementById('slaFund').selectedOptions[0];
    const fk = opt ? opt.dataset.fk : 'gf';
    const snap = await getDocs(collection(db, COA_COLLECTION_BY_FUND[fk]));
    document.getElementById('slaAccountList').innerHTML = snap.docs
      .map((d) => d.data())
      .sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)))
      .map((a) => `<option value="${escapeHtml(a.accountCode)}">${escapeHtml(a.accountName)}</option>`).join('');
  }
  document.getElementById('slaFund').addEventListener('change', refreshAccountList);
  refreshAccountList();

  document.getElementById('slaCancelBtn').addEventListener('click', closeFormModal);
  document.getElementById('slaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('slaSaveBtn');
    setButtonBusy(btn, true, 'Saving…');
    const f = e.target.elements;
    try {
      const name = f['name'].value.trim();
      const qualifier = f['qualifier'].value.trim();
      const fund = f['fund'].value;
      const accountCode = f['accountCode'].value.trim();
      const code = slaCode(name, qualifier, fund, accountCode);
      await fn('saveCreateRecord')({
        key: 'subsidiaryLedgerAccounts',
        payload: {
          code, name, qualifier, fund, accountCode,
          accountName: f['accountName'].value, beginningBalance: Number(f['beginningBalance'].value) || 0,
          status: f['status'].value
        }
      });
      toast('Saved.');
      closeFormModal();
      onSaved();
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      setButtonBusy(btn, false);
    }
  });
}

export function initCreatePage() {
  registerPage('create', render);
  document.getElementById('createSubnav').addEventListener('subnav-change', render);
}
