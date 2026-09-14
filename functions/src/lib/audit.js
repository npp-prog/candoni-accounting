/**
 * Audit logging — one row per action, same shape as the old Audit_Log
 * sheet (Timestamp/User/Action/Module/Reference No./Details).
 */
const { db } = require('./admin');
const { FieldValue } = require('firebase-admin/firestore');

async function logAudit(auth, action, module, ref, details) {
  await db.collection('auditLog').add({
    timestamp: FieldValue.serverTimestamp(),
    user: (auth && (auth.name || auth.email)) || 'Unknown',
    userUid: (auth && auth.uid) || null,
    action,
    module,
    ref: ref || '',
    details: details || ''
  });
}

module.exports = { logAudit };
