/**
 * Shared constants — ported from the original Apps Script Code.gs so the
 * Firebase edition keeps the same fund codes, roles, transaction types and
 * reference-number schemes. The Property & Inventory and Reconciliation
 * modules (and everything that only existed to support them — PPE ledger
 * cards, bank reconciliation items, etc.) were intentionally dropped per
 * Neil's request; the rest of the business logic is preserved.
 */

const FUND_NAMES = {
  gf: 'General Fund',
  sef: 'Special Education Fund',
  tf: 'Trust Fund'
};

const FUND_CODE = {
  gf: '100',
  sef: '200',
  tf: '300'
};

const COA_COLLECTION_BY_FUND = {
  gf: 'coa_generalFund',
  sef: 'coa_sef',
  tf: 'coa_trustFund'
};

const MUNICIPAL_ACCOUNTANT_NAME_DEFAULT = ''; // set per-deployment in Settings, not hardcoded here
const MUNICIPAL_ACCOUNTANT_TITLE = 'Municipal Accountant';

/**
 * Six roles, same as the Apps Script version. Adjust in Settings > System
 * Access if the office wants different titles; these string values are
 * also what gets mirrored into each user's Firebase Auth custom claims.
 */
const ROLES = [
  'Municipal Accountant',
  'Accounting Supervisor',
  'Accounting Staff',
  'Budget Officer',
  'Budget Staff',
  'Viewer'
];

const ROLE_ACCOUNTANT_ONLY = ['Municipal Accountant'];
const ROLE_CAN_CREATE_TX = ['Municipal Accountant', 'Accounting Supervisor', 'Accounting Staff'];
const ROLE_CAN_EDIT_TX = ['Municipal Accountant', 'Accounting Supervisor'];
const ROLE_CAN_EDIT_TRANSACTIONS = ROLE_CAN_CREATE_TX;
const ROLE_CAN_EDIT_BUDGET = ['Municipal Accountant', 'Budget Officer'];
const ROLE_CAN_ENCODE_BUDGET = ['Municipal Accountant', 'Budget Officer', 'Budget Staff'];
// Settings (Chart of Accounts, System Access, Office/FPP master lists, Closing)
const ROLE_SETTINGS_ONLY = ['Municipal Accountant'];

const TX_TYPE_LABEL = {
  disbursement_voucher: 'Disbursement Voucher',
  check: 'Check',
  ada: 'ADA',
  collections_deposit: 'Collections and Deposit',
  liquidation: 'Liquidation',
  payroll: 'Payroll',
  rsmi: 'RSMI',
  depreciation: 'Depreciation',
  others: 'Others'
};

const TX_REF_PREFIX = {
  disbursement_voucher: 'DV', check: 'CHK', ada: 'ADA', collections_deposit: 'CD',
  liquidation: 'LIQ', payroll: 'PR', rsmi: 'RSMI', depreciation: 'DEP', others: 'OTH'
};

// Which of the auto-numbering schemes backs each type's Primary Ref No.
// Types left out (check, rsmi) are manually encoded per spec.
const TX_REF_KIND = {
  disbursement_voucher: 'dv', ada: 'ada', collections_deposit: 'rcd',
  liquidation: 'lr', payroll: 'rcdisb', others: 'adj'
};

const DV_CATEGORIES = ['Regular', 'Cash Advance/Fund Transfer', 'Payroll'];
const DV_SUB_TYPES = ['Procurement', 'Non-Procurement'];
const TX_STATUSES = ['Pending', 'Approved', 'Cancelled'];
const OBR_STATUSES = ['Pending', 'Obligated', 'Cancelled'];

const CREATE_LISTS = {
  names: 'createNames',
  bankAccount: 'createBankAccount',
  office: 'createOffice',
  fpp: 'createFpp',
  subsidiaryLedgerAccounts: 'createSubsidiaryLedgerAccounts'
};
const CREATE_KEY_FIELD = {
  names: 'name', bankAccount: 'accountNo', office: 'officeCode',
  fpp: 'fppCode', subsidiaryLedgerAccounts: 'code'
};
// "In Settings, only the Municipal Accountant can Modify and Add Settings."
// Office and FPP are Settings-module master lists; Names/Bank
// Account/Subsidiary Ledger Accounts keep the broader Create-module access.
const SETTINGS_ONLY_CREATE_KEYS = ['office', 'fpp'];

function fundKeyFromLabel(label) {
  return Object.keys(FUND_NAMES).find((k) => FUND_NAMES[k] === label) || null;
}

module.exports = {
  FUND_NAMES,
  FUND_CODE,
  COA_COLLECTION_BY_FUND,
  MUNICIPAL_ACCOUNTANT_NAME_DEFAULT,
  MUNICIPAL_ACCOUNTANT_TITLE,
  ROLES,
  ROLE_ACCOUNTANT_ONLY,
  ROLE_CAN_CREATE_TX,
  ROLE_CAN_EDIT_TX,
  ROLE_CAN_EDIT_TRANSACTIONS,
  ROLE_CAN_EDIT_BUDGET,
  ROLE_CAN_ENCODE_BUDGET,
  ROLE_SETTINGS_ONLY,
  TX_TYPE_LABEL,
  TX_REF_PREFIX,
  TX_REF_KIND,
  DV_CATEGORIES,
  DV_SUB_TYPES,
  TX_STATUSES,
  OBR_STATUSES,
  CREATE_LISTS,
  CREATE_KEY_FIELD,
  SETTINGS_ONLY_CREATE_KEYS,
  fundKeyFromLabel
};
