// Firebase SDK initialization (modular v10, loaded straight from Google's
// CDN — no build step / bundler needed, so this deploys as plain static
// files to Firebase Hosting or GitHub Pages just as easily).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc,
  query, where, orderBy, limit, onSnapshot, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

import { firebaseConfig, FUNCTIONS_REGION } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functionsInstance = getFunctions(app, FUNCTIONS_REGION || "us-central1");

setPersistence(auth, browserLocalPersistence).catch(() => {});

export {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  collection, doc, getDoc, getDocs, setDoc, addDoc,
  query, where, orderBy, limit, onSnapshot, Timestamp,
  httpsCallable
};

export function fn(name) {
  return httpsCallable(functionsInstance, name);
}
