#!/usr/bin/env node
/**
 * One-time data migration — imports an .xlsx export of the original
 * Google Sheet (the same one Code.gs reads) into this app's Firestore
 * collections. Run this once, from a trusted machine, against a service
 * account key — see docs/SETUP_GUIDE.md section 5.
 *
 * Usage:
 *   node importFromXlsx.js path/to/export.xlsx --service-account path/to/serviceAccountKey.json
 *   node importFromXlsx.js path/to/export.xlsx --dry-run          # parse + report counts, write nothing
 *
 * Property & Inventory and Reconciliation sheets are intentionally not
 * imported — those modules were dropped from this Firebase edition per
 * Neil's request (see README.md).
 *
 * Each sheet in the real export has this shape: row 1 is a plain sheet
 * title, then EITHER a long descriptive paragraph row OR the real column
 * headers, then (if there was a paragraph row) the real column headers,
 * then data rows, then thousands of genuinely blank padding rows. Rather
 * than assume a fixed row offset per sheet (which broke between sheets in
 * the real export), this script finds the header row by matching known
 * column names, then reads every row after it until a run of blank rows.
 */
const path = require('path');
const XLSX = require('xlsx');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const filePath = args.find((a) => !a.startsWith('--'));
const saFlagIdx = args.indexOf('--service-account');
const serviceAccountPath = saFlagIdx !== -1 ? args[saFlagIdx + 1] : null;

if (!filePath) {
  console.error('Usage: node importFromXlsx.js <path-to-export.xlsx> [--service-account key.json] [--dry-run]');
  process.exit(1);
}

const FUND_NAMES = { gf: 'General Fund', sef: 'Special Education Fund', tf: 'Trust Fund' };
const COA_COLLECTION_BY_FUND = { gf: 'coa_generalFund', sef: 'coa_sef', tf: 'coa_trustFund' };
function fundKeyFromLabel(label) {
  const keys = Object.keys(FUND_NAMES);
  return keys.find((k) => FUND_NAMES[k] === String(label || '').trim()) || null;
}

function s(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function dateStr(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const str = String(v).trim();
  return str.slice(0, 10); // "2026-01-05 00:00:00" -> "2026-01-05"
}
function slug(...parts) {
  return parts.filter(Boolean).join('__').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Finds the row index whose cells match `expectedHeaders` (case-insensitive,
// trimmed; expectedHeaders may be a prefix of the row). Throws if not found
// so a sheet whose layout changed fails loudly instead of silently
// importing garbage.
function findHeaderRow(rows, expectedHeaders, sheetName) {
  const wanted = expectedHeaders.map((h) => h.toLowerCase());
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = (rows[i] || []).map((c) => s(c).toLowerCase());
    if (wanted.every((w, idx) => row[idx] === w)) return i;
  }
  throw new Error(`Could not find the expected header row in sheet "${sheetName}". Expected columns starting with: ${expectedHeaders.join(', ')}`);
}

// Reads every non-blank row after the header row, all the way to the end
// of the sheet's used range. Real exports pad with thousands of genuinely
// blank rows at the end, but — as the Journal_Entry_Voucher sheet's own
// real export demonstrated — can also have a blank-row GAP in the middle
// of real data (rows 3-6 blank, then real data resuming at row 7). So
// this skips blank rows rather than stopping at the first one; padding
// rows are blank too, so they're excluded the same way without needing to
// guess where the real data "ends".
function dataRows(rows, headerIdx) {
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.some((c) => c !== null && c !== undefined && String(c).trim() !== '')) out.push(row);
  }
  return out;
}

function readSheet(wb, sheetName, expectedHeaders) {
  const ws = wb.Sheets[sheetName];
  if (!ws) { console.warn(`Sheet "${sheetName}" not found — skipping.`); return []; }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const headerIdx = findHeaderRow(rows, expectedHeaders, sheetName);
  return dataRows(rows, headerIdx);
}

