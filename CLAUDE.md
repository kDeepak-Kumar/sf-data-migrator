# Salesforce Data Migrator — instructions for Claude Code

Chrome (Manifest V3) extension in TypeScript. Admins select Salesforce records, the tool discovers everything they reference, then exports a migration package or migrates directly into another org with Id remapping. No runtime dependencies, no backend, no secrets.

## Read first (source of truth)
- `project/01_PROJECT_CONTEXT.txt` — purpose, architecture, decisions (D1–D9), invariants (I1–I9), export format, backlog.
- `project/02_CODE_MAP.txt` — every module's exported types and signatures, plus the test list. Plan from this before opening source files.
- `project/03_CHANGELOG.txt` — what shipped; current version.
- `project/00_PROJECT_INSTRUCTIONS.txt` — the same rules the claude.ai Project uses.
If these files and the code disagree, the code wins; then run `npm run project-files`.

## Commands
- `npm install` once, then `npm run typecheck && npm test` after every change.
- `npm run build` → `dist/` (load unpacked in chrome://extensions).
- `npm run package` → typecheck + test + build + `sf-data-migrator-extension-v<version>.zip`.
- `npm run project-files` → regenerates `project/02_CODE_MAP.txt` and `project/05_SOURCE_BUNDLE.txt`.

## Rules (do not break; details in 01, "Invariants")
- `src/core` has no `chrome.*` or DOM APIs and imports nothing from `src/platform` or `src/ui`. Chrome code → `src/platform`; UI → `src/ui`.
- Every Salesforce request goes through `SalesforceClient` (host gate, retries, usage). No raw `fetch` elsewhere.
- No hardcoded object or field names in engine logic; use describe metadata. Only User, Group and RecordType matching is named.
- Never write a source-org Id to the destination. Never retry a create whose outcome is unknown.
- Nothing is written before the preview is approved; production destinations need the typed org-name confirmation.
- No telemetry, third-party network calls, remote code, or `innerHTML` with data (use `h()` from `src/ui/dom.ts`).
- Every behaviour change ships with or updates a Vitest test (`tests/engine.test.ts` against FakeOrg, or `tests/units.test.ts`).
- Don't claim a feature works unless code and tests exist. Say plainly what is untested against a live org.

## Definition of done
1. Code follows the rules above.
2. `npm run typecheck && npm test` passes.
3. Bump `version` in `package.json` if user-visible (patch = fix, minor = feature). Build copies it into the manifest.
4. Add a `project/03_CHANGELOG.txt` entry (format at top of that file).
5. If invariants, decisions, UI flow or backlog changed, update `project/01_PROJECT_CONTEXT.txt`.
6. Run `npm run project-files`.
7. Commit with a clear message; never commit `dist/`, zips, or secrets.

## Working style
Edit files directly with minimal diffs; don't reprint whole files. For large changes, propose a short plan (files, functions, tests) and wait for "go". Be concise.
