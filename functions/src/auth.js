/**
 * Auth & System Access module.
 *
 * Login/logout/password-entry themselves are handled client-side by the
 * Firebase Auth JS SDK (signInWithEmailAndPassword, signOut, and a
 * reauthenticate+updatePassword pair for password changes) — Firebase
 * already does password hashing/session/token issuance for us, so none of
 * that needs reimplementing the way the Apps Script version had to
 * (CacheService sessions, hand-rolled SHA-256). What's left here is:
 *   - keeping each user's role/fundAccess/status mirrored from their
 *     `users/{uid}` Firestore profile onto their Firebase Auth custom
 *     claims (so callables and Security Rules can trust request.auth.token
 *     without an extra Firestore read on every call)
 *   - a public, write-protected username -> email lookup so people can
 *     still log in with a Username the way the original did (Firebase Auth
 *     itself only knows email addresses)
 *   - the admin-only user management actions (create/update/deactivate,
 *     issue a temporary password) — these touch Firebase Auth itself, which
 *     only the Admin SDK can do, so they must be callables
 *   - clearing the "must change password" flag once a user has set their
 *     own permanent password
 *   - audit-logging login/logout, since those never go through a callable
 *     otherwise
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { admin, db } = require('./lib/admin');
const { requireRole, requireAuth } = require('./lib/roles');
const { logAudit } = require('./lib/audit');
const { ROLES, ROLE_SETTINGS_ONLY } = require('./lib/constants');

// ---------------------------------------------------------------------
// Claims sync trigger — fires whenever a users/{uid} doc is created,
// updated or deleted. Keeps Firebase Auth custom claims in lockstep with
// Firestore so requireAuth()/Security Rules never see stale role data for
// long (the client forces a token refresh right after login and right
// after any Settings > System Access change that might affect them).
// ---------------------------------------------------------------------
const syncUserClaims = onDocumentWritten('users/{uid}', async (event) => {
  const uid = event.params.uid;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (!after) {
    try {
      await admin.auth().setCustomUserClaims(uid, null);
    } catch (e) {
      // user may already be gone from Firebase Auth too; ignore.
    }
    return;
  }
  await admin.auth().setCustomUserClaims(uid, {
    role: after.role || '',
    fundAccess: Array.isArray(after.fundAccess) ? after.fundAccess : [],
    status: after.status || 'Active',
    mustChangePassword: !!after.mustChangePassword,
    name: after.fullName || '',
    email: after.email || ''
  });
});

// ---------------------------------------------------------------------
// createUser — Municipal Accountant only. Creates the Firebase Auth
// account with a temporary password and the matching Firestore profile in
// one call, plus the public username->email lookup doc if a Username was
// given. Mirrors the "Municipal Accountant sets a Temporary Password under
// Settings > System Access" flow from the original spec.
// ---------------------------------------------------------------------
const createUser = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_SETTINGS_ONLY);
  const { fullName, email, username, role, fundAccess, tempPassword } = request.data || {};
  if (!fullName || !email || !role) {
    throw new HttpsError('invalid-argument', 'Full name, email and role are required.');
  }
  if (!ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', 'Unknown role: ' + role);
  }
  if (!tempPassword || String(tempPassword).length < 6) {
    throw new HttpsError('invalid-argument', 'Temporary password must be at least 6 characters.');
  }
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({ email, password: tempPassword, displayName: fullName });
  } catch (e) {
    throw new HttpsError('already-exists', e.message || 'Could not create that account (email may already be in use).');
  }
  await db.collection('users').doc(userRecord.uid).set({
    fullName,
    email,
    username: username || '',
    role,
    fundAccess: Array.isArray(fundAccess) ? fundAccess : [],
    status: 'Active',
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
    createdBy: auth.email
  });
  if (username) {
    await db.collection('usernameIndex').doc(String(username).toLowerCase()).set({ email });
  }
  await logAudit(auth, 'Create', 'System Access', email, 'Role: ' + role);
  return { ok: true, uid: userRecord.uid };
});

// ---------------------------------------------------------------------
// updateUser — edit an existing profile (name/role/fundAccess/status).
// ---------------------------------------------------------------------
const updateUser = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_SETTINGS_ONLY);
  const { uid, fullName, role, fundAccess, status } = request.data || {};
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');
  if (role && !ROLES.includes(role)) throw new HttpsError('invalid-argument', 'Unknown role: ' + role);
  const patch = {};
  if (fullName !== undefined) patch.fullName = fullName;
  if (role !== undefined) patch.role = role;
  if (fundAccess !== undefined) patch.fundAccess = Array.isArray(fundAccess) ? fundAccess : [];
  if (status !== undefined) patch.status = status;
  patch.updatedAt = new Date().toISOString();
  patch.updatedBy = auth.email;
  await db.collection('users').doc(uid).set(patch, { merge: true });
  if (status === 'Inactive') {
    await admin.auth().updateUser(uid, { disabled: true }).catch(() => {});
  } else if (status === 'Active') {
    await admin.auth().updateUser(uid, { disabled: false }).catch(() => {});
  }
  await logAudit(auth, 'Edit', 'System Access', uid, JSON.stringify(patch));
  return { ok: true };
});

// ---------------------------------------------------------------------
// setTemporaryPassword — Municipal Accountant resets someone's password
// and forces them to choose a new one on next login.
// ---------------------------------------------------------------------
const setTemporaryPassword = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_SETTINGS_ONLY);
  const { uid, tempPassword } = request.data || {};
  if (!uid || !tempPassword || String(tempPassword).length < 6) {
    throw new HttpsError('invalid-argument', 'uid and a temporary password of at least 6 characters are required.');
  }
  await admin.auth().updateUser(uid, { password: tempPassword });
  await db.collection('users').doc(uid).set({ mustChangePassword: true }, { merge: true });
  await logAudit(auth, 'Reset Password', 'System Access', uid, '');
  return { ok: true };
});

// ---------------------------------------------------------------------
// completePasswordChange — called by the client right after it has
// successfully changed its own password via the Auth SDK
// (reauthenticateWithCredential + updatePassword). Clears the forced-change
// flag and writes the audit entry; this callable does NOT itself touch the
// password so a stolen ID token can't be used to reset it.
// ---------------------------------------------------------------------
const completePasswordChange = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireAuth(request);
  await db.collection('users').doc(auth.uid).set({
    mustChangePassword: false,
    passwordUpdatedAt: new Date().toISOString()
  }, { merge: true });
  await logAudit(auth, 'Change Password', 'System Access', auth.email, '');
  return { ok: true };
});

// ---------------------------------------------------------------------
// logLoginEvent — client calls this right after a successful sign-in, and
// again (with the still-valid token) right before signing out, purely so
// Log In / Log Out show up in the Audit Log the same as before.
// ---------------------------------------------------------------------
const logLoginEvent = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireAuth(request);
  const action = request.data && request.data.action === 'Log Out' ? 'Log Out' : 'Log In';
  await logAudit(auth, action, 'System Access', auth.email, '');
  return { ok: true };
});

module.exports = {
  syncUserClaims,
  createUser,
  updateUser,
  setTemporaryPassword,
  completePasswordChange,
  logLoginEvent
};
