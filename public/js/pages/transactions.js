import {
  db, fn, collection, query, where, orderBy, getDocs,
  storage, storageRef, uploadBytes, getDownloadURL
} from '../firebase-init.js';
import { currentFund, onFundChange, hasRole } from '../state.js';
import {
  TX_TYPES, TX_TYPE_LABEL, FUND_LIST, FUND_NAMES, DV_CATEGORIES, DV_SUB_TYPES,
  fmtMoney, todayStr, escapeHtml
} from '../constants.js';
import { renderTable, statusPill, toast, errorMessage, showFormModal, closeFormModal, setButtonBusy, confirmAction } from '../ui.js';
import { registerPage, activeSub } from '../nav.js';
import { openJevModal } from './jev.js';

const ROLE_CAN_CREATE_TX = ['Municipal Accountant', 'Accounting Supervisor', 'Accounting Staff'];
const ROLE_CAN_EDIT_TX = ['Municipal Accountant', 'Accounting Supervisor'];

function currentTypeKey() {
  return activeSub('txSubnav') || 'disbursement_voucher';
}

function buildSubnavOnce() {
  const nav = document.getElementById('txSubnav');
  if (nav.dataset.built) return;
  nav.innerHTML = TX_TYPES.map(([key, label], i) =>
    `<button data-sub="${key}" class="${i === 0 ? 'active' : ''}">${label}</button>`
  ).join('');
  nav.dataset.built = '1';
  nav.addEventListener('subnav-change', renderList);
}

