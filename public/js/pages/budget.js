/**
 * Budget page — Budget Allotment (Appropriation/Allotment/Supplemental/
 * Augmentation), Obligation Requests, and a read-only Reference Log.
 * Ported from the Budget module of Code.gs / dashboard.html, backed by
 * functions/src/budget.js (saveBudgetLine, saveObligationRequest,
 * saveObligationRequestBatch).
 */
import { db, fn, collection, getDocs, query, where, orderBy, limit } from '../firebase-init.js';
import { currentFund, onFundChange, hasRole } from '../state.js';
import { FUND_LIST, FUND_NAMES, fmtMoney, todayStr, escapeHtml, OBR_STATUSES } from '../constants.js';
import { renderTable, statusPill, toast, errorMessage, showFormModal, closeFormModal, setButtonBusy } from '../ui.js';
import { registerPage, activeSub } from '../nav.js';

const ROLE_CAN_ENCODE_BUDGET = ['Municipal Accountant', 'Budget Officer', 'Budget Staff'];
const ALLOTMENT_CLASSES = ['PS', 'MOOE', 'CO'];

function fundFilterClauses() {
  const f = currentFund();
  return f && f !== 'all' ? [where('fundKey', '==', f)] : [];
}

async function render() {
  const sub = activeSub('budgetSubnav') || 'allotment';
  const panel = document.getElementById('budgetPanel');
  panel.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    if (sub === 'allotment') await renderAllotment(panel);
    else if (sub === 'obligation') await renderObligations(panel);
    else await renderRefLog(panel);
  } catch (e) {
    panel.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
  }
}

async function renderAllotment(panel) {
  const [linesSnap, obrSnap] = await Promise.all([
    getDocs(query(collection(db, 'budgetLines'), ...fundFilterClauses())),
    getDocs(query(collection(db, 'obligationRequests'), ...fundFilterClauses()))
  ]);
  const lines = linesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const obrs = obrSnap.docs.map((d) => d.data()).filter((o) => o.status !== 'Cancelled');

  const obligatedFor = (line) => obrs
    .filter((o) => o.fund === line.fund && (o.officeFunctionCode || '') === (line.officeFunctionCode || '')
      && (o.fpp || '') === (line.fppCode || '') && (o.allotmentClass || '') === (line.allotmentClass || ''))
    .reduce((s, o) => s + (Number(o.amount) || 0), 0);

  const canEdit = hasRole(...ROLE_CAN_ENCODE_BUDGET);
  const rows = lines.map((l) => {
    const totalAppropriation = (Number(l.annualAppropriation) || 0) + (Number(l.continuingAppropriations) || 0) + (Number(l.supplemental) || 0);
    const allotted = (Number(l.allotment) || 0) + (Number(l.augmentation) || 0);
    const obligated = obligatedFor(l);
    return { ...l, totalAppropriation, allotted, obligated, balance: allotted - obligated };
  });

  panel.innerHTML = `
    ${canEdit ? `<div class="inline-actions" style="margin-bottom:14px;"><button class="btn-primary" id="budgetEncodeBtn">+ Encode</button></div>` : ''}
    <div id="budgetTableWrap"></div>`;
  document.getElementById('budgetTableWrap').innerHTML = renderTable([
    { label: 'Fund', render: (r) => `<span class="fund-tag">${escapeHtml(r.fund)}</span>` },
    { label: 'Office/Fn Code', render: (r) => escapeHtml(r.officeFunctionCode) },
    { label: 'FPP', render: (r) => escapeHtml(r.fppCode) + (r.fppName ? ' — ' + escapeHtml(r.fppName) : '') },
    { label: 'Class', render: (r) => escapeHtml(r.allotmentClass) },
    { label: 'Total Appropriation', num: true, render: (r) => fmtMoney(r.totalAppropriation) },
    { label: 'Allotment+Augment.', num: true, render: (r) => fmtMoney(r.allotted) },
    { label: 'Obligated', num: true, render: (r) => fmtMoney(r.obligated) },
    { label: 'Balance', num: true, render: (r) => fmtMoney(r.balance) }
  ], rows, { emptyLabel: 'No budget lines encoded yet.' });

  if (canEdit) document.getElementById('budgetEncodeBtn').addEventListener('click', () => openEncodeModal(() => render()));
}

