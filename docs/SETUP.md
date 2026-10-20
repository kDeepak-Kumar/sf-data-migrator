# Setup & workflow reference (reuse for every app)

## 1. Where things live
| Thing | Tool | Purpose |
|---|---|---|
| Idea, spec, design, reviews | claude.ai **Project** (one per app) | Persistent instructions + knowledge files, planning chats |
| Writing, running, testing code | **Claude Code** in the cloned repo | Edits files, runs commands, commits |
| Code, history, CI, releases | **GitHub** | Single source of truth |
| Secrets | `.env` (local only, git-ignored) | Never in code, chat or commits |

Rule: **plan in the Project, build in Claude Code.** If the Project files and the code disagree, the code wins.

## 2. One-time machine setup
1. Install VS Code, Git, Node.js 22 LTS.
2. `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.
3. Create a GitHub account; add an SSH key or sign in with `gh auth login`.
4. Install Claude Code (docs.claude.com) and sign in with your Claude account.
5. Create one claude.ai Project named "Master Standards" and paste your default stack and rules into its instructions (see section 6).

## 3. This repo: first push
```bash
cd sf-data-migrator
git init -b main
git add .
git commit -m "Initial commit: Salesforce Data Migrator v1.0.0"
# create an EMPTY repo on github.com (no README/.gitignore), then:
git remote add origin git@github.com:<your-user>/sf-data-migrator.git
git push -u origin main
```
Then in GitHub: Settings → Branches → protect `main` (require CI to pass). CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push and PR.

## 4. Daily loop
1. Open the repo in Claude Code (`claude` in the folder). It reads `CLAUDE.md` automatically.
2. Describe the change; for big ones ask for a plan first and reply "go".
3. `npm run typecheck && npm test`.
4. Bump `package.json` version if user-visible; add a `project/03_CHANGELOG.txt` entry.
5. `npm run project-files`.
6. `git add -A && git commit -m "..." && git push`.
7. Re-upload `project/02_CODE_MAP.txt` (and any changed 01/03) to the claude.ai Project.

## 5. Release
```bash
npm run package                      # builds sf-data-migrator-extension-v<version>.zip
git tag v<version> && git push --tags
```
Attach the zip to a GitHub Release (zips are git-ignored on purpose). Install: chrome://extensions → Developer mode → Load unpacked → unzipped folder.

## 6. Template for the next app
Every new app repo should start with:
- `CLAUDE.md` (commands, rules, definition of done, "read first" pointers)
- `docs/` or `project/` with: context (purpose, architecture, decisions, invariants, backlog), changelog, workflow
- `.gitignore`, `.env.example` (only if the app uses secrets), `README.md`
- `.github/workflows/ci.yml` running typecheck, tests, build
- Tests from day one, and a generated code map if the codebase is large

Paste into the "Master Standards" Project (edit to taste):
> You are my lead engineer. Plan first for large changes and wait for "go". Return minimal diffs, not whole files. Every change needs tests and a changelog entry. Never put secrets in code or chat. Ask before adding paid services or runtime dependencies. Be concise.

## 7. Safety checklist (all apps)
- Never paste tokens, passwords or session ids into chats; use `.env` and rotate anything leaked.
- Never commit `.env`, `node_modules`, build output, or customer/org data.
- Test on a sandbox before production; keep a backup or rollback path for anything that writes data.