async function fetchTransactions(typeKey, fundKey) {
  const type = TX_TYPE_LABEL[typeKey];
  const clauses = [where('type', '==', type)];
  if (fundKey && fundKey !== 'all') clauses.push(where('fund', '==', FUND_NAMES[fundKey]));
  let q;
  try {
    q = query(collection(db, 'transactions'), ...clauses, orderBy('date', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // Composite index may not exist yet for fund+type+date — fall back to
    // an unordered query rather than hard-failing the page.
    q = query(collection(db, 'transactions'), ...clauses);
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }
}

async function renderList() {
  buildSubnavOnce();
  const typeKey = currentTypeKey();
  const panel = document.getElementById('txPanel');
  panel.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const rows = await fetchTransactions(typeKey, currentFund());
    const canEdit = hasRole(...ROLE_CAN_EDIT_TX);
    panel.innerHTML = renderTable([
      { label: 'Date', key: 'date' },
      { label: 'Ref No.', render: (r) => escapeHtml(r.primaryRefNo) },
      { label: 'Fund', render: (r) => `<span class="fund-tag">${escapeHtml(r.fund)}</span>` },
      { label: 'Name', render: (r) => escapeHtml(r.name) },
      { label: 'Particulars', render: (r) => escapeHtml(r.particulars) },
      { label: 'Gross', num: true, render: (r) => fmtMoney(r.grossAmount) },
      { label: 'Net', num: true, render: (r) => fmtMoney(r.netAmount) },
      { label: 'Status', render: (r) => statusPill(r.status) },
      { label: 'JEV', render: (r) => r.jevNo ? escapeHtml(r.jevNo) : '<span class="muted">—</span>' },
      {
        label: 'File', render: (r) => r.attachmentUrl
          ? `<a href="${escapeHtml(r.attachmentUrl)}" target="_blank" rel="noopener">View PDF</a>`
          : '<span class="muted">—</span>'
      },
      {
        label: '', render: (r) => {
          const btns = [];
          if (canEdit && r.status === 'Pending') {
            btns.push(`<button class="btn-ghost approve-btn" data-id="${r.id}">Approve</button>`);
            btns.push(`<button class="btn-danger cancel-btn" data-id="${r.id}">Cancel</button>`);
          }
          if (canEdit && r.status === 'Approved' && !r.jevNo) {
            btns.push(`<button class="btn-secondary post-jev-btn" data-id="${r.id}">Post JEV</button>`);
          }
          return `<div class="list-actions">${btns.join('')}</div>`;
        }
      }
    ], rows, { emptyLabel: `No ${TX_TYPE_LABEL[typeKey]} records yet.` });

    panel.querySelectorAll('.approve-btn').forEach((b) => b.addEventListener('click', () => setStatus(b.dataset.id, 'Approved')));
    panel.querySelectorAll('.cancel-btn').forEach((b) => b.addEventListener('click', () => {
      if (confirmAction('Cancel this transaction?')) setStatus(b.dataset.id, 'Cancelled');
    }));
    panel.querySelectorAll('.post-jev-btn').forEach((b) => b.addEventListener('click', () => {
      const row = rows.find((r) => r.id === b.dataset.id);
      openJevModal({ sourceType: row.type, sourceRef: row.primaryRefNo, fundKey: Object.keys(FUND_NAMES).find((k) => FUND_NAMES[k] === row.fund) }, renderList);
    }));
  } catch (e) {
    panel.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
  }
}

async function setStatus(docId, status) {
  try {
    await fn('updateTransactionStatus')({ docId, status });
    toast('Status updated.');
    renderList();
  } catch (e) {
    toast(errorMessage(e), true);
  }
}

function typeSpecificFieldsHtml(typeKey) {
  let html = '';
  if (typeKey === 'disbursement_voucher') {
    html += `<div class="form-field"><label>DV Type</label><select id="txSubType">${DV_SUB_TYPES.map((s) => `<option>${s}</option>`).join('')}</select></div>`;
    html += `<div class="form-field"><label>DV Category</label><select id="txDvCategory"><option value="">—</option>${DV_CATEGORIES.map((s) => `<option>${s}</option>`).join('')}</select></div>`;
  }
  if (['check', 'ada', 'liquidation'].includes(typeKey)) {
    html += `<div class="form-field"><label>Secondary Ref No. (DV No.)</label><input id="txSecondaryRef"></div>`;
  }
  if (typeKey === 'collections_deposit') {
    html += `<div class="form-field"><label>Collector</label><input id="txCollector"></div>`;
  }
  if (typeKey === 'check') {
    html += `<div class="form-field"><label>Primary Ref No. (manual)</label><input id="txPrimaryRefManual" required></div>`;
  } else {
    html += `<div class="form-field"><label>Primary Ref No.</label><input id="txPrimaryRefManual" placeholder="Auto-generated if left blank"></div>`;
  }
  if (typeKey === 'disbursement_voucher') {
    html += `<div class="form-field span2"><label>Attach Disbursement Voucher (PDF, optional)</label><input type="file" id="txDvFile" accept="application/pdf"></div>`;
  }
  return html;
}

function openNewTransactionModal() {
  const typeKey = currentTypeKey();
  const label = TX_TYPE_LABEL[typeKey];
  showFormModal({
    title: `New ${label}`,
    sub: 'Basic information — all fields required unless noted.',
    wide: true,
    bodyHtml: `
      <form id="txForm">
        <div class="form-grid">
          <div class="form-field"><label>Date</label><input type="date" id="txDate" value="${todayStr()}" required></div>
          <div class="form-field"><label>Fund</label><select id="txFund">${FUND_LIST.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="form-field"><label>Office</label><input id="txOffice"></div>
          <div class="form-field span2"><label>Name (Payee/Payor)</label><input id="txName"></div>
          <div class="form-field"><label>Email Address</label><input type="email" id="txEmail"></div>
          <div class="form-field span3"><label>Particulars</label><input id="txParticulars" required></div>
          ${typeSpecificFieldsHtml(typeKey)}
          <div class="form-field"><label>Gross Amount</label><input type="number" step="0.01" id="txGross" value="0" required></div>
          <div class="form-field"><label>Withholding Tax</label><input type="number" step="0.01" id="txWtax" value="0"></div>
          <div class="form-field"><label>Other Deductions</label><input type="number" step="0.01" id="txOther" value="0"></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="txCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="txSaveBtn">Save Transaction</button>
        </div>
      </form>
    `
  });

  document.getElementById('txCancelBtn').addEventListener('click', closeFormModal);
  document.getElementById('txForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('txSaveBtn');
    setButtonBusy(btn, true, 'Saving…');

    let attachmentUrl = '';
    let attachmentName = '';
    const fileInput = document.getElementById('txDvFile');
    if (fileInput && fileInput.files && fileInput.files[0]) {
      const file = fileInput.files[0];
      if (file.type !== 'application/pdf') {
        toast('Attachment must be a PDF file.', true);
        setButtonBusy(btn, false);
        return;
      }
      if (file.size > 15 * 1024 * 1024) {
        toast('Attachment must be under 15 MB.', true);
        setButtonBusy(btn, false);
        return;
      }
      try {
        setButtonBusy(btn, true, 'Uploading PDF…');
        const fundKey = document.getElementById('txFund').value;
        const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
        const path = `dv-attachments/${fundKey}/${Date.now()}-${safeName}`;
        const sref = storageRef(storage, path);
        await uploadBytes(sref, file, { contentType: 'application/pdf' });
        attachmentUrl = await getDownloadURL(sref);
        attachmentName = file.name;
      } catch (err) {
        toast('PDF upload failed: ' + errorMessage(err), true);
        setButtonBusy(btn, false);
        return;
      }
    }

    const payload = {
      date: document.getElementById('txDate').value,
      fund: document.getElementById('txFund').value,
      office: document.getElementById('txOffice').value,
      name: document.getElementById('txName').value,
      emailAddress: document.getElementById('txEmail').value,
      particulars: document.getElementById('txParticulars').value,
      grossAmount: document.getElementById('txGross').value,
      wtax: document.getElementById('txWtax').value,
      otherDeductions: document.getElementById('txOther').value,
      primaryRefNo: document.getElementById('txPrimaryRefManual') ? document.getElementById('txPrimaryRefManual').value : '',
      attachmentUrl,
      attachmentName
    };
    if (document.getElementById('txSubType')) payload.subType = document.getElementById('txSubType').value;
    if (document.getElementById('txDvCategory')) payload.dvCategory = document.getElementById('txDvCategory').value;
    if (document.getElementById('txSecondaryRef')) payload.secondaryRefNo = document.getElementById('txSecondaryRef').value;
    if (document.getElementById('txCollector')) payload.collector = document.getElementById('txCollector').value;

    try {
      const { data } = await fn('saveTransaction')({ typeKey, payload });
      toast(`Saved as ${data.refNo}.`);
      closeFormModal();
      renderList();
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setButtonBusy(btn, false);
    }
  });
}

export function initTransactionsPage() {
  registerPage('transactions', renderList);
  onFundChange(() => {
    if (document.getElementById('page-transactions').classList.contains('active')) renderList();
  });
  document.getElementById('newTransactionBtn').addEventListener('click', () => {
    if (!hasRole(...ROLE_CAN_CREATE_TX)) {
      toast('Your role cannot create transactions.', true);
      return;
    }
    openNewTransactionModal();
  });
}
