import { setFund, currentFund } from './state.js';

const pageTitles = {
  dashboard: 'Dashboard', budget: 'Budget', transactions: 'Transactions',
  bankrecon: 'Bank Reconciliation',
  report: 'Report', create: 'Create', settings: 'Settings', auditlog: 'Audit Log'
};

const pageLoaders = {};
export function registerPage(key, loader) { pageLoaders[key] = loader; }

export function goToPage(key) {
  document.querySelectorAll('.nav-item[data-page]').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === key);
  });
  document.querySelectorAll('.page-content').forEach((el) => {
    el.classList.toggle('active', el.id === 'page-' + key);
  });
  document.getElementById('topbarTitle').textContent = pageTitles[key] || key;
  if (pageLoaders[key]) pageLoaders[key]();
}

export function initNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach((el) => {
    el.addEventListener('click', () => goToPage(el.dataset.page));
  });

  document.getElementById('fundSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fund]');
    if (!btn) return;
    document.querySelectorAll('#fundSwitch button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    setFund(btn.dataset.fund);
  });

  document.querySelectorAll('.subnav').forEach((nav) => {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-sub]');
      if (!btn) return;
      nav.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      nav.dispatchEvent(new CustomEvent('subnav-change', { detail: btn.dataset.sub }));
    });
  });
}

export function activeSub(navId) {
  const btn = document.querySelector(`#${navId} button.active`);
  return btn ? btn.dataset.sub : null;
}
