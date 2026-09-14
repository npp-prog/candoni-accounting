// Client-side mirror of functions/src/lib/constants.js. Only used for UI
// labels/dropdowns/validation hints — the Cloud Functions copy is what
// actually gets enforced, so keep the two in sync if you change either.
export const FUND_NAMES = { gf: 'General Fund', sef: 'Special Education Fund', tf: 'Trust Fund' };
export const FUND_LIST = [['gf', 'General Fund'], ['sef', 'Special Education Fund'], ['tf', 'Trust Fund']];

export const ROLES = [
  'Municipal Accountant', 'Accounting Supervisor', 'Accounting Staff',
  'Budget Officer', 'Budget Staff', 'Viewer'
];

export const ROLE_CAN_CREATE_TX = ['Municipal Accountant', 'Accounting Supervisor', 'Accounting Staff'];
export const ROLE_CAN_EDIT_TX = ['Municipal Accountant', 'Accounting Supervisor'];
export const ROLE_CAN_EDIT_BUDGET = ['Municipal Accountant', 'Budget Officer'];
export const ROLE_CAN_ENCODE_BUDGET = ['Municipal Accountant', 'Budget Officer', 'Budget Staff'];
export const ROLE_SETTINGS_ONLY = ['Municipal Accountant'];

export const TX_TYPES = [
  ['disbursement_voucher', 'Disbursement Voucher'],
  ['check', 'Check'],
  ['ada', 'ADA'],
  ['collections_deposit', 'Collections and Deposit'],
  ['liquidation', 'Liquidation'],
  ['others', 'Others']
];
export const TX_TYPE_LABEL = Object.fromEntries(TX_TYPES);

export const DV_CATEGORIES = ['Regular', 'Cash Advance/Fund Transfer', 'Payroll'];
export const DV_SUB_TYPES = ['Procurement', 'Non-Procurement'];
export const TX_STATUSES = ['Pending', 'Approved', 'Cancelled'];
export const OBR_STATUSES = ['Pending', 'Obligated', 'Cancelled'];

// Create / Settings master-data lists — mirrors
// functions/src/lib/constants.js CREATE_LISTS/CREATE_KEY_FIELD so the
// client and the saveCreateRecord/deleteCreateRecord callables agree on
// collection names and which payload field is the record's key.
export const CREATE_LISTS = {
  names: 'createNames',
  bankAccount: 'createBankAccount',
  office: 'createOffice',
  fpp: 'createFpp',
  subsidiaryLedgerAccounts: 'createSubsidiaryLedgerAccounts'
};
export const CREATE_KEY_FIELD = {
  names: 'name', bankAccount: 'accountNo', office: 'officeCode',
  fpp: 'fppCode', subsidiaryLedgerAccounts: 'code'
};
export const SETTINGS_ONLY_CREATE_KEYS = ['office', 'fpp'];

export function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (d.toDate) return d.toDate().toISOString().slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
