/**
 * "Create" master-data module — Names (Payee/Payor/Depositor/Creditor/
 * Employee/Collector directory, merged into one list per the original),
 * Bank Account, Office, FPP (Functional/Program/Project code), and
 * Subsidiary Ledger Accounts. Office and FPP are Settings-module master
 * lists restricted to the Municipal Accountant; the rest keep the broader
 * Create-module access, same split as the original saveCreateRecord.
 *
 * The PPE/Inventory create-list (Create_InventoryPPE) is dropped along
 * with the rest of the Property module.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./lib/admin');
const { requireRole } = require('./lib/roles');
const { logAudit } = require('./lib/audit');
const {
  CREATE_LISTS, CREATE_KEY_FIELD, SETTINGS_ONLY_CREATE_KEYS,
  ROLE_CAN_EDIT_TRANSACTIONS, ROLE_SETTINGS_ONLY
} = require('./lib/constants');

function roleFor(key) {
  return SETTINGS_ONLY_CREATE_KEYS.includes(key) ? ROLE_SETTINGS_ONLY : ROLE_CAN_EDIT_TRANSACTIONS;
}

const saveCreateRecord = onCall(async (request) => {
  const { key, payload } = request.data || {};
  const collection = CREATE_LISTS[key];
  if (!collection) throw new HttpsError('invalid-argument', 'Unknown create list: ' + key);
  const auth = requireRole(request, roleFor(key));
  const keyField = CREATE_KEY_FIELD[key];
  const keyValue = payload && payload[keyField];
  if (!keyValue) throw new HttpsError('invalid-argument', `${keyField} is required.`);

  await db.collection(collection).doc(String(keyValue)).set({
    ...payload,
    updatedAt: new Date().toISOString(),
    updatedBy: auth.email
  }, { merge: true });
  await logAudit(auth, 'Save', key, String(keyValue), '');
  return { ok: true };
});

const deleteCreateRecord = onCall(async (request) => {
  const { key, keyValue } = request.data || {};
  const collection = CREATE_LISTS[key];
  if (!collection) throw new HttpsError('invalid-argument', 'Unknown create list: ' + key);
  const auth = requireRole(request, roleFor(key));
  await db.collection(collection).doc(String(keyValue)).delete();
  await logAudit(auth, 'Delete', key, String(keyValue), '');
  return { ok: true };
});

module.exports = { saveCreateRecord, deleteCreateRecord };
