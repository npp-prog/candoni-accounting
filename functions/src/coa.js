/**
 * Chart of Accounts (Settings > Chart of Accounts). Reads happen directly
 * from the client against the coa_* collections (Security Rules allow any
 * authenticated user to read them); writes go through this callable so
 * only the Municipal Accountant can add or edit an account, per spec
 * ("In Settings, only the Municipal Accountant can Modify and Add
 * Settings. Other Users can just View.").
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./lib/admin');
const { requireRole } = require('./lib/roles');
const { logAudit } = require('./lib/audit');
const { COA_COLLECTION_BY_FUND, ROLE_SETTINGS_ONLY } = require('./lib/constants');

const saveAccount = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_SETTINGS_ONLY);
  const { fund, accountCode, accountName, category, status } = request.data || {};
  const collection = COA_COLLECTION_BY_FUND[fund];
  if (!collection) throw new HttpsError('invalid-argument', 'Unknown fund: ' + fund);
  if (!accountCode || !accountName) {
    throw new HttpsError('invalid-argument', 'Account Code and Account Name are required.');
  }
  await db.collection(collection).doc(String(accountCode)).set({
    accountCode: String(accountCode),
    accountName,
    category: category || '',
    status: status || 'Active',
    updatedAt: new Date().toISOString(),
    updatedBy: auth.email
  }, { merge: true });
  await logAudit(auth, 'Save', 'Chart of Accounts', accountCode, fund);
  return { ok: true };
});

const deleteAccount = onCall({ invoker: 'public' }, async (request) => {
  const auth = requireRole(request, ROLE_SETTINGS_ONLY);
  const { fund, accountCode } = request.data || {};
  const collection = COA_COLLECTION_BY_FUND[fund];
  if (!collection) throw new HttpsError('invalid-argument', 'Unknown fund: ' + fund);
  await db.collection(collection).doc(String(accountCode)).delete();
  await logAudit(auth, 'Delete', 'Chart of Accounts', accountCode, fund);
  return { ok: true };
});

module.exports = { saveAccount, deleteAccount };
