# Setup Guide — Candoni Accounting System (Firebase Edition)

This app needs a real Firebase project to run against — Firestore, Firebase
Authentication, and Cloud Functions all live there, not in this repo.
Nothing here can go live until you (or whoever holds the Google account
for the office) creates that project and this code is pointed at it.

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and create a new project
   (for example, `candoni-accounting`).
2. In the new project, enable:
   - **Authentication** → Sign-in method → Email/Password.
   - **Firestore Database** → Create database (Production mode; pick a
     region close to the Philippines, e.g. `asia-southeast1`).
   - **Functions** — this requires the project to be on the **Blaze
     (pay-as-you-go) plan**. A small office's usage is normally within
     Firebase's free monthly quota even on Blaze, but Google requires
     billing to be enabled before Cloud Functions can deploy at all.
   - **Hosting** (optional, only if you want Firebase to serve the
     frontend too — you can also host `public/` anywhere else that
     serves static files, or open `public/index.html` straight from
     disk for local testing).
3. In Project settings → General → Your apps, add a **Web app** and copy
   the config object it gives you (`apiKey`, `authDomain`, `projectId`,
   `storageBucket`, `messagingSenderId`, `appId`).

## 2. Point this code at your project

1. Install the Firebase CLI once, if you don't already have it:
   `npm install -g firebase-tools`, then `firebase login`.
2. Edit `.firebaserc` and replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`
   with your actual project ID.
3. Copy `public/js/firebase-config.example.js` to
   `public/js/firebase-config.js` and fill in the values from step 1.3.
   This file is git-ignored on purpose — it's config, not a secret, but
   keeping it out of the repo means a fork or a public mirror never
   accidentally ships someone else's project identifiers.
4. Install the Cloud Functions dependencies:
   ```
   cd functions
   npm install
   ```

## 3. Deploy

```
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

(Or deploy pieces one at a time while you're first setting things up —
`firebase deploy --only functions`, etc.)

The very first deploy of `firestore.indexes.json` can take a few minutes
per index to finish building; the app works before they're ready, it just
falls back to an unsorted query for the affected list until the index is
live (see the comments in `report.js`/`transactions.js`).

## 4. Create the first login

There is no user in Firebase Authentication yet, and `createUser` (the
callable that makes new accounts) itself requires being logged in as a
Municipal Accountant — a chicken-and-egg problem for the very first
account. Bootstrap it once, directly against your project, with the
[Firebase Admin SDK](https://firebase.google.com/docs/admin/setup) from a
trusted machine (this only needs to be done once):

```js
// bootstrap.js — run once with `node bootstrap.js` after
// `npm install firebase-admin` and downloading a service account key
// (Project settings > Service accounts > Generate new private key)
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });

(async () => {
  const user = await admin.auth().createUser({
    email: 'accountant@yourdomain.example',
    password: 'ChangeMeImmediately123!'
  });
  await admin.firestore().collection('users').doc(user.uid).set({
    fullName: 'Municipal Accountant',
    email: user.email,
    username: 'accountant',
    role: 'Municipal Accountant',
    fundAccess: [],
    status: 'Active',
    mustChangePassword: true,
    createdAt: new Date().toISOString(),
    createdBy: 'bootstrap'
  });
  await admin.firestore().collection('usernameIndex').doc('accountant').set({ email: user.email });
  console.log('Created', user.uid);
  process.exit(0);
})();
```

`serviceAccountKey.json` is git-ignored — never commit it. Delete it (and
rotate the key in the Firebase console) once you no longer need it on
that machine.

Log in with that account, then use Settings → System Access to create
every other user from inside the app — `createUser` works normally from
then on since you're already a Municipal Accountant.

## 5. Bring over your existing data

This build's Cloud Functions are schema-flexible (`saveAccount`,
`saveCreateRecord`, etc. all merge whatever payload they're given), so
importing your current Google Sheet is a matter of writing a one-time
Node script with the Admin SDK that reads each sheet tab (via the
`googleapis` package, or by exporting to CSV/XLSX first) and calls
`admin.firestore().collection(...).doc(...).set(...)` for each row, using
the same collection names this app already reads from:

| Sheet (original)                | Firestore collection            |
|----------------------------------|----------------------------------|
| COA_GeneralFund / COA_SEF / COA_TrustFund | `coa_generalFund` / `coa_sef` / `coa_trustFund` |
| Transactions                     | `transactions`                  |
| Journal_Entry_Voucher             | `jev` (+ `jevLines`, one doc per line) |
| Budget_Allotment                  | `budgetLines`                   |
| Obligation_Request                 | `obligationRequests`            |
| Create_Names                       | `createNames`                   |
| Create_BankAccount                  | `createBankAccount`             |
| Create_Office                       | `createOffice`                  |
| Create_FPP                          | `createFpp`                     |
| Create_SubsidiaryLedgerAccounts      | `createSubsidiaryLedgerAccounts` |
| System_Access                       | `users` (+ a matching Firebase Auth account per row) |

Run that import script the same way as the bootstrap script above — once,
from a trusted machine, using a service account key. This wasn't built
into the app itself since it's a one-time migration step, not something
the office needs a UI button for.

## 6. Local development (Firebase Emulator Suite)

You don't need a live project to develop against — the Firebase Emulator
Suite runs Firestore, Auth, Functions and Hosting locally:

```
firebase emulators:start
```

Point `public/js/firebase-config.js` at any placeholder project ID for
this and the emulators will still work for everything except real
external network calls (there are none in this app).
