// Regenerates the Claude Project knowledge files that are derived from code:
//   project/02_CODE_MAP.txt      exported API of every module (types in full, function/method signatures)
//   project/05_SOURCE_BUNDLE.txt full source (optional upload; attach single files instead when possible)
// Hand-written files (00, 01, 03, 04) are not touched. Run: npm run project-files
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const today = new Date().toISOString().slice(0, 10);
mkdirSync('project', { recursive: true });

function walk(dir, exts) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, exts) : exts.some((e) => n.endsWith(e)) ? [p] : [];
  }).sort();
}

/** Index just past the brace block that opens at or after `from`. */
function blockEnd(src, from) {
  let depth = 0, i = src.indexOf('{', from), q = null;
  if (i < 0) return src.indexOf(';', from) + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return src.length;
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const cut = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function classMembers(body) {
  const out = [];
  let depth = 0;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (depth === 1 && line && !line.startsWith('//') && !/^private\b/.test(line) && !line.startsWith('}')) {
      const m = /^(?:public\s+|static\s+|readonly\s+|async\s+|get\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*[(<:=?!]/.exec(line);
      if (m && !['if', 'for', 'while', 'return', 'switch', 'const', 'let'].includes(m[1])) out.push('  ' + cut(oneLine(line.replace(/\{\s*$/, '').replace(/\s*=\s*\(.*$/, ''))));
    }
    for (const c of line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`[^`]*`/g, '')) {
      if (c === '{') depth++;
      if (c === '}') depth--;
    }
  }
  return out;
}

function summarize(file) {
  const src = readFileSync(file, 'utf8');
  const lines = [];
  const purpose = src.match(/^(\/\/[^\n]*\n)+/);
  if (purpose) lines.push(...purpose[0].trim().split('\n').map((l) => l.replace(/^\/\/\s?/, '')));
  const re = /^export\s+(?:default\s+)?(?:declare\s+)?(async\s+function\*?|function\*?|class|interface|type|const|let|enum)\s+([A-Za-z_$][\w$]*)/gm;
  let m, any = false;
  while ((m = re.exec(src))) {
    any = true;
    const kind = m[1], start = m.index;
    if (kind === 'interface' || (kind === 'type' && /^[^=\n]*=\s*(\{|\n|\|)/.test(src.slice(start, start + 300)))) {
      let end;
      if (kind === 'interface') end = blockEnd(src, start);
      else {
        const t = /;[ \t]*(\/\/[^\n]*)?\n/g;
        t.lastIndex = start;
        const hit = t.exec(src);
        end = hit ? hit.index + hit[0].length - 1 : src.length;
      }
      lines.push(src.slice(start, end).replace(/^export\s+/, '').replace(/\n\s*\/\/.*$/gm, '').replace(/\n{2,}/g, '\n'));
    } else if (kind === 'type' || kind === 'const' || kind === 'let' || kind === 'enum') {
      lines.push(cut(oneLine(src.slice(start, src.indexOf('\n', start)).replace(/^export\s+/, '')), 220));
    } else if (kind === 'class') {
      const end = blockEnd(src, start);
      const header = src.slice(start, src.indexOf('{', start)).replace(/^export\s+/, '');
      lines.push(oneLine(header) + ' {', ...classMembers(src.slice(src.indexOf('{', start), end)), '}');
    } else {
      const open = src.indexOf(' {\n', start);
      lines.push(cut(oneLine(src.slice(start, open).replace(/^export\s+/, '')), 260));
    }
  }
  if (!any) {
    // Entry points and UI: list top-level functions so callers know what exists.
    const fre = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm;
    const fns = [];
    while ((m = fre.exec(src))) fns.push(`${m[1]}(${oneLine(m[2])})`);
    if (fns.length) lines.push('Top-level functions: ' + fns.join(', '));
  }
  return lines.join('\n');
}

const srcFiles = walk('src', ['.ts']);
const header = (title) => `${title}\nProject: Salesforce Data Migrator · version ${pkg.version} · generated ${today} by scripts/project-files.mjs\nDo not edit by hand: run "npm run project-files" after code changes and re-upload.\n`;

let map = header('CODE MAP — exported API of every source file') + '\n';
map += 'Read this before asking for source. Each section: purpose comment, then exported types (full) and function/class signatures.\n';
map += 'Line counts help decide whether to attach a whole file or only part of it.\n\n';
for (const f of srcFiles) {
  const n = readFileSync(f, 'utf8').split('\n').length;
  map += `${'='.repeat(78)}\n${relative(root, f)}  (${n} lines)\n${'='.repeat(78)}\n${summarize(f)}\n\n`;
}
const tests = walk('tests', ['.ts']);
map += `${'='.repeat(78)}\nTESTS\n${'='.repeat(78)}\n`;
for (const f of tests) {
  const src = readFileSync(f, 'utf8');
  const names = [...src.matchAll(/^\s*it\('([^']+)'/gm)].map((x) => '  - ' + x[1]);
  const about = {
    'tests/fakeOrg.ts': 'FakeOrg: in-memory Salesforce org serving the REST endpoints the client uses (versions, describe, query+explain+paging, collections retrieve/create/update/upsert), with required-field, cross-reference, restricted-picklist and custom validation checks; standardSchema() = User, Group, RecordType, Region__c, Customer__c, Account, Contact, Invoice__c (master-detail).',
    'tests/harness/harness.ts': 'Browser harness: runs the real app UI against two FakeOrgs with a stubbed chrome.* API (build with tests/harness/build-harness.mjs <outDir>, open harness.html, drive with Playwright).',
  }[relative(root, f)] ?? '';
  map += `${relative(root, f)} (${src.split('\n').length} lines)${names.length ? '\n' + names.join('\n') : ' — ' + about}\n`;
}
writeFileSync('project/02_CODE_MAP.txt', map);

const bundleFiles = [...srcFiles, ...walk('static', ['.html', '.css', '.json']), 'build.mjs', 'package.json', 'tsconfig.json', 'scripts/project-files.mjs', ...tests, 'tests/harness/build-harness.mjs'];
let bundle = header('SOURCE BUNDLE — complete source of the extension') + '\nFiles in this bundle:\n' + bundleFiles.map((f) => '  ' + relative(root, f)).join('\n') + '\n\n';
for (const f of bundleFiles) bundle += `${'#'.repeat(78)}\n### FILE: ${relative(root, f)}\n${'#'.repeat(78)}\n${readFileSync(f, 'utf8')}\n`;
writeFileSync('project/05_SOURCE_BUNDLE.txt', bundle);

const tok = (s) => Math.round(s.length / 4);
console.log(`project/02_CODE_MAP.txt      ~${tok(map).toLocaleString()} tokens`);
console.log(`project/05_SOURCE_BUNDLE.txt ~${tok(bundle).toLocaleString()} tokens`);