async function main() {
  const wb = XLSX.readFile(filePath, { cellDates: true });

  const counts = {};
  const writes = []; // { collection, docId, data }
  const authUsers = []; // { email, tempPassword, uid-to-be }

  // ---------------------------------------------------------- Chart of Accounts
  for (const [fundKey, sheetName] of Object.entries({ gf: 'COA_GeneralFund', sef: 'COA_SEF', tf: 'COA_TrustFund' })) {
    const rows = readSheet(wb, sheetName, ['Account Code', 'Account Name', 'Account Type']);
    let c = 0;
    for (const r of rows) {
      const accountCode = s(r[0]);
      if (!accountCode) continue;
      writes.push({
        collection: COA_COLLECTION_BY_FUND[fundKey], docId: accountCode,
        data: {
          accountCode, accountName: s(r[1]), category: s(r[3]) || s(r[2]), status: 'Active',
          updatedAt: new Date().toISOString(), updatedBy: 'import',
          extra: {
            accountType: s(r[2]), majorClassification: s(r[3]), normalBalance: s(r[4]),
            withSubsidiary: s(r[5]), withListedItems: s(r[6]), withBankRecon: s(r[7]), withAging: s(r[8]),
            cashFlowClassification: s(r[9]), notes: s(r[10]), subClass1: s(r[11]), subClass2: s(r[12]),
            beginningBalance: n(r[13]), propertyLink: s(r[14]), ppeAssetClass: s(r[15])
          }
        }
      });
      c++;
    }
    counts[sheetName] = c;
  }

  // ------------------------------------------------------------------ Create_*
  for (const r of readSheet(wb, 'Create_Names', ['Name', 'Type (Payee/Payor/Depositor/Creditor/Employee/Collector)'])) {
    const name = s(r[0]);
    if (!name) continue;
    writes.push({
      collection: 'createNames', docId: slug(name) || name, data: {
        name, type: s(r[1]), tin: s(r[2]), address: s(r[3]), contactNo: s(r[4]), email: s(r[5]),
        status: s(r[6]) || 'Active', office: s(r[7]), position: s(r[8]), employeeNo: s(r[9]),
        agingCategory: s(r[10]), designation: s(r[11]), bondNo: s(r[12]),
        authorizedRoles: s(r[13]) ? s(r[13]).split(',').map((x) => x.trim()).filter(Boolean) : [],
        payrollOfficerCode: s(r[14]), beginningBalance: n(r[15])
      }
    });
  }
  counts.Create_Names = writes.filter((w) => w.collection === 'createNames').length;

  for (const r of readSheet(wb, 'Create_BankAccount', ['Bank Name', 'Account No.', 'Account Name'])) {
    const accountNo = s(r[1]);
    if (!accountNo) continue;
    writes.push({
      collection: 'createBankAccount', docId: accountNo, data: {
        bankName: s(r[0]), accountNo, accountName: s(r[2]), fund: s(r[3]), branch: s(r[4]), status: s(r[5]) || 'Active'
      }
    });
  }
  counts.Create_BankAccount = writes.filter((w) => w.collection === 'createBankAccount').length;

  for (const r of readSheet(wb, 'Create_Office', ['Office Code', 'Office Name'])) {
    const officeCode = s(r[0]);
    if (!officeCode) continue;
    writes.push({
      collection: 'createOffice', docId: officeCode, data: {
        officeCode, officeName: s(r[1]), headOfOffice: s(r[2]), email: s(r[3])
      }
    });
  }
  counts.Create_Office = writes.filter((w) => w.collection === 'createOffice').length;

  for (const r of readSheet(wb, 'Create_FPP', ['FPP Code', 'Function/Project/Program Name'])) {
    const fppCode = s(r[0]);
    if (!fppCode) continue;
    writes.push({
      collection: 'createFpp', docId: fppCode, data: {
        fppCode, fppName: s(r[1]), fund: s(r[2]), office: s(r[3]), status: s(r[4]) || 'Active', year: s(r[5])
      }
    });
  }
  counts.Create_FPP = writes.filter((w) => w.collection === 'createFpp').length;

  for (const r of readSheet(wb, 'Create_SubsidiaryLedgerAccounts', ['Name', 'Qualifier', 'Label'])) {
    const name = s(r[0]);
    if (!name) continue;
    const qualifier = s(r[1]), fund = s(r[3]), accountCode = s(r[4]);
    const code = slug(name, qualifier, fund, accountCode);
    writes.push({
      collection: 'createSubsidiaryLedgerAccounts', docId: code, data: {
        code, name, qualifier, fund, accountCode, accountName: s(r[5]), beginningBalance: n(r[6]), status: s(r[7]) || 'Active'
      }
    });
  }
  counts.Create_SubsidiaryLedgerAccounts = writes.filter((w) => w.collection === 'createSubsidiaryLedgerAccounts').length;

  // -------------------------------------------------------------------- Budget
  for (const r of readSheet(wb, 'Budget_Allotment', ['Fund', 'Office/Function Code', 'Office/Function Name'])) {
    const fundLabel = s(r[0]);
    const fundKey = fundKeyFromLabel(fundLabel);
    if (!fundKey) continue;
    const officeFunctionCode = s(r[1]);
    const fppCode = s(r[18]);
    const allotmentClass = s(r[5]);
    const lineKey = [fundKey, officeFunctionCode || '-', fppCode || '-', allotmentClass || '-'].join('__');
    writes.push({
      collection: 'budgetLines', docId: lineKey, data: {
        fund: fundLabel, fundKey, officeFunctionCode, fppCode, fppName: s(r[19]), allotmentClass,
        sector: s(r[12]), notes: s(r[11]),
        annualAppropriation: n(r[6]), continuingAppropriations: n(r[7]), allotment: n(r[8]),
        supplemental: n(r[9]), augmentation: n(r[10]),
        generalOrdinanceNo: s(r[13]), continuingOrdinanceNo: s(r[14]), supplementalOrdinanceNo: s(r[15]),
        allotmentOrderNo: s(r[16]), augmentationOrderNo: s(r[17]),
        updatedAt: new Date().toISOString(), updatedBy: 'import',
        extra: { officeFunctionName: s(r[2]), expenseCode: s(r[3]), expenseName: s(r[4]) }
      }
    });
  }
  counts.Budget_Allotment = writes.filter((w) => w.collection === 'budgetLines').length;

  let refLogSeq = 0;
  for (const r of readSheet(wb, 'Budget_Reference_Log', ['Reference No.', 'Module', 'Fund'])) {
    const referenceNo = s(r[0]);
    if (!referenceNo) continue;
    writes.push({
      collection: 'budgetReferenceLog', docId: `import-${++refLogSeq}`, data: {
        referenceNo, module: s(r[1]), fund: s(r[2]), amount: n(r[10]),
        extra: { date: dateStr(r[3]), officeFunctionCode: s(r[4]), officeFunctionName: s(r[5]), expenseCode: s(r[6]), expenseName: s(r[7]), allotmentClass: s(r[8]), sector: s(r[9]), notes: s(r[11]) },
        createdAt: new Date().toISOString()
      }
    });
  }
  counts.Budget_Reference_Log = writes.filter((w) => w.collection === 'budgetReferenceLog').length;

  for (const r of readSheet(wb, 'Obligation_Request', ['OBR No.', 'Date', 'Office'])) {
    const obrNo = s(r[0]);
    if (!obrNo) continue;
    const fundLabel = s(r[3]);
    writes.push({
      collection: 'obligationRequests', docId: obrNo.replace(/[\/\\]/g, '-'), data: {
        obrNo, date: dateStr(r[1]), office: s(r[2]), fund: fundLabel, fundKey: fundKeyFromLabel(fundLabel) || '',
        fpp: s(r[4]), particulars: s(r[5]), amount: n(r[6]), status: s(r[7]) || 'Pending',
        jevNo: s(r[8]), payee: s(r[9]), officeFunctionCode: s(r[10]), accountCode: s(r[11]),
        allotmentClass: s(r[12]), sector: s(r[13]), createdAt: new Date().toISOString(), createdBy: 'import'
      }
    });
  }
  counts.Obligation_Request = writes.filter((w) => w.collection === 'obligationRequests').length;

  // --------------------------------------------------------------- Transactions
  for (const r of readSheet(wb, 'Transactions', ['Type', 'Sub Type', 'Date'])) {
    const type = s(r[0]);
    const primaryRefNo = s(r[3]);
    if (!type || !primaryRefNo) continue;
    const fundLabel = s(r[8]);
    const gross = n(r[11]), wtax = n(r[12]), other = n(r[13]);
    writes.push({
      collection: 'transactions', docId: null, data: {
        type, subType: s(r[1]), date: dateStr(r[2]), primaryRefNo, secondaryRefNo: s(r[4]), tertiaryRefNo: s(r[5]),
        name: s(r[6]), particulars: s(r[7]), fund: fundLabel, fundKey: fundKeyFromLabel(fundLabel) || '',
        office: s(r[9]), emailAddress: s(r[10]), grossAmount: gross, wtax, otherDeductions: other,
        netAmount: gross - wtax - other, status: s(r[15]) || 'Pending', jevNo: s(r[16]),
        collector: s(r[17]), dvCategory: s(r[18]), createdAt: new Date().toISOString(), createdBy: 'import'
      }
    });
  }
  counts.Transactions = writes.filter((w) => w.collection === 'transactions').length;

  // ------------------------------------------------------ Journal Entry Vouchers
  const jevGroups = new Map(); // jevNo -> { header, lines: [] }
  for (const r of readSheet(wb, 'Journal_Entry_Voucher', ['JEV No.', 'Date', 'Fund'])) {
    const jevNo = s(r[0]);
    const accountCode = s(r[5]);
    if (!jevNo || !accountCode || !/^[0-9-]+$/.test(accountCode)) continue; // skips the sheet's own "Example rows check ->" sentinel row
    if (!jevGroups.has(jevNo)) {
      jevGroups.set(jevNo, {
        jevNo, date: dateStr(r[1]), fund: s(r[2]), fundKey: fundKeyFromLabel(s(r[2])) || '',
        sourceType: s(r[3]), sourceRef: s(r[4]), lines: []
      });
    }
    jevGroups.get(jevNo).lines.push({
      accountCode, accountName: s(r[6]), debit: n(r[7]), credit: n(r[8]),
      subsidiary: s(r[9]), fpp: s(r[10]), bankAccount: s(r[11]), dueDate: dateStr(r[12]), listedItems: s(r[13])
    });
  }
  let jevLineSeq = 0;
  for (const group of jevGroups.values()) {
    const totalDebit = group.lines.reduce((a, l) => a + l.debit, 0);
    const totalCredit = group.lines.reduce((a, l) => a + l.credit, 0);
    const jevDocId = slug(group.jevNo) || `jev-${group.jevNo}`;
    writes.push({
      collection: 'jev', docId: jevDocId, data: {
        jevNo: group.jevNo, date: group.date, fund: group.fund, fundKey: group.fundKey,
        sourceType: group.sourceType, sourceRef: group.sourceRef, lines: group.lines,
        totalDebit, totalCredit, createdAt: new Date().toISOString(), createdBy: 'import'
      }
    });
    group.lines.forEach((l) => {
      writes.push({
        collection: 'jevLines', docId: `${jevDocId}-${++jevLineSeq}`, data: {
          jevId: jevDocId, jevNo: group.jevNo, date: group.date, fund: group.fund, fundKey: group.fundKey,
          sourceType: group.sourceType, sourceRef: group.sourceRef, ...l, createdAt: new Date().toISOString()
        }
      });
    });
  }
  counts.Journal_Entry_Voucher = jevGroups.size;
  counts.Journal_Entry_Voucher_lines = jevLineSeq;

  // -------------------------------------------------------------- Closed Periods
  for (const r of readSheet(wb, 'Closed_Periods', ['Fund', 'Period (YYYY-MM)'])) {
    const fundLabel = s(r[0]);
    const period = s(r[1]);
    if (!fundLabel || !period) continue;
    writes.push({
      collection: 'closedPeriods', docId: `${fundLabel}__${period}`, data: {
        fund: fundLabel, fundKey: fundKeyFromLabel(fundLabel) || '', period, closedBy: s(r[2]), closedAt: dateStr(r[3])
      }
    });
  }
  counts.Closed_Periods = writes.filter((w) => w.collection === 'closedPeriods').length;

  // ----------------------------------------------------------------- System Access
  for (const r of readSheet(wb, 'System_Access', ['Full Name', 'Email', 'Username'])) {
    const email = s(r[1]);
    if (!email) continue;
    const fundLabels = s(r[4]).split(',').map((x) => x.trim()).filter(Boolean);
    const fundKeys = fundLabels.map(fundKeyFromLabel).filter(Boolean);
    // All three funds listed (or none) means "unrestricted" in this app's
    // own convention (functions/src/lib/roles.js requireFundAccess) — an
    // empty array, not a list of every fund key.
    const fundAccess = fundKeys.length >= 3 ? [] : fundKeys;
    authUsers.push({
      email, fullName: s(r[0]), username: s(r[2]), role: s(r[3]) || 'Viewer', fundAccess,
      status: s(r[5]) || 'Active', createdAtSheet: s(r[6]), createdBy: s(r[7]) || 'import'
    });
  }
  counts.System_Access = authUsers.length;

  console.log('Parsed row counts:', counts);
  console.log(`Firestore documents to write: ${writes.length}. Firebase Auth accounts to create: ${authUsers.length}.`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written. Sample of the first 3 documents per collection:');
    const byCollection = {};
    writes.forEach((w) => { (byCollection[w.collection] = byCollection[w.collection] || []).push(w); });
    for (const [col, list] of Object.entries(byCollection)) {
      console.log(`\n${col} (${list.length} docs):`);
      list.slice(0, 3).forEach((w) => console.log(JSON.stringify(w.data)));
    }
    console.log(`\nSystem_Access users (${authUsers.length}):`, authUsers.map((u) => `${u.email} (${u.role})`));
    return;
  }

  if (!serviceAccountPath) {
    console.error('\n--service-account <path-to-key.json> is required unless --dry-run is set.');
    process.exit(1);
  }
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(serviceAccountPath))) });
  const db = admin.firestore();

  console.log('\nWriting Firestore documents...');
  let batch = db.batch();
  let inBatch = 0;
  for (const w of writes) {
    const ref = w.docId ? db.collection(w.collection).doc(w.docId) : db.collection(w.collection).doc();
    batch.set(ref, w.data, { merge: true });
    inBatch++;
    if (inBatch === 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
  }
  if (inBatch) await batch.commit();
  console.log(`Wrote ${writes.length} documents.`);

  console.log('\nCreating Firebase Auth accounts + users/{uid} profiles for System Access...');
  console.log('Each gets the SAME temporary password below (the old sheet stores a password hash from');
  console.log('the Apps Script system, which cannot be reused by Firebase Auth) — issue everyone a real');
  console.log('one via Settings > System Access > Reset Password before sharing login details.');
  const TEMP_PASSWORD = 'ChangeMe' + Math.floor(100000 + Math.random() * 900000) + '!';
  console.log(`Temporary password for every imported account: ${TEMP_PASSWORD}\n`);
  for (const u of authUsers) {
    try {
      const userRecord = await admin.auth().createUser({ email: u.email, password: TEMP_PASSWORD, displayName: u.fullName, disabled: u.status !== 'Active' });
      await db.collection('users').doc(userRecord.uid).set({
        fullName: u.fullName, email: u.email, username: u.username, role: u.role, fundAccess: u.fundAccess,
        status: u.status, mustChangePassword: true, createdAt: u.createdAtSheet || new Date().toISOString(), createdBy: u.createdBy
      });
      if (u.username) await db.collection('usernameIndex').doc(u.username.toLowerCase()).set({ email: u.email });
      console.log(`  created ${u.email} (${u.role})`);
    } catch (e) {
      console.error(`  FAILED for ${u.email}: ${e.message}`);
    }
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
