// Copy this file to firebase-config.js (same folder) and fill in the real
// values from Firebase Console > Project settings > General > Your apps >
// SDK setup and configuration > Config. firebase-config.js itself is
// git-ignored on purpose (see .gitignore) so nobody accidentally commits
// your project's identifiers to a public repo, even though none of these
// values are secret by themselves — access is enforced by Firestore
// Security Rules and Cloud Functions, not by hiding this object.
export const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME"
};

// If you deployed Cloud Functions to a region other than us-central1,
// set it here too (must match --region used at deploy time).
export const FUNCTIONS_REGION = "us-central1";
