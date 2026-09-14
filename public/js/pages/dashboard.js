import { fn } from '../firebase-init.js';
import { currentFund, onFundChange } from '../state.js';
import { fmtMoney, TX_TYPE_LABEL } from '../constants.js';
import { renderTable, toast, errorMessage } from '../ui.js';
import { registerPage } from '../nav.js';

async function render() {
  const kpiEl = document.getElementById('dashboardKpis');
  const byTypeEl = document.getElementById('dashboardByType');
  kpiEl.innerHTML = '<div class="kpi"><div class="label">Loading…</div></div>';
  try {
    const { data } = await fn('getDashboardSummary')({ fund: currentFund() });
    kpiEl.innerHTML = `
      <div class="kpi"><div class="label">Pending</div><div class="value">${data.pending}</div>
        <div class="delta">${fmtMoney(data.pendingAmount)}</div></div>
      <div class="kpi"><div class="label">Approved</div><div class="value">${data.approved}</div>
        <div class="delta up">${fmtMoney(data.approvedAmount)}</div></div>
      <div class="kpi"><div class="label">Cancelled</div><div class="value">${data.cancelled}</div></div>
      <div class="kpi"><div class="label">JEVs Posted</div><div class="value">${data.jevCount}</div>
        <div class="delta">Dr/Cr ${fmtMoney(data.jevTotal)}</div></div>
    `;
    const rows = Object.keys(data.byType || {}).map((t) => ({ type: t, count: data.byType[t] }));
    byTypeEl.innerHTML = renderTable(
      [{ key: 'type', label: 'Type' }, { key: 'count', label: 'Count', num: true }],
      rows,
      { emptyLabel: 'No transactions recorded yet.' }
    );
  } catch (e) {
    kpiEl.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
    toast('Could not load dashboard: ' + errorMessage(e), true);
  }
}

registerPage('dashboard', render);
onFundChange(() => {
  if (document.getElementById('page-dashboard').classList.contains('active')) render();
});
