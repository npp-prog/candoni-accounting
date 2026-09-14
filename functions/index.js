/**
 * Cloud Functions entry point — Municipal Government of Candoni Accounting
 * System (Firebase edition). Every exported name here becomes a callable
 * (or trigger) the frontend reaches with httpsCallable(functions, name).
 */
const auth = require('./src/auth');
const coa = require('./src/coa');
const transactions = require('./src/transactions');
const jev = require('./src/jev');
const budget = require('./src/budget');
const masterData = require('./src/masterData');
const closedPeriodsFns = require('./src/closedPeriodsFns');
const dashboard = require('./src/dashboard');

module.exports = {
  // Auth / System Access
  syncUserClaims: auth.syncUserClaims,
  createUser: auth.createUser,
  updateUser: auth.updateUser,
  setTemporaryPassword: auth.setTemporaryPassword,
  completePasswordChange: auth.completePasswordChange,
  logLoginEvent: auth.logLoginEvent,

  // Chart of Accounts
  saveAccount: coa.saveAccount,
  deleteAccount: coa.deleteAccount,

  // Transactions
  getSuggestedRefNo: transactions.getSuggestedRefNo,
  saveTransaction: transactions.saveTransaction,
  updateTransaction: transactions.updateTransaction,
  updateTransactionStatus: transactions.updateTransactionStatus,

  // Journal Entry Vouchers
  getNextJevNo: jev.getNextJevNo,
  saveJEV: jev.saveJEV,

  // Budget
  saveBudgetLine: budget.saveBudgetLine,
  saveObligationRequest: budget.saveObligationRequest,
  saveObligationRequestBatch: budget.saveObligationRequestBatch,

  // Create / master data
  saveCreateRecord: masterData.saveCreateRecord,
  deleteCreateRecord: masterData.deleteCreateRecord,

  // Closing
  closeMonth: closedPeriodsFns.closeMonth,
  reopenMonth: closedPeriodsFns.reopenMonth,

  // Dashboard
  getDashboardSummary: dashboard.getDashboardSummary
};
