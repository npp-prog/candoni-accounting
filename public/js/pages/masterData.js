/**
 * Generic master-data list/form renderer shared by the Create module
 * (Name/Bank Account) and the Settings module (Office/FPP) — both are a
 * thin CRUD layer over the createNames/createBankAccount/createOffice/
 * createFpp collections via the same saveCreateRecord/deleteCreateRecord
 * callables (see functions/src/masterData.js). Ported from CREATE_TYPES /
 * SETTINGS_CREATE_TYPES in Code.gs: same fields, same field types, just
 * driven from a JS config instead of a spreadsheet-backed generic form.
 *
 * Subsidiary Ledger Accounts is NOT one of these — like the original, it
 * has its own dedicated form (Name/Account Code pickers, composite key)
 * and lives in create.js.
 */
import { db, fn, collection, getDocs, orderBy, query } from '../firebase-init.js';
import { hasRole } from '../state.js';
import { escapeHtml, fmtMoney, CREATE_LISTS, CREATE_KEY_FIELD } from '../constants.js';
import { renderTable, toast, errorMessage, showFormModal, closeFormModal, setButtonBusy, confirmAction } from '../ui.js';

// field: { k: camelCase field name, label, t: 'text'|'number'|'select'|'multiselect', opts?, span? }
export const FIELD_DEFS = {
  names: [
    { k: 'name', label: 'Name', t: 'text' },
    { k: 'type', label: 'Type', t: 'select', opts: ['Payee', 'Payor', 'Depositor', 'Creditor', 'Employee', 'Collector'] },
    { k: 'tin', label: 'TIN', t: 'text' },
    { k: 'address', label: 'Address', t: 'text', span: 2 },
    { k: 'contactNo', label: 'Contact No.', t: 'text' },
    { k: 'email', label: 'Email', t: 'text' },
    { k: 'status', label: 'Status', t: 'select', opts: ['Active', 'Inactive'] },
    { k: 'office', label: 'Office', t: 'text' },
    { k: 'position', label: 'Position', t: 'text' },
    { k: 'employeeNo', label: 'Employee No.', t: 'text' },
    { k: 'agingCategory', label: 'Aging Category', t: 'text' },
    { k: 'designation', label: 'Designation', t: 'text' },
    { k: 'bondNo', label: 'Bond No.', t: 'text' },
    { k: 'authorizedRoles', label: 'Authorized Roles', t: 'multiselect', opts: ['Collector', 'Depositor', 'Payroll Officer', 'Special Disbursing Officer'], span: 2 },
    { k: 'payrollOfficerCode', label: 'Payroll Officer Code', t: 'text' },
    { k: 'beginningBalance', label: 'Beginning Balance', t: 'number' }
  ],
  bankAccount: [
    { k: 'bankName', label: 'Bank Name', t: 'text' },
    { k: 'accountNo', label: 'Account No.', t: 'text' },
    { k: 'accountName', label: 'Account Name', t: 'text', span: 2 },
    { k: 'fund', label: 'Fund', t: 'select', opts: ['General Fund', 'Special Education Fund', 'Trust Fund'] },
    { k: 'branch', label: 'Branch', t: 'text' },
    { k: 'status', label: 'Status', t: 'select', opts: ['Active', 'Inactive'] }
  ],
  office: [
    { k: 'officeCode', label: 'Office Code', t: 'text' },
    { k: 'officeName', label: 'Office Name', t: 'text', span: 2 },
    { k: 'headOfOffice', label: 'Head of Office', t: 'text' },
    { k: 'email', label: 'Email', t: 'text' }
  ],
  fpp: [
    { k: 'fppCode', label: 'FPP Code', t: 'text' },
    { k: 'fppName', label: 'Function/Project/Program Name', t: 'text', span: 2 },
    { k: 'fund', label: 'Fund', t: 'select', opts: ['General Fund', 'Special Education Fund', 'Trust Fund'] },
    { k: 'office', label: 'Office', t: 'text' },
    { k: 'status', label: 'Status', t: 'select', opts: ['Active', 'Inactive'] },
    { k: 'year', label: 'Year (leave blank to never lapse)', t: 'text' }
  ]
};

export const LIST_TITLES = {
  names: 'Name (Database)', bankAccount: 'Bank Account', office: 'Office', fpp: 'FPP'
};

