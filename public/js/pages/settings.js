/**
 * Settings page — Chart of Accounts, System Access, Office, FPP, and
 * monthly Closing. "In Settings, only the Municipal Accountant can Modify
 * and Add Settings. Other Users can just View." (Chart of Accounts is
 * view-only for everyone else; System Access and Closing's write actions
 * are Municipal-Accountant-only, matching functions/src/{coa,auth,
 * closedPeriodsFns}.js and the Firestore Security Rules.)
 */
import { db, fn, collection, getDocs, query, orderBy } from '../firebase-init.js';
import { currentFund, onFundChange, hasRole, currentUser } from '../state.js';
import { FUND_LIST, FUND_NAMES, ROLES, escapeHtml, todayStr } from '../constants.js';
import { renderTable, toast, errorMessage, showFormModal, closeFormModal, setButtonBusy, confirmAction } from '../ui.js';
import { registerPage, activeSub } from '../nav.js';
import { renderMasterDataList } from './masterData.js';

const ROLE_SETTINGS_ONLY = ['Municipal Accountant'];
const COA_COLLECTION_BY_FUND = { gf: 'coa_generalFund', sef: 'coa_sef', tf: 'coa_trustFund' };

async function render() {
  const sub = activeSub('settingsSubnav') || 'coa';
  const panel = document.getElementById('settingsPanel');
  panel.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    if (sub === 'coa') await renderCoa(panel);
    else if (sub === 'access') await renderAccess(panel);
    else if (sub === 'office') await renderMasterDataList(panel, 'office', ROLE_SETTINGS_ONLY);
    else if (sub === 'fpp') await renderMasterDataList(panel, 'fpp', ROLE_SETTINGS_ONLY);
    else await renderClosing(panel);
  } catch (e) {
    panel.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
  }
}

// ---------------------------------------------------------------- COA ----
async function renderCoa(panel) {
  const canEdit = hasRole(...ROLE_SETTINGS_ONLY);
  let fundKey = currentFund();
  if (!fundKey || fundKey === 'all') fundKey = 'gf';
  const snap = await getDocs(query(collection(db, COA_COLLECTION_BY_FUND[fundKey]), orderBy('accountCode')));
  const rows = snap.docs.map((d) => d.data());

  panel.innerHTML = `
    <p class="readonly-note">Showing ${escapeHtml(FUND_NAMES[fundKey])}'s Chart of Accounts — switch funds at the top to view another.</p>
    ${canEdit ? `<div class="inline-actions" style="margin:10px 0 14px;"><button class="btn-primary" id="coaAddBtn">+ New Account</button></div>` : ''}
    <div id="coaTableWrap"></div>`;
  document.getElementById('coaTableWrap').innerHTML = renderTable([
    { label: 'Code', render: (r) => escapeHtml(r.accountCode) },
    { label: 'Account Name', render: (r) => escapeHtml(r.accountName) },
    { label: 'Category', render: (r) => escapeHtml(r.category) },
    { label: 'Status', render: (r) => escapeHtml(r.status) },
    {
      label: '', render: (r) => canEdit
        ? `<div class="list-actions">
            <button class="btn-ghost coa-edit-btn" data-code="${escapeHtml(r.accountCode)}">Edit</button>
            <button class="btn-danger coa-del-btn" data-code="${escapeHtml(r.accountCode)}">Delete</button>
          </div>`
        : ''
    }
  ], rows, { emptyLabel: 'No accounts encoded yet for this fund.' });

  if (canEdit) {
    document.getElementById('coaAddBtn').addEventListener('click', () => openCoaModal(fundKey, null, () => render()));
    panel.querySelectorAll('.coa-edit-btn').forEach((b) => b.addEventListener('click', () => {
      openCoaModal(fundKey, rows.find((r) => r.accountCode === b.dataset.code), () => render());
    }));
    panel.querySelectorAll('.coa-del-btn').forEach((b) => b.addEventListener('click', async () => {
      if (!confirmAction(`Delete account ${b.dataset.code}?`)) return;
      try {
        await fn('deleteAccount')({ fund: fundKey, accountCode: b.dataset.code });
        toast('Deleted.');
        render();
      } catch (e) { toast(errorMessage(e), true); }
    }));
  }
}

