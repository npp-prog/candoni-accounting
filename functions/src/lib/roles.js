/**
 * Auth/permission helpers for callable Cloud Functions.
 *
 * Every user's role and fund access live in two places that are kept in
 * sync: the `users/{uid}` Firestore document (the source of truth, editable
 * only through the userAdmin callables) and that same user's Firebase Auth
 * custom claims (a denormalized copy, refreshed by syncUserClaims whenever
 * the Firestore doc changes — see functions/src/auth.js). Callables trust
 * the claims on the incoming ID token rather than re-reading Firestore on
 * every call, which is what makes requireAuth/requireRole cheap. Firestore
 * Security Rules for direct client reads also read these same claims via
 * request.auth.token.
 */
const { HttpsError } = require('firebase-functions/v2/https');

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Please log in again.');
  }
  const token = request.auth.token || {};
  return {
    uid: request.auth.uid,
    email: token.email || '',
    name: token.name || token.email || 'Unknown',
    role: token.role || '',
    fundAccess: Array.isArray(token.fundAccess) ? token.fundAccess : [],
    status: token.status || 'Active'
  };
}

function requireActive(auth) {
  if (auth.status && auth.status !== 'Active') {
    throw new HttpsError('permission-denied', 'This account is not active. Ask the Municipal Accountant to reactivate it.');
  }
}

function requireRole(request, allowedRoles) {
  const auth = requireAuth(request);
  requireActive(auth);
  if (!allowedRoles.includes(auth.role)) {
    throw new HttpsError(
      'permission-denied',
      `Your role (${auth.role || 'none'}) does not have permission to do this. Contact the Municipal Accountant.`
    );
  }
  return auth;
}

// Municipal Accountant always has every fund; everyone else needs either an
// empty fundAccess list (meaning "not yet restricted" — treated as full
// access so a freshly-imported account isn't locked out) or the fund key /
// 'all' explicitly listed.
function requireFundAccess(auth, fundKey) {
  if (!fundKey || fundKey === 'all') return;
  if (auth.role === 'Municipal Accountant') return;
  if (!auth.fundAccess || auth.fundAccess.length === 0) return;
  if (auth.fundAccess.includes('all') || auth.fundAccess.includes(fundKey)) return;
  throw new HttpsError('permission-denied', 'You do not have access to that fund.');
}

module.exports = { requireAuth, requireRole, requireFundAccess, requireActive };
