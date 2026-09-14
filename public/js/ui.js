// Small shared UI helpers: toast notifications and the one generic form
// modal every page reuses (see #formModalOverlay in index.html).

export function toast(message, isError) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', !!isError);
  el.classList.add('shown');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('shown'), 3600);
}

export function showFormModal({ title, sub, bodyHtml, wide }) {
  document.getElementById('formModalTitle').textContent = title || 'Form';
  document.getElementById('formModalSub').textContent = sub || '';
  document.getElementById('formModalBody').innerHTML = bodyHtml || '';
  document.getElementById('formModalBox').style.width = wide ? '900px' : '620px';
  document.getElementById('formModalOverlay').classList.add('shown');
}

export function closeFormModal() {
  document.getElementById('formModalOverlay').classList.remove('shown');
  document.getElementById('formModalBody').innerHTML = '';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('formModalCloseX').addEventListener('click', closeFormModal);
  document.getElementById('formModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'formModalOverlay') closeFormModal();
  });
});

export function errorMessage(e) {
  // Firebase callable errors carry the thrown HttpsError message in e.message
  return (e && e.message) ? e.message.replace(/^Firebase: /, '') : 'Something went wrong.';
}

// columns: [{key, label, num, render(row)}]
export function renderTable(columns, rows, opts) {
  opts = opts || {};
  if (!rows || !rows.length) {
    return `<div class="empty-state">${opts.emptyLabel || 'Nothing here yet.'}</div>`;
  }
  const thead = columns.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.label}</th>`).join('');
  const body = rows.map((row) => {
    const tds = columns.map((c) => {
      const val = c.render ? c.render(row) : (row[c.key] ?? '');
      return `<td${c.num ? ' class="num"' : ''}>${val}</td>`;
    }).join('');
    return `<tr${opts.rowAttrs ? ' ' + opts.rowAttrs(row) : ''}>${tds}</tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="data"><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function statusPill(status) {
  const cls = String(status || '').toLowerCase();
  return `<span class="pill ${cls}">${status || ''}</span>`;
}

export function confirmAction(message) {
  return window.confirm(message);
}

export function setButtonBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    btn.dataset.origLabel = btn.dataset.origLabel || btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-inline"></span>${busyLabel || 'Working…'}`;
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.origLabel || btn.textContent;
  }
}
