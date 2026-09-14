/**
 * Shared Firebase Admin SDK initialization. Every other backend module
 * requires this file instead of calling admin.initializeApp() itself, so
 * there's exactly one initialized app no matter how many function files
 * get loaded.
 */
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = { admin, db };