function encodeActionFields(action) {
  if (action === 'allotment') return `<div class="form-field"><label>Allotment Order No.</label><input name="allotmentOrderNo" required></div>`;
  if (action === 'augmentation') return `<div class="form-field"><label>Augmentation Order No.</label><input name="augmentationOrderNo" required></div>`;
  return `<div class="form-field"><label>Municipal Ordinance No.</label><input name="ordinanceNo" required></div>`;
}

function openEncodeModal(onSaved) {
  showFormModal({
    title: 'Encode Budget',
    sub: 'Appropriation, Allotment, Supplemental or Augmentation for one Fund + Office/Function Code + FPP Code + Allotment Class line.',
    wide: true,
    bodyHtml: `
      <form id="budgetForm">
        <div class="form-grid">
          <div class="form-field"><label>Fund</label><select name="fund">${FUND_LIST.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="form-field"><label>Office/Function Code</label><input name="officeFunctionCode" required></div>
          <div class="form-field"><label>FPP Code</label><input name="fppCode"></div>
          <div class="form-field"><label>FPP Name</label><input name="fppName"></div>
          <div class="form-field"><label>Allotment Class</label><select name="allotmentClass">${ALLOTMENT_CLASSES.map((c) => `<option>${c}</option>`).join('')}</select></div>
          <div class="form-field"><label>Sector</label><input name="sector"></div>
          <div class="form-field span2"><label>Notes</label><input name="notes"></div>
          <div class="form-field"><label>Action</label>
            <select id="budgetAction">
              <option value="annualAppropriation">General Appropriation</option>
              <option value="continuingAppropriation">Continuing Appropriation</option>
              <option value="supplemental">Supplemental Appropriation</option>
              <option value="allotment">Allotment</option>
              <option value="augmentation">Augmentation</option>
            </select>
          </div>
          <div class="form-field"><label>Amount</label><input name="amount" type="number" step="0.01" required></div>
          <div id="budgetActionFieldWrap">${encodeActionFields('annualAppropriation')}</div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="budgetCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="budgetSaveBtn">Save</button>
        </div>
      </form>`
  });

  document.getElementById('budgetAction').addEventListener('change', (e) => {
    document.getElementById('budgetActionFieldWrap').innerHTML = encodeActionFields(e.target.value);
  });
  document.getElementById('budgetCancelBtn').addEventListener('click', closeFormModal);
  document.getElementById('budgetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('budgetSaveBtn');
    setButtonBusy(btn, true, 'Saving…');
    const form = e.target;
    const action = document.getElementById('budgetAction').value;
    const amount = Number(form.elements['amount'].value) || 0;
    const payload = {
      fund: form.elements['fund'].value,
      officeFunctionCode: form.elements['officeFunctionCode'].value,
      fppCode: form.elements['fppCode'].value,
      fppName: form.elements['fppName'].value,
      allotmentClass: form.elements['allotmentClass'].value,
      sector: form.elements['sector'].value,
      notes: form.elements['notes'].value,
      [action]: amount
    };
    if (form.elements['ordinanceNo']) payload.ordinanceNo = form.elements['ordinanceNo'].value;
    if (form.elements['allotmentOrderNo']) payload.allotmentOrderNo = form.elements['allotmentOrderNo'].value;
    if (form.elements['augmentationOrderNo']) payload.augmentationOrderNo = form.elements['augmentationOrderNo'].value;
    if (action === 'allotment' || action === 'augmentation') payload.editingExistingAmount = true;

    try {
      await fn('saveBudgetLine')(payload);
      toast('Budget line saved.');
      closeFormModal();
      onSaved();
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      setButtonBusy(btn, false);
    }
  });
}

