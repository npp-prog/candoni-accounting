import {
  auth, db, fn,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  doc, getDoc
} from './firebase-init.js';
import { setUser, currentUser } from './state.js';
import { toast, errorMessage, setButtonBusy } from './ui.js';

let onReadyCallback = null;
export function onAuthReady(cb) { onReadyCallback = cb; }

async function resolveEmail(loginId) {
  const id = String(loginId || '').trim();
  if (!id) throw new Error('Enter your username or email.');
  if (id.includes('@')) return id;
  const snap = await getDoc(doc(db, 'usernameIndex', id.toLowerCase()));
  if (!snap.exists()) {
    throw new Error('No account found for that username. Ask the Municipal Accountant to add or activate your account.');
  }
  return snap.data().email;
}

async function loadProfile(user) {
  const tokenResult = await user.getIdTokenResult(true); // force refresh so custom claims are current
  const claims = tokenResult.claims || {};
  let profile = {};
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (snap.exists()) profile = snap.data();
  } catch (e) { /* rules may block a brand-new/disabled account; claims still work */ }
  setUser({
    uid: user.uid,
    email: user.email,
    name: claims.name || profile.fullName || user.email,
    role: claims.role || profile.role || '',
    fundAccess: claims.fundAccess || profile.fundAccess || [],
    status: claims.status || profile.status || 'Active',
    mustChangePassword: !!(claims.mustChangePassword || profile.mustChangePassword)
  });
}

export function initAuth() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      setUser(null);
      document.getElementById('loginScreen').style.display = 'flex';
      document.getElementById('app').classList.remove('active');
      return;
    }
    try {
      await loadProfile(user);
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('app').classList.add('active');
      if (onReadyCallback) onReadyCallback();
      const u = currentUser();
      if (u && u.mustChangePassword) {
        openPasswordChangeModal(true);
      }
    } catch (e) {
      console.error(e);
      toast('Could not load your profile: ' + errorMessage(e), true);
    }
  });

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('loginError');
    errEl.classList.remove('shown');
    const btn = document.getElementById('loginSubmitBtn');
    setButtonBusy(btn, true, 'Logging in…');
    try {
      const email = await resolveEmail(document.getElementById('loginId').value);
      const password = document.getElementById('loginPassword').value;
      await signInWithEmailAndPassword(auth, email, password);
      fn('logLoginEvent')({ action: 'Log In' }).catch(() => {});
      document.getElementById('loginForm').reset();
    } catch (e) {
      errEl.textContent = errorMessage(e).includes('auth/invalid-credential') || errorMessage(e).includes('auth/wrong-password')
        ? 'Incorrect password.'
        : errorMessage(e);
      errEl.classList.add('shown');
    } finally {
      setButtonBusy(btn, false);
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await fn('logLoginEvent')({ action: 'Log Out' }); } catch (e) { /* best-effort */ }
    await signOut(auth);
  });

  document.getElementById('changePasswordNavBtn').addEventListener('click', () => openPasswordChangeModal(false));
  document.getElementById('passwordChangeCancelBtn').addEventListener('click', () => closePasswordChangeModal());
  document.getElementById('passwordChangeCloseX').addEventListener('click', () => closePasswordChangeModal());

  document.getElementById('passwordChangeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('pcError');
    errEl.classList.remove('shown');
    const current = document.getElementById('pcCurrent').value;
    const next = document.getElementById('pcNew').value;
    const confirm = document.getElementById('pcConfirm').value;
    if (next !== confirm) {
      errEl.textContent = 'New password and confirmation do not match.';
      errEl.classList.add('shown');
      return;
    }
    if (next.length < 6) {
      errEl.textContent = 'New password must be at least 6 characters.';
      errEl.classList.add('shown');
      return;
    }
    try {
      const user = auth.currentUser;
      const cred = EmailAuthProvider.credential(user.email, current);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, next);
      await fn('completePasswordChange')();
      await loadProfile(user);
      toast('Password updated.');
      closePasswordChangeModal();
    } catch (e) {
      errEl.textContent = errorMessage(e).includes('wrong-password') || errorMessage(e).includes('invalid-credential')
        ? 'Current password is incorrect.'
        : errorMessage(e);
      errEl.classList.add('shown');
    }
  });
}

function openPasswordChangeModal(forced) {
  document.getElementById('passwordChangeForm').reset();
  document.getElementById('pcError').classList.remove('shown');
  document.getElementById('passwordChangeTitle').textContent = forced ? 'Set Your New Password' : 'Change Password';
  document.getElementById('passwordChangeSub').textContent = forced
    ? 'You are using a temporary password. Choose a permanent one to continue.'
    : 'Enter your current password and choose a new one.';
  document.getElementById('passwordChangeCancelBtn').style.display = forced ? 'none' : '';
  document.getElementById('passwordChangeCloseX').style.display = forced ? 'none' : '';
  document.getElementById('passwordChangeOverlay').classList.add('shown');
}
function closePasswordChangeModal() {
  document.getElementById('passwordChangeOverlay').classList.remove('shown');
}
