// Shared app state: the current signed-in user's profile (mirrored from
// their ID token custom claims) and the currently-selected fund filter.
// Plain module-level state + a tiny pub/sub — no framework needed for an
// app this size.

export const state = {
  user: null, // { uid, email, name, role, fundAccess, mustChangePassword }
  fund: 'all', // 'all' | 'gf' | 'sef' | 'tf'
  bootstrapped: false
};

const listeners = { user: [], fund: [] };

export function onUserChange(cb) { listeners.user.push(cb); }
export function onFundChange(cb) { listeners.fund.push(cb); }

export function setUser(u) {
  state.user = u;
  listeners.user.forEach((cb) => cb(u));
}

export function setFund(f) {
  state.fund = f;
  listeners.fund.forEach((cb) => cb(f));
}

export function currentUser() { return state.user; }
export function currentFund() { return state.fund; }

export function hasRole(...roles) {
  return !!(state.user && roles.includes(state.user.role));
}

export function isAccountant() { return hasRole('Municipal Accountant'); }