async function renderObligations(panel) {
  const canEdit = hasRole(...ROLE_CAN_ENCODE_BUDGET);
  const snap = await getDocs(query(collection(db, 'obligationRequests'), ...fundFilterClauses()));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  panel.innerHTML = `
    ${canEdit ? `<div class="inline-actions" style="margin-bottom:14px;"><button class="btn-primary" id="obrNewBtn">+ New Obligation Request</button></div>` : ''}
    <div id="obrTableWrap"></div>`;
  document.getElementById('obrTableWrap').innerHTML = renderTable([
    { label: 'OBR No.', render: (r) => escapeHtml(r.obrNo) },
    { label: 'Date', key: 'date' },
    { label: 'Fund', render: (r) => `<span class="fund-tag">${escapeHtml(r.fund)}</span>` },
    { label: 'Office', render: (r) => escapeHtml(r.office) },
    { label: 'FPP', render: (r) => escapeHtml(r.fpp) },
    { label: 'Payee', render: (r) => escapeHtml(r.payee) },
    { label: 'Particulars', render: (r) => escapeHtml(r.particulars) },
    { label: 'Amount', num: true, render: (r) => fmtMoney(r.amount) },
    { label: 'Status', render: (r) => statusPill(r.status) },
    { label: 'JEV', render: (r) => r.jevNo ? escapeHtml(r.jevNo) : '<span class="muted">—</span>' }
  ], rows, { emptyLabel: 'No Obligation Requests yet.' });

  if (canEdit) document.getElementById('obrNewBtn').addEventListener('click', () => openObrModal(() => render()));
}

function openObrModal(onSaved) {
  showFormModal({
    title: 'New Obligation Request',
    wide: true,
    bodyHtml: `
      <form id="obrForm">
        <div class="form-grid">
          <div class="form-field"><label>OBR No.</label><input name="obrNo" placeholder="Auto-generated if left blank"></div>
          <div class="form-field"><label>Date</label><input type="date" name="date" value="${todayStr()}" required></div>
          <div class="form-field"><label>Fund</label><select name="fund">${FUND_LIST.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="form-field"><label>Office</label><input name="office"></div>
          <div class="form-field"><label>FPP Code</label><input name="fpp"></div>
          <div class="form-field"><label>Office/Function Code</label><input name="officeFunctionCode"></div>
          <div class="form-field"><label>Account Code</label><input name="accountCode"></div>
          <div class="form-field"><label>Allotment Class</label><select name="allotmentClass">${ALLOTMENT_CLASSES.map((c) => `<option>${c}</option>`).join('')}</select></div>
          <div class="form-field"><label>Sector</label><input name="sector"></div>
          <div class="form-field span2"><label>Payee</label><input name="payee"></div>
          <div class="form-field span3"><label>Particulars</label><input name="particulars" required></div>
          <div class="form-field"><label>Amount</label><input name="amount" type="number" step="0.01" required></div>
          <div class="form-field"><label>Status</label><select name="status">${OBR_STATUSES.map((s) => `<option>${s}</option>`).join('')}</select></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="obrCancelBtn">Cancel</button>
          <button type="submit" class="btn-primary" id="obrSaveBtn">Save</button>
        </div>
      </form>`
  });
  document.getElementById('obrCancelBtn').addEventListener('click', closeFormModal);
  document.getElementById('obrForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('obrSaveBtn');
    setButtonBusy(btn, true, 'Saving…');
    const f = e.target.elements;
    try {
      const { data } = await fn('saveObligationRequest')({
        obrNo: f['obrNo'].value, date: f['date'].value, fund: f['fund'].value, office: f['office'].value,
        fpp: f['fpp'].value, officeFunctionCode: f['officeFunctionCode'].value, accountCode: f['accountCode'].value,
        allotmentClass: f['allotmentClass'].value, sector: f['sector'].value, payee: f['payee'].value,
        particulars: f['particulars'].value, amount: f['amount'].value, status: f['status'].value
      });
      toast(`Saved as ${data.obrNo}.`);
      closeFormModal();
      onSaved();
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      setButtonBusy(btn, false);
    }
  });
}

async function renderRefLog(panel) {
  const snap = await getDocs(query(collection(db, 'budgetReferenceLog'), orderBy('createdAt', 'desc'), limit(200)));
  const rows = snap.docs.map((d) => d.data());
  panel.innerHTML = renderTable([
    { label: 'Reference No.', render: (r) => escapeHtml(r.referenceNo) },
    { label: 'Module', render: (r) => escapeHtml(r.module) },
    { label: 'Fund', render: (r) => `<span class="fund-tag">${escapeHtml(r.fund)}</span>` },
    { label: 'Amount', num: true, render: (r) => fmtMoney(r.amount) }
  ], rows, { emptyLabel: 'No budget reference activity yet.' });
}

export function initBudgetPage() {
  registerPage('budget', render);
  document.getElementById('budgetSubnav').addEventListener('subnav-change', render);
  onFundChange(() => {
    if (document.getElementById('page-budget').classList.contains('active')) render();
  });
}
