# Candoni Accounting System — Firebase Edition

Standalone Firebase build of the Municipal Government of Candoni Accounting
System, ported from the Google Apps Script + Sheets version (`Code.gs` /
`dashboard.html`). Same core modules and business rules; **Property &
Inventory and Reconciliation are intentionally not included** — everything
else (Chart of Accounts, Transactions, Journal Entry Vouchers, Budget,
Report, Create, Settings, Audit Log) is.

- **Frontend:** plain HTML/CSS/JS single-page app (no build step, no
  framework) under `public/` — deploys as-is to Firebase Hosting.
- **Backend:** Firebase Cloud Functions (Node 20) under `functions/` —
  role checks, monthly-closing lock, balanced-JEV validation, reference
  number generation, and audit logging all live here, mirroring the
  original Apps Script server functions.
- **Database:** Cloud Firestore. Firestore Security Rules
  (`firestore.rules`) let signed-in users read the operational
  collections directly (for live lists); every write goes through a
  Cloud Function so business rules can't be bypassed from the browser
  console.
- **Auth:** Firebase Authentication (email/password), with a
  Username → email lookup so people can still log in with a Username the
  way the original spreadsheet version did.

See `docs/SETUP_GUIDE.md` for how to create a Firebase project, configure
this code against it, and deploy.

## Project layout

```
public/              Static frontend (Firebase Hosting root)
  index.html          App shell — login screen, sidebar, page containers
  styles.css           All styling
  js/
    firebase-init.js    Firebase SDK bootstrap (loaded straight from the CDN)
    firebase-config.js   YOUR project's config — copy from firebase-config.example.js, git-ignored
    auth.js              Login/logout/password-change wiring
    state.js             Shared client state (current user, current fund)
    nav.js                Sidebar/page/subnav wiring
    ui.js                 Toast + generic form modal + table renderer helpers
    constants.js          Client mirror of functions/src/lib/constants.js
    app.js                Entry point — wires everything above together
    pages/                One module per page (dashboard, transactions, jev, budget, report, create, settings, auditlog, masterData)
functions/            Cloud Functions backend
  index.js              Exports every callable
  src/                   One module per domain area, src/lib/ for shared helpers
firestore.rules        Firestore Security Rules
firestore.indexes.json  Composite indexes the report/list queries need
firebase.json           Firebase project configuration (hosting + functions + firestore + emulators)
.firebaserc             Which Firebase project this deploys to — set your project ID here
assets/                 Reference copies of the original CSS and the seal image (not shipped to Hosting)
```

## Roles

Same six roles as the original: Municipal Accountant, Accounting
Supervisor, Accounting Staff, Budget Officer, Budget Staff, Viewer. The
Municipal Accountant is the only role that can manage System Access,
Chart of Accounts, Office/FPP master lists, and monthly Closing.