function openCoaModal(fundKey, row, onSaved) {
  showFormModal({
    title: row ? 'Edit Account' : 'New Account',
    bodyHtml: `
      <form id="coaForm">
        <div class="form-grid">
          <div class="form-field"><label>Account Code</label><input name="accountCode" value="${escapeHtml(row ? row.accountCode : '')}" ${row ? 'readonly' : ''} required></div>
          <div class="form-field span2"><label>Account Name</label><input name="accountName" value="${escapeHtml(row ? row.accountName : '')}" required></div>
          <div class="form-field"><label>Category</label><input name="category" value="${escapeHtml(row ? row.category : '')}"></div>
          <div class="form-field"><label>Status</label><select name="status"><option ${!row || row.status === 'Active' ? 'selected' : ''}>Active</option><option ${row && row.status === 'Inactive' ? 'selected' : ''}>Inactive</option></select></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="coaCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="coaSaveBtn">Save</button>
        </div>
      </form>`
  });
  document.getElementById('coaCancelBtn').addEventListener('click', closeFormModal);
  document.getElementById('coaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('coaSaveBtn');
    setButtonBusy(btn, true, 'Saving…');
    const f = e.target.elements;
    try {
      await fn('saveAccount')({
        fund: fundKey, accountCode: f['accountCode'].value, accountName: f['accountName'].value,
        category: f['category'].value, status: f['status'].value
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

// --------------------------------------------------------- System Access
async function renderAccess(panel) {
  const canEdit = hasRole(...ROLE_SETTINGS_ONLY);
  if (!canEdit) {
    panel.innerHTML = '<div class="readonly-note">System Access is visible to the Municipal Accountant only.</div>';
    return;
  }
  const snap = await getDocs(collection(db, 'users'));
  const rows = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));

  panel.innerHTML = `
    <div class="inline-actions" style="margin-bottom:14px;"><button class="btn-primary" id="userNewBtn">+ New User</button></div>
    <div id="userTableWrap"></div>`;
  document.getElementById('userTableWrap').innerHTML = renderTable([
    { label: 'Name', render: (r) => escapeHtml(r.fullName) },
    { label: 'Email', render: (r) => escapeHtml(r.email) },
    { label: 'Username', render: (r) => escapeHtml(r.username) },
    { label: 'Role', render: (r) => `<span class="role-badge">${escapeHtml(r.role)}</span>` },
    { label: 'Fund Access', render: (r) => (r.fundAccess && r.fundAccess.length ? r.fundAccess.map(escapeHtml).join(', ') : 'All') },
    { label: 'Status', render: (r) => escapeHtml(r.status) },
    {
      label: '', render: (r) => `<div class="list-actions">
          <button class="btn-ghost user-edit-btn" data-uid="${r.uid}">Edit</button>
          <button class="btn-secondary user-reset-btn" data-uid="${r.uid}">Reset Password</button>
        </div>`
    }
  ], rows, { emptyLabel: 'No users yet.' });

  document.getElementById('userNewBtn').addEventListener('click', () => openUserModal(null, () => render()));
  panel.querySelectorAll('.user-edit-btn').forEach((b) => b.addEventListener('click', () => {
    openUserModal(rows.find((r) => r.uid === b.dataset.uid), () => render());
  }));
  panel.querySelectorAll('.user-reset-btn').forEach((b) => b.addEventListener('click', () => openResetModal(b.dataset.uid)));
}

function openUserModal(row, onSaved) {
  const fundOpts = FUND_LIST.map(([k, v]) => `<label style="display:flex; align-items:center; gap:5px; font-weight:400;">
    <input type="checkbox" name="fundAccess" value="${k}" ${row && row.fundAccess && row.fundAccess.includes(k) ? 'checked' : ''}> ${v}</label>`).join('');
  showFormModal({
    title: row ? 'Edit User' : 'New User',
    sub: row ? '' : 'Creates a Firebase Auth login and issues a temporary password.',
    wide: true,
    bodyHtml: `
      <form id="userForm">
        <div class="form-grid">
          <div class="form-field span2"><label>Full Name</label><input name="fullName" value="${escapeHtml(row ? row.fullName : '')}" required></div>
          <div class="form-field"><label>Email</label><input name="email" type="email" value="${escapeHtml(row ? row.email : '')}" ${row ? 'readonly' : ''} required></div>
          ${row ? '' : `<div class="form-field"><label>Username (optional)</label><input name="username"></div>`}
          <div class="form-field"><label>Role</label><select name="role">${ROLES.map((r) => `<option ${row && row.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
          <div class="form-field"><label>Status</label><select name="status"><option ${!row || row.status === 'Active' ? 'selected' : ''}>Active</option><option ${row && row.status === 'Inactive' ? 'selected' : ''}>Inactive</option></select></div>
          ${row ? '' : `<div class="form-field"><label>Temporary Password</label><input name="tempPassword" type="text" minlength="6" required></div>`}
          <div class="form-field span3"><label>Fund Access (leave all unchecked for full access)</label>
            <div class="checkbox-row" style="flex-wrap:wrap; gap:10px;">${fundOpts}</div>
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="userCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="userSaveBtn">Save</button>
        </div>
      </form>`
  });
  document.getElementById('userCancelBtn').addEventListener('click', closeFormModal);
  document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('userSaveBtn');
    setButtonBusy(btn, true, 'Saving…');
    const f = e.target.elements;
    const fundAccess = Array.from(e.target.querySelectorAll('input[name="fundAccess"]:checked')).map((el) => el.value);
    try {
      if (row) {
        await fn('updateUser')({ uid: row.uid, fullName: f['fullName'].value, role: f['role'].value, fundAccess, status: f['status'].value });
      } else {
        await fn('createUser')({
          fullName: f['fullName'].value, email: f['email'].value, username: f['username'].value,
          role: f['role'].value, fundAccess, tempPassword: f['tempPassword'].value
        });
      }
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

function openResetModal(uid) {
  showFormModal({
    title: 'Reset Password',
    sub: 'Sets a new temporary password; the user must change it on next login.',
    bodyHtml: `
      <form id="resetForm">
        <div class="form-field"><label>Temporary Password</label><input name="tempPassword" minlength="6" required></div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="resetCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="resetSaveBtn">Set Password</button>
        </div>
      </form>`
  });
  document.getElementById('resetCancelBtn').addEventListener('click', closeFormModal);
  document.getElementById('resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('resetSaveBtn');
    setButtonBusy(btn, true, 'Saving…');
    try {
      await fn('setTemporaryPassword')({ uid, tempPassword: e.target.elements['tempPassword'].value });
      toast('Temporary password set.');
      closeFormModal();
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      setButtonBusy(btn, false);
    }
  });
}

// -------------------------------------------------------------- Closing
async function renderClosing(panel) {
  const canEdit = hasRole('Municipal Accountant');
  const snap = await getDocs(collection(db, 'closedPeriods'));
  const rows = snap.docs.map((d) => d.data()).sort((a, b) => String(b.period).localeCompare(String(a.period)));

  panel.innerHTML = `
    ${canEdit ? `<div class="inline-actions" style="margin-bottom:14px;"><button class="btn-primary" id="closeMonthBtn">Close a Month</button></div>` : ''}
    <div id="closingTableWrap"></div>`;
  document.getElementById('closingTableWrap').innerHTML = renderTable([
    { label: 'Fund', render: (r) => `<span class="fund-tag">${escapeHtml(r.fund)}</span>` },
    { label: 'Period', render: (r) => escapeHtml(r.period) },
    { label: 'Closed By', render: (r) => escapeHtml(r.closedBy) },
    { label: 'Closed At', render: (r) => escapeHtml((r.closedAt || '').slice(0, 10)) },
    {
      label: '', render: (r) => canEdit
        ? `<div class="list-actions"><button class="btn-ghost reopen-btn" data-fund="${escapeHtml(r.fundKey)}" data-period="${escapeHtml(r.period)}">Reopen</button></div>`
        : ''
    }
  ], rows, { emptyLabel: 'No periods have been closed yet.' });

  if (canEdit) {
    document.getElementById('closeMonthBtn').addEventListener('click', openCloseModal);
    panel.querySelectorAll('.reopen-btn').forEach((b) => b.addEventListener('click', async () => {
      if (!confirmAction(`Reopen ${b.dataset.period}?`)) return;
      try {
        await fn('reopenMonth')({ fund: b.dataset.fund, period: b.dataset.period });
        toast('Reopened.');
        render();
      } catch (e) { toast(errorMessage(e), true); }
    }));
  }
}

function openCloseModal() {
  showFormModal({
    title: 'Close a Month',
    sub: 'Blocks create/edit on Transactions dated in this Fund + Period for everyone except the Municipal Accountant.',
    bodyHtml: `
      <form id="closeForm">
        <div class="form-grid">
          <div class="form-field"><label>Fund</label><select name="fund">${FUND_LIST.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="form-field"><label>Period (YYYY-MM)</label><input name="period" value="${todayStr().slice(0, 7)}" pattern="\\d{4}-\\d{2}" required></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="closeCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="closeSaveBtn">Close</button>
        </div>
      </form>`
  });
  document.getElementById('closeCancelBtn').addEventListener('click', closeFormModal);
  document.getElementById('closeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('closeSaveBtn');
    setButtonBusy(btn, true, 'Closing…');
    const f = e.target.elements;
    try {
      await fn('closeMonth')({ fund: f['fund'].value, period: f['period'].value });
      toast('Period closed.');
      closeFormModal();
      render();
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      setButtonBusy(btn, false);
    }
  });
}

export function initSettingsPage() {
  registerPage('settings', render);
  document.getElementById('settingsSubnav').addEventListener('subnav-change', render);
  onFundChange(() => {
    if (document.getElementById('page-settings').classList.contains('active') && activeSub('settingsSubnav') === 'coa') render();
  });
}
