# Salesforce Data Migrator (Chrome extension) — v1.0.0

Select Salesforce records, automatically discover everything they reference (lookups, master-detail, polymorphic, custom objects, any depth you allow), then either **export** a migration-ready package or **migrate** directly into another org with automatic Id remapping. No spreadsheets, no VLOOKUPs.

## Install (2 minutes)

1. Unzip `sf-data-migrator-extension-v1.0.0.zip` into a folder you will keep (Chrome loads it from there).
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
4. Pin the extension. Log in to your source org (and destination org) in normal Chrome tabs.
5. Click the extension icon → **Open Data Migrator**, or use the **⇄ Data Migrator** tab on the right edge of any Salesforce page.

Works in Chrome and Edge (Chromium 110+). No org setup, connected app, or admin install is needed.

## How to use

| Step | What happens |
| --- | --- |
| 1. Connect orgs | Lists every org you are logged in to. Pick a source; pick a destination for direct migration. Production orgs are flagged. |
| 2. Select records | Paste record Ids (15 or 18 chars, any mix of objects) or a SOQL query that selects `Id`. Validated against the org before anything runs. |
| 3. Discovery rules | Max depth, max records, which relationship types to follow, include/exclude objects and fields, and which child relationships (e.g. Account → Contacts) to pull in. Save as named profiles; export/import as JSON to share with your team. |
| 4. Discover | Builds the record graph. Each record is fetched once even when many records share it. Shows counts, a browsable record table, an expandable relationship tree and every reference that was not included (and why). Stops safely at limits and says the result is incomplete. |
| 5. Export (Mode A) | Zip with one CSV per object (source Ids kept), `load-order.json` (insert waves + deferred updates), `dependencies.csv`, `unresolved.csv`, `reference-data.csv`, `manifest.json`, README. |
| 6. Migrate (Mode B) | Per-object: Insert / Upsert / Reuse-or-insert / Reuse-only / Skip, match field, and "store source Id in" an External ID field. Owner matching (username with sandbox suffix change, email, federation Id, or you), record types by developer name, unresolved-lookup policy, batch size, prior Id-mapping file. **Preview** first (counts, load order, unresolved references, field differences, picklist conflicts, estimated API calls), then approve (production destinations require typing the org name). Results with per-record errors, downloadable report and Id mapping. |
| Import package | Load an export zip (yours or a teammate's) and migrate it without the source org connected. |

**Recommended for repeatable migrations:** create a text External ID field such as `Source_Id__c` on migrated objects in the destination and choose it under *Store source Id in*. Runs then upsert on it, so re-running never creates duplicates and a failed run can simply be repeated.

## Design decisions

- **Authentication: existing browser session**, the same model Salesforce Inspector uses. Anyone can install it with no connected app (since September 2025 Salesforce blocks uninstalled connected apps for most users, which would require an admin per org). The session is read on demand from Chrome's cookie store, used only against validated Salesforce API hosts, never written to storage or logs, and you revoke it by logging out. It acts strictly as you: CRUD, field-level security and sharing all apply.
- **Engine separate from UI**: `src/core` is plain TypeScript with no Chrome APIs and is tested against an in-memory Salesforce org.
- **Ordering**: record-level dependency graph, Tarjan cycle detection, the fewest possible nillable non-master-detail references deferred to a follow-up update; cycles through required fields are reported as blocked.
- **Writes**: sObject Collections (200 per call, `allOrNone=false`) for partial success; upsert on External ID for idempotent writes. Transient errors (503, concurrency limits, record locks) are retried; an insert whose outcome is unknown after a network failure is never retried blindly — the run stops and says so.
- **Security**: single host gate (`https` + Salesforce API domains only, incl. Government Cloud `.mil`), strict CSP, no remote code, no telemetry, no third-party calls, record data rendered as text only, session ids redacted from any error text. Settings and profiles are stored; records and sessions are not.

## Tests

`npm install && npm test` — 33 automated tests, covering scenarios 1–17 from the brief: Contact→Account without sibling Contacts, shared parents, multi-level and custom lookups, self-reference, circular dependencies, depth/record limits, missing/excluded targets, destination Id remapping, reuse of existing records, validation-rule failures with partial success, 401 refresh and expiry, 503 retry, no duplicate inserts on re-run or after a network failure, cancellation, export → re-import → migrate round trip, report accuracy, CSV/ZIP/Id/SOQL/host-gate units. The full UI was also driven end to end in headless Chromium against two simulated orgs.

`npm run package` rebuilds `dist/` and the installable zip.

## Known limitations

- Not migrated: Files/Attachments (ContentVersion binary data), Notes, feeds, field history, share rows, setup metadata. Users, queues, profiles and roles are matched, never created.
- Data is held in the browser tab's memory; hard cap 50,000 records per run. Use Bulk API tooling for larger volumes.
- Destination automation (triggers, flows, validation/duplicate rules, emails) runs on insert.
- Orgs that disable API access for your profile, or Government Cloud orgs whose policy blocks extensions, cannot be used.
- Not yet tested against live orgs by the author: please validate in sandboxes first.

## Development

- Setup, daily loop, release and the first GitHub push: [`docs/SETUP.md`](docs/SETUP.md)
- Rules and architecture for contributors and Claude Code: [`CLAUDE.md`](CLAUDE.md) and [`project/01_PROJECT_CONTEXT.txt`](project/01_PROJECT_CONTEXT.txt)
- Quick start: `npm install && npm run typecheck && npm test && npm run build`
