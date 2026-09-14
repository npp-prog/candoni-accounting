/**
 * App entry point — wires together auth, navigation, and every page
 * module. Loaded as a single ES module from index.html
 * (`<script type="module" src="js/app.js">`), so import order below is
 * also the module dependency graph; no bundler needed.
 */
import { initAuth, onAuthReady } from './auth.js';
import { initNav, goToPage } from './nav.js';
import { onUserChange } from './state.js';
import { initTransactionsPage } from './pages/transactions.js';
import { initBudgetPage } from './pages/budget.js';
import { initReportPage } from './pages/report.js';
import { initCreatePage } from './pages/create.js';
import { initSettingsPage } from './pages/settings.js';
import { initAuditLogPage } from './pages/auditlog.js';
import './pages/dashboard.js'; // self-registers its page loader on import

function updateUserChip(user) {
  document.getElementById('userName').textContent = user ? user.name || user.email : '';
  document.getElementById('userRole').textContent = user ? user.role || '' : '';
  document.getElementById('userAvatar').textContent = user && (user.name || user.email)
    ? (user.name || user.email).trim().charAt(0).toUpperCase()
    : '?';
}

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initTransactionsPage();
  initBudgetPage();
  initReportPage();
  initCreatePage();
  initSettingsPage();
  initAuditLogPage();

  onUserChange(updateUserChip);
  // Fires every time sign-in completes (including a page refresh while
  // already logged in) — (re)render whatever the active page is so a
  // freshly-authenticated session always shows current data.
  onAuthReady(() => goToPage('dashboard'));

  initAuth();
});