function fieldHtml(f, row) {
  const val = row ? (row[f.k] ?? '') : '';
  const span = f.span === 2 ? ' span2' : f.span === 3 ? ' span3' : '';
  if (f.t === 'select') {
    return `<div class="form-field${span}"><label>${escapeHtml(f.label)}</label><select name="${f.k}">
      <option value="">—</option>${f.opts.map((o) => `<option value="${escapeHtml(o)}" ${val === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
    </select></div>`;
  }
  if (f.t === 'multiselect') {
    const chosen = Array.isArray(val) ? val : [];
    return `<div class="form-field${span}"><label>${escapeHtml(f.label)}</label>
      <div class="checkbox-row" style="flex-wrap:wrap; gap:10px;">
        ${f.opts.map((o) => `<label style="display:flex; align-items:center; gap:5px; font-weight:400;">
          <input type="checkbox" name="${f.k}" value="${escapeHtml(o)}" ${chosen.includes(o) ? 'checked' : ''}> ${escapeHtml(o)}</label>`).join('')}
      </div></div>`;
  }
  const type = f.t === 'number' ? 'number' : 'text';
  const step = f.t === 'number' ? ' step="0.01"' : '';
  return `<div class="form-field${span}"><label>${escapeHtml(f.label)}</label><input name="${f.k}" type="${type}"${step} value="${escapeHtml(val)}"></div>`;
}

function readForm(fields, form) {
  const payload = {};
  fields.forEach((f) => {
    if (f.t === 'multiselect') {
      payload[f.k] = Array.from(form.querySelectorAll(`input[name="${f.k}"]:checked`)).map((el) => el.value);
    } else if (f.t === 'number') {
      payload[f.k] = Number(form.elements[f.k].value) || 0;
    } else {
      payload[f.k] = form.elements[f.k].value;
    }
  });
  return payload;
}

function openRecordModal(key, row, onSaved) {
  const fields = FIELD_DEFS[key];
  const keyField = CREATE_KEY_FIELD[key];
  showFormModal({
    title: row ? `Edit ${LIST_TITLES[key]}` : `New ${LIST_TITLES[key]}`,
    wide: true,
    bodyHtml: `
      <form id="mdForm">
        <div class="form-grid">${fields.map((f) => fieldHtml(f, row)).join('')}</div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="mdCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="mdSaveBtn">Save</button>
        </div>
      </form>`
  });
  document.getElementById('mdCancelBtn').addEventListener('click', closeFormModal);
  document.getElementById('mdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('mdSaveBtn');
    setButtonBusy(btn, true, 'Saving…');
    try {
      const payload = readForm(fields, e.target);
      if (!payload[keyField]) throw new Error(`${fields.find((f) => f.k === keyField).label} is required.`);
      await fn('saveCreateRecord')({ key, payload });
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

async function deleteRecord(key, keyValue, onDone) {
  if (!confirmAction(`Delete "${keyValue}"? This cannot be undone.`)) return;
  try {
    await fn('deleteCreateRecord')({ key, keyValue });
    toast('Deleted.');
    onDone();
  } catch (e) {
    toast(errorMessage(e), true);
  }
}

// Renders a full master-data section (heading + table + add button) into
// `panelEl` for the given key. `canEditRoles` gates Add/Edit/Delete —
// viewers still see the list.
export async function renderMasterDataList(panelEl, key, canEditRoles) {
  const fields = FIELD_DEFS[key];
  const keyField = CREATE_KEY_FIELD[key];
  const canEdit = hasRole(...canEditRoles);
  panelEl.innerHTML = '<div class="empty-state">Loading…</div>';
  let rows;
  try {
    const snap = await getDocs(query(collection(db, CREATE_LISTS[key]), orderBy(keyField)));
    rows = snap.docs.map((d) => d.data());
  } catch (e) {
    panelEl.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
    return;
  }

  const columns = fields
    .filter((f) => f.t !== 'multiselect')
    .map((f) => ({
      label: f.label,
      num: f.t === 'number',
      render: (r) => f.t === 'number' ? fmtMoney(r[f.k]) : escapeHtml(r[f.k])
    }));
  columns.push({
    label: '', render: (r) => canEdit
      ? `<div class="list-actions">
          <button class="btn-ghost md-edit-btn" data-key="${escapeHtml(r[keyField])}">Edit</button>
          <button class="btn-danger md-del-btn" data-key="${escapeHtml(r[keyField])}">Delete</button>
        </div>`
      : ''
  });

  const refresh = () => renderMasterDataList(panelEl, key, canEditRoles);
  panelEl.innerHTML = `
    ${canEdit ? `<div class="inline-actions" style="margin-bottom:14px;"><button class="btn-primary" id="mdAddBtn">+ New ${LIST_TITLES[key]}</button></div>` : ''}
    <div id="mdTableWrap"></div>
  `;
  document.getElementById('mdTableWrap').innerHTML = renderTable(columns, rows, { emptyLabel: `No ${LIST_TITLES[key]} records yet.` });

  if (canEdit) {
    document.getElementById('mdAddBtn').addEventListener('click', () => openRecordModal(key, null, refresh));
    panelEl.querySelectorAll('.md-edit-btn').forEach((b) => b.addEventListener('click', () => {
      const row = rows.find((r) => String(r[keyField]) === b.dataset.key);
      openRecordModal(key, row, refresh);
    }));
    panelEl.querySelectorAll('.md-del-btn').forEach((b) => b.addEventListener('click', () => deleteRecord(key, b.dataset.key, refresh)));
  }
}
