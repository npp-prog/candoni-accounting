/**
 * Audit Log page — every create/edit/status-change/JEV-post/login/logout,
 * newest first. Municipal Accountant only, matching the Firestore rule
 * `match /auditLog/{docId} { allow read: if isAccountant(); }`.
 */
import { db, collection, query, orderBy, limit, getDocs } from '../firebase-init.js';
import { hasRole } from '../state.js';
import { escapeHtml } from '../constants.js';
import { renderTable, errorMessage } from '../ui.js';
import { registerPage } from '../nav.js';

async function render() {
  const panel = document.getElementById('auditLogPanel');
  if (!hasRole('Municipal Accountant')) {
    panel.innerHTML = '<div class="readonly-note">The Audit Log is visible to the Municipal Accountant only.</div>';
    return;
  }
  panel.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const snap = await getDocs(query(collection(db, 'auditLog'), orderBy('timestamp', 'desc'), limit(300)));
    const rows = snap.docs.map((d) => d.data());
    panel.innerHTML = renderTable([
      { label: 'Timestamp', render: (r) => r.timestamp && r.timestamp.toDate ? r.timestamp.toDate().toLocaleString() : '' },
      { label: 'User', render: (r) => escapeHtml(r.user) },
      { label: 'Action', render: (r) => escapeHtml(r.action) },
      { label: 'Module', render: (r) => escapeHtml(r.module) },
      { label: 'Reference No.', render: (r) => escapeHtml(r.ref) },
      { label: 'Details', render: (r) => escapeHtml(r.details) }
    ], rows, { emptyLabel: 'Nothing logged yet.' });
  } catch (e) {
    panel.innerHTML = `<div class="empty-state">${errorMessage(e)}</div>`;
  }
}

export function initAuditLogPage() {
  registerPage('auditlog', render);
}
