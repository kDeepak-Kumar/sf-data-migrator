// Main extension page: Connect → Select → Rules → Discover → Export / Migrate, plus Import package.

import { h, clear, download, fmt, stamp, readFile, select } from './dom';
import { listSessions, sessionForUiHost, connect, OrgConnection, DetectedSession } from '../platform/session';
import { parseIdList } from '../core/ids';
import { checkSoql, normalizeSoql } from '../core/soql';
import { DiscoveryEngine, resolveSeeds, DiscoveryProgress } from '../core/discovery';
import { defaultRules, DiscoveryRules, validateRules, DEFAULT_EXCLUDED_OBJECTS, ChildRule } from '../core/rules';
import { collectReferenceData } from '../core/refdata';
import { RecordGraph, Edge, EdgeStatus } from '../core/graph';
import { CancelToken, sanitize } from '../core/errors';
import { MigrationPlanner, MigrationExecutor, defaultMigrationSettings, MigrationSettings, MigrationPlan, MigrationResult, MigrationProgress, summarize, Operation, PlannedAction } from '../core/migrate';
import { zipExportPackage, objectCsv, dependenciesCsv, readExportPackage, buildMigrationReport, previewCsv, parseMappingCsv } from '../core/package';
import { toCsv } from '../core/csv';
import type { FieldInfo } from '../core/describe';

type Step = 'connect' | 'select' | 'rules' | 'discover' | 'export' | 'migrate' | 'import' | 'help';

interface SessionRow {
  session: DetectedSession;
  conn?: OrgConnection;
  error?: string;
  loading: boolean;
}

const state = {
  step: 'connect' as Step,
  sessions: [] as SessionRow[],
  scanning: false,
  source: null as OrgConnection | null,
  dest: null as OrgConnection | null,
  selMode: 'ids' as 'ids' | 'soql',
  selText: '',
  seeds: null as Map<string, string[]> | null,
  selWarnings: [] as string[],
  selError: '',
  validating: false,
  rules: defaultRules(),
  profiles: {} as Record<string, DiscoveryRules>,
  childObject: '',
  childOptions: [] as { childSObject: string; field: string; relationshipName: string | null }[],
  graph: null as RecordGraph | null,
  graphOrigin: '' as '' | 'discovery' | 'package',
  discovering: false,
  discProgress: null as DiscoveryProgress | null,
  discLog: [] as string[],
  cancel: null as CancelToken | null,
  browseObject: '',
  mig: defaultMigrationSettings(),
  destFields: new Map<string, FieldInfo[]>(),
  destMetaLoading: false,
  plan: null as MigrationPlan | null,
  planning: false,
  approved: false,
  confirmText: '',
  running: false,
  migProgress: null as MigrationProgress | null,
  result: null as MigrationResult | null,
  resultFilter: 'problems' as 'all' | 'problems',
  showLauncher: true,
};

// ---------------- persistence (settings only, never records or sessions) ----------------

async function loadSettings() {
  const s = await chrome.storage.local.get(['rules', 'profiles', 'mig', 'showLauncher']);
  if (s.rules) state.rules = { ...defaultRules(), ...s.rules };
  if (s.profiles) state.profiles = s.profiles as Record<string, DiscoveryRules>;
  if (s.mig) state.mig = { ...defaultMigrationSettings(), ...s.mig, priorMappings: [] };
  if (s.showLauncher === false) state.showLauncher = false;
}
function saveSettings() {
  const { priorMappings: _ignored, ...mig } = state.mig;
  chrome.storage.local.set({ rules: state.rules, profiles: state.profiles, mig, showLauncher: state.showLauncher });
}

// ---------------- toasts ----------------

function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info') {
  const box = document.getElementById('toasts')!;
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, sanitize(msg));
  box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : 4000);
}

function errMsg(e: unknown) {
  return sanitize(e instanceof Error ? e.message : String(e));
}

// ---------------- shell ----------------

const STEPS: { id: Step; label: string; hint: string }[] = [
  { id: 'connect', label: 'Connect orgs', hint: 'Source and destination' },
  { id: 'select', label: 'Select records', hint: 'Ids or SOQL' },
  { id: 'rules', label: 'Discovery rules', hint: 'What to follow' },
  { id: 'discover', label: 'Discover', hint: 'Build the record graph' },
  { id: 'export', label: 'Export', hint: 'Mode A: files' },
  { id: 'migrate', label: 'Migrate', hint: 'Mode B: direct to org' },
];

function stepDone(s: Step): boolean {
  switch (s) {
    case 'connect':
      return !!state.source || state.graphOrigin === 'package';
    case 'select':
      return !!state.seeds || state.graphOrigin === 'package';
    case 'rules':
      return !!state.graph;
    case 'discover':
      return !!state.graph;
    case 'export':
      return false;
    case 'migrate':
      return !!state.result;
    default:
      return false;
  }
}

function go(step: Step) {
  state.step = step;
  render();
  document.getElementById('main')?.scrollTo(0, 0);
}

function orgChip(label: string, c: OrgConnection | null) {
  if (!c) return h('div', { class: 'chip empty' }, h('span', { class: 'chip-label' }, label), 'Not connected');
  return h(
    'div',
    { class: 'chip', title: `${c.info.instanceUrl}\n${c.info.username ?? ''}` },
    h('span', { class: 'chip-label' }, label),
    h('span', { class: 'chip-name' }, c.info.name),
    envBadge(c),
  );
}

function envBadge(c: OrgConnection) {
  const prod = !c.info.isSandbox;
  return h('span', { class: `badge ${prod ? 'prod' : 'sbx'}` }, prod ? 'Production' : c.info.orgType);
}

function render() {
  const header = document.getElementById('orgs')!;
  clear(header);
  header.append(orgChip('Source', state.source), h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'), orgChip('Destination', state.dest));
  const usage = state.source?.client.usage;
  if (usage) header.append(h('span', { class: 'usage', title: 'Source org API requests used in the last 24 hours' }, `API ${fmt(usage.used)} / ${fmt(usage.max)}`));

  const nav = document.getElementById('nav')!;
  clear(nav);
  STEPS.forEach((s, i) =>
    nav.append(
      h(
        'button',
        { class: `step ${state.step === s.id ? 'active' : ''} ${stepDone(s.id) ? 'done' : ''}`, onclick: () => go(s.id), 'aria-current': state.step === s.id ? 'step' : undefined },
        h('span', { class: 'num' }, stepDone(s.id) ? '✓' : String(i + 1)),
        h('span', { class: 'txt' }, h('b', null, s.label), h('small', null, s.hint)),
      ),
    ),
  );
  nav.append(h('div', { class: 'nav-sep' }));
  nav.append(h('button', { class: `step minor ${state.step === 'import' ? 'active' : ''}`, onclick: () => go('import') }, h('span', { class: 'num' }, '⇪'), h('span', { class: 'txt' }, h('b', null, 'Import package'), h('small', null, 'Migrate an export zip'))));
  nav.append(h('button', { class: `step minor ${state.step === 'help' ? 'active' : ''}`, onclick: () => go('help') }, h('span', { class: 'num' }, '?'), h('span', { class: 'txt' }, h('b', null, 'Help & settings'), h('small', null, 'Limits, tips'))));

  const main = document.getElementById('main')!;
  clear(main);
  const views: Record<Step, () => Node> = { connect: viewConnect, select: viewSelect, rules: viewRules, discover: viewDiscover, export: viewExport, migrate: viewMigrate, import: viewImport, help: viewHelp };
  main.append(views[state.step]());
}

function page(title: string, lead: string, ...body: unknown[]) {
  return h('section', { class: 'page' }, h('h1', null, title), h("p", { class: "lead" }, lead), ...(body.flat().filter(Boolean) as Node[]));
}

function card(title: string | null, ...body: unknown[]) {
  return h('div', { class: 'card' }, title ? h('h2', null, title) : null, ...(body as Node[]));
}

function banner(kind: 'warn' | 'err' | 'info' | 'ok', ...text: unknown[]) {
  return h('div', { class: `banner ${kind}`, role: kind === 'err' ? 'alert' : undefined }, ...(text as Node[]));
}

function stat(label: string, value: string | number, kind = '') {
  return h('div', { class: `stat ${kind}` }, h('div', { class: 'stat-v' }, typeof value === 'number' ? fmt(value) : value), h('div', { class: 'stat-l' }, label));
}

function need(cond: boolean, msg: string, step: Step, label: string) {
  return cond ? null : banner('info', msg, ' ', h('button', { class: 'link', onclick: () => go(step) }, label));
}

// ---------------- Connect ----------------

async function scanSessions() {
  state.scanning = true;
  render();
  try {
    const sessions = await listSessions();
    state.sessions = sessions.map((s) => ({ session: s, loading: true }));
    render();
    await Promise.all(
      state.sessions.map(async (row) => {
        try {
          row.conn = await connect(row.session);
        } catch (e) {
          row.error = errMsg(e);
        }
        row.loading = false;
      }),
    );
  } catch (e) {
    toast(errMsg(e), 'err');
  }
  state.scanning = false;
  render();
}

function viewConnect() {
  const rows = state.sessions;
  return page(
    'Connect orgs',
    'The extension uses the Salesforce sessions already open in this browser. Log in to each org in a normal tab, then pick a source and (for direct migration) a destination.',
    card(
      'Logged-in orgs',
      h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: scanSessions, disabled: state.scanning }, state.scanning ? 'Scanning…' : 'Refresh')),
      rows.length === 0 && !state.scanning
        ? banner('info', 'No Salesforce sessions found. Open your org in another tab and log in, then click Refresh.')
        : h(
            'table',
            { class: 'grid' },
            h('thead', null, h('tr', null, h('th', null, 'Org'), h('th', null, 'Environment'), h('th', null, 'User'), h('th', null, 'Host'), h('th', null, ''))),
            h(
              'tbody',
              null,
              rows.map((r) =>
                h(
                  'tr',
                  null,
                  h('td', null, r.conn ? h('b', null, r.conn.info.name) : r.loading ? 'Checking…' : r.session.orgId),
                  h('td', null, r.conn ? envBadge(r.conn) : r.error ? h('span', { class: 'badge err' }, 'No API access') : ''),
                  h('td', null, r.conn?.info.username ?? (r.error ? h('span', { class: 'muted small' }, r.error) : '')),
                  h('td', { class: 'mono small' }, r.session.apiHost),
                  h(
                    'td',
                    { class: 'actions' },
                    r.conn &&
                      h(
                        'button',
                        { class: `btn sm ${state.source?.info.orgId === r.session.orgId ? 'on' : ''}`, onclick: () => setSource(r.conn!) },
                        state.source?.info.orgId === r.session.orgId ? 'Source ✓' : 'Use as source',
                      ),
                    r.conn &&
                      h(
                        'button',
                        { class: `btn sm ${state.dest?.info.orgId === r.session.orgId ? 'on' : ''}`, onclick: () => setDest(r.conn!) },
                        state.dest?.info.orgId === r.session.orgId ? 'Destination ✓' : 'Use as destination',
                      ),
                  ),
                ),
              ),
            ),
          ),
    ),
    state.source && state.dest && state.source.info.orgId === state.dest.info.orgId && banner('warn', 'Source and destination are the same org. Migrating will create copies of the records in the same org.'),
    state.dest && !state.dest.info.isSandbox && banner('warn', `The destination is a production org (${state.dest.info.name}). You will be asked to type its name before any record is written.`),
    h(
      'div',
      { class: 'row-end' },
      state.source && h('button', { class: 'btn ghost', onclick: () => ((state.source = null), (state.seeds = null), render()) }, 'Disconnect source'),
      state.dest && h('button', { class: 'btn ghost', onclick: () => ((state.dest = null), (state.plan = null), render()) }, 'Disconnect destination'),
      h('button', { class: 'btn primary', disabled: !state.source, onclick: () => go('select') }, 'Next: select records →'),
    ),
  );
}

function setSource(c: OrgConnection) {
  if (state.source?.info.orgId !== c.info.orgId) {
    state.seeds = null;
    if (state.graphOrigin === 'discovery') resetGraph();
  }
  state.source = c;
  render();
}
function setDest(c: OrgConnection) {
  state.dest = c;
  state.plan = null;
  state.destFields.clear();
  state.approved = false;
  render();
}
function resetGraph() {
  state.graph = null;
  state.graphOrigin = '';
  state.plan = null;
  state.result = null;
}

// ---------------- Select ----------------

async function validateSelection() {
  if (!state.source) return;
  state.validating = true;
  state.selError = '';
  state.selWarnings = [];
  state.seeds = null;
  render();
  try {
    const { client, describe } = state.source;
    if (state.selMode === 'ids') {
      const { ids, invalid } = parseIdList(state.selText);
      if (!ids.length) throw new Error('Enter at least one valid 15- or 18-character record Id.');
      if (invalid.length) state.selWarnings.push(`Ignored ${invalid.length} invalid value(s): ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`);
      const r = await resolveSeeds(client, describe, { ids, maxRecords: state.rules.maxRecords });
      state.seeds = r.seeds;
      state.selWarnings.push(...r.warnings);
    } else {
      const chk = checkSoql(state.selText);
      if (!chk.ok) throw new Error(chk.error);
      const r = await resolveSeeds(client, describe, { soql: normalizeSoql(state.selText), maxRecords: state.rules.maxRecords });
      state.seeds = r.seeds;
      state.selWarnings.push(...r.warnings);
    }
    if (!state.seeds.size) throw new Error('No records matched.');
    // Confirm the Ids exist and are readable.
    for (const [obj, ids] of state.seeds) {
      const d = await describe.describe(obj);
      if (!d.queryable) throw new Error(`Your user cannot query ${obj}.`);
      const found = await client.retrieve(obj, ids.slice(0, 2000), ['Id']);
      const missing = ids.filter((_, i) => i < found.length && !found[i]);
      if (missing.length) {
        state.selWarnings.push(`${missing.length} ${obj} Id(s) were not found or are not visible to you; they were removed.`);
        state.seeds.set(obj, ids.filter((id) => !missing.includes(id)));
      }
    }
    for (const [k, v] of state.seeds) if (!v.length) state.seeds.delete(k);
    if (!state.seeds.size) throw new Error('None of the records could be read.');
    state.childObject = [...state.seeds.keys()][0];
  } catch (e) {
    state.selError = errMsg(e);
    state.seeds = null;
  }
  state.validating = false;
  render();
}

function viewSelect() {
  const examples = state.selMode === 'ids' ? 'One Id per line, or comma separated.\n003XXXXXXXXXXXXXXX\n003YYYYYYYYYYYYYYY' : "SELECT Id FROM Contact WHERE AccountId = '001XXXXXXXXXXXXXXX'";
  return page(
    'Select records',
    'Choose the starting records. Their references are discovered automatically in the next steps.',
    need(!!state.source, 'Connect a source org first.', 'connect', 'Go to Connect'),
    card(
      null,
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        h('button', { role: 'tab', class: `tab ${state.selMode === 'ids' ? 'active' : ''}`, onclick: () => ((state.selMode = 'ids'), render()) }, 'Record Ids'),
        h('button', { role: 'tab', class: `tab ${state.selMode === 'soql' ? 'active' : ''}`, onclick: () => ((state.selMode = 'soql'), render()) }, 'SOQL query'),
      ),
      h('textarea', {
        class: 'code',
        rows: 8,
        spellcheck: 'false',
        placeholder: examples,
        value: state.selText,
        'aria-label': state.selMode === 'ids' ? 'Record Ids' : 'SOQL query',
        oninput: (e: Event) => {
          state.selText = (e.target as HTMLTextAreaElement).value;
          state.seeds = null;
          const b = document.getElementById('validate') as HTMLButtonElement | null;
          if (b) b.disabled = !state.source || state.validating || !state.selText.trim();
        },
      }),
      state.selMode === 'soql' && h('p', { class: 'muted small' }, 'The query must select Id. It is checked by Salesforce (explain) before it runs. Up to the record limit in Rules is used.'),
      h('div', { class: 'toolbar' }, h('button', { id: 'validate', class: 'btn primary', disabled: !state.source || state.validating || !state.selText.trim(), onclick: validateSelection }, state.validating ? 'Validating…' : 'Validate selection')),
      state.selError && banner('err', state.selError),
      state.selWarnings.map((w) => banner('warn', w)),
      state.seeds &&
        banner(
          'ok',
          `Selected ${[...state.seeds.values()].reduce((a, b) => a + b.length, 0)} record(s): `,
          [...state.seeds].map(([o, ids]) => `${o} (${ids.length})`).join(', '),
        ),
    ),
    h('div', { class: 'row-end' }, h('button', { class: 'btn', onclick: () => go('connect') }, '← Back'), h('button', { class: 'btn primary', disabled: !state.seeds, onclick: () => go('rules') }, 'Next: rules →')),
  );
}

// ---------------- Rules ----------------

function listInput(label: string, value: string[], set: (v: string[]) => void, hint: string) {
  return h(
    'label',
    { class: 'field wide' },
    h('span', null, label),
    h('textarea', {
      rows: 2,
      class: 'code',
      value: value.join(', '),
      oninput: (e: Event) => {
        set((e.target as HTMLTextAreaElement).value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean));
        saveSettings();
      },
    }),
    h('small', { class: 'muted' }, hint),
  );
}

async function loadChildOptions() {
  if (!state.source || !state.childObject) return;
  try {
    const name = await state.source.describe.resolveName(state.childObject);
    if (!name) throw new Error(`Object ${state.childObject} not found in the source org.`);
    const d = await state.source.describe.describe(name);
    state.childObject = name;
    state.childOptions = d.childRelationships.filter((c) => c.relationshipName).sort((a, b) => a.childSObject.localeCompare(b.childSObject));
    render();
  } catch (e) {
    toast(errMsg(e), 'err');
  }
}

function viewRules() {
  const r = state.rules;
  const num = (label: string, key: 'maxDepth' | 'maxRecords', hint: string, max: number) =>
    h(
      'label',
      { class: 'field' },
      h('span', null, label),
      h('input', {
        type: 'number',
        min: key === 'maxDepth' ? 0 : 1,
        max,
        value: r[key],
        oninput: (e: Event) => {
          r[key] = Number((e.target as HTMLInputElement).value);
          saveSettings();
        },
      }),
      h('small', { class: 'muted' }, hint),
    );
  const check = (label: string, key: 'followLookups' | 'followMasterDetail' | 'followPolymorphic') =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r[key], onchange: (e: Event) => ((r[key] = (e.target as HTMLInputElement).checked), saveSettings()) }), label);
  const isOn = (c: { childSObject: string; field: string }) => r.childRules.some((x) => x.parentObject === state.childObject && x.childObject === c.childSObject && x.field === c.field);
  const toggleChild = (c: { childSObject: string; field: string; relationshipName: string | null }, on: boolean) => {
    r.childRules = r.childRules.filter((x) => !(x.parentObject === state.childObject && x.childObject === c.childSObject && x.field === c.field));
    if (on) r.childRules.push({ parentObject: state.childObject, childObject: c.childSObject, field: c.field, relationshipName: c.relationshipName, maxPerParent: 50 });
    saveSettings();
    render();
  };
  const profileNames = Object.keys(state.profiles).sort();
  let newProfile = '';
  return page(
    'Discovery rules',
    'Control how far discovery goes. By default only references stored on each record are followed (child → parent); child records are pulled in only for relationships you switch on below.',
    card(
      'Limits',
      h('div', { class: 'form' }, num('Max depth', 'maxDepth', 'Hops away from the selected records (0 = only the selected records).', 10), num('Max records', 'maxRecords', 'Discovery stops safely and reports when reached.', 50000)),
    ),
    card(
      'Relationship types to follow',
      h('div', { class: 'checks' }, check('Lookups', 'followLookups'), check('Master-detail', 'followMasterDetail'), check('Polymorphic (WhatId, WhoId, ParentId…)', 'followPolymorphic')),
      h('p', { class: 'muted small' }, 'Users, queues and record types are never copied; they are matched in the destination during migration.'),
    ),
    card(
      'Fields to extract',
      h(
        'div',
        { class: 'checks' },
        h('label', { class: 'check' }, h('input', { type: 'radio', name: 'fm', checked: r.fieldMode === 'writable', onchange: () => ((r.fieldMode = 'writable'), saveSettings()) }), 'Migratable fields (createable or updateable, plus Name)'),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: 'fm', checked: r.fieldMode === 'all', onchange: () => ((r.fieldMode = 'all'), saveSettings()) }), 'All readable fields (full snapshot, includes formulas and system fields)'),
      ),
    ),
    card(
      'Objects and fields',
      listInput('Only these objects (optional)', r.includeObjects, (v) => (r.includeObjects = v), 'Leave empty to allow every object. Selected records are always included.'),
      listInput('Exclude objects', r.excludeObjects, (v) => (r.excludeObjects = v), 'References to these objects are reported, not followed.'),
      h('button', { class: 'btn sm ghost', onclick: () => ((r.excludeObjects = [...DEFAULT_EXCLUDED_OBJECTS]), saveSettings(), render()) }, 'Reset to default exclusions'),
      listInput('Exclude fields', r.excludeFields, (v) => (r.excludeFields = v), 'As Object.Field or *.Field (any object), e.g. Account.ParentId, *.CreatedById'),
    ),
    card(
      'Child records (reverse relationships)',
      h('p', { class: 'muted small' }, 'Example: selecting an Account and switching on Account → Contact (AccountId) also brings that Account’s Contacts. Off by default.'),
      h(
        'div',
        { class: 'toolbar' },
        h('input', { class: 'inline', placeholder: 'Parent object, e.g. Account', value: state.childObject, oninput: (e: Event) => (state.childObject = (e.target as HTMLInputElement).value.trim()) }),
        h('button', { class: 'btn sm', disabled: !state.source, onclick: loadChildOptions }, 'Load child relationships'),
      ),
      state.childOptions.length > 0 &&
        h(
          'div',
          { class: 'scroll-list' },
          state.childOptions.map((c) =>
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: isOn(c), onchange: (e: Event) => toggleChild(c, (e.target as HTMLInputElement).checked) }), h('span', null, `${c.relationshipName} → ${c.childSObject}.${c.field}`)),
          ),
        ),
      r.childRules.length > 0 &&
        h(
          'table',
          { class: 'grid compact' },
          h('thead', null, h('tr', null, h('th', null, 'Parent'), h('th', null, 'Child via field'), h('th', null, 'Max per parent'), h('th', null, ''))),
          h(
            'tbody',
            null,
            r.childRules.map((c: ChildRule, i) =>
              h(
                'tr',
                null,
                h('td', null, c.parentObject),
                h('td', null, `${c.childObject}.${c.field}`),
                h('td', null, h('input', { type: 'number', class: 'tiny', min: 1, value: c.maxPerParent ?? '', oninput: (e: Event) => ((c.maxPerParent = Number((e.target as HTMLInputElement).value) || undefined), saveSettings()) })),
                h('td', null, h('button', { class: 'btn sm ghost', onclick: () => (r.childRules.splice(i, 1), saveSettings(), render()) }, 'Remove')),
              ),
            ),
          ),
        ),
    ),
    card(
      'Saved profiles',
      h('p', { class: 'muted small' }, 'Save these rules under a name to reuse them, or share them as a JSON file with your team.'),
      h(
        'div',
        { class: 'toolbar' },
        h('input', { class: 'inline', placeholder: 'Profile name', oninput: (e: Event) => (newProfile = (e.target as HTMLInputElement).value.trim()) }),
        h('button', { class: 'btn sm', onclick: () => { if (!newProfile) return toast('Enter a profile name'); state.profiles[newProfile] = structuredClone(state.rules); saveSettings(); toast(`Saved profile "${newProfile}"`, 'ok'); render(); } }, 'Save'),
        h('button', { class: 'btn sm ghost', onclick: () => download(`sfdm-rules-${stamp()}.json`, JSON.stringify(state.rules, null, 2), 'application/json') }, 'Export JSON'),
        h('label', { class: 'btn sm ghost file' }, 'Import JSON', h('input', { type: 'file', accept: '.json', onchange: async (e: Event) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (!f) return;
          try {
            const parsed = JSON.parse(new TextDecoder().decode(await readFile(f)));
            const merged = { ...defaultRules(), ...parsed };
            const errs = validateRules(merged);
            if (errs.length) throw new Error(errs.join(' '));
            state.rules = merged;
            saveSettings();
            toast('Rules imported', 'ok');
            render();
          } catch (err) {
            toast(`Could not import rules: ${errMsg(err)}`, 'err');
          }
        } })),
      ),
      profileNames.length > 0 &&
        h(
          'div',
          { class: 'pills' },
          profileNames.map((n) =>
            h('span', { class: 'pill' }, h('button', { class: 'link', onclick: () => { state.rules = { ...defaultRules(), ...structuredClone(state.profiles[n]) }; saveSettings(); toast(`Loaded "${n}"`, 'ok'); render(); } }, n), h('button', { class: 'x', 'aria-label': `Delete ${n}`, onclick: () => { delete state.profiles[n]; saveSettings(); render(); } }, '×')),
          ),
        ),
    ),
    h('div', { class: 'row-end' }, h('button', { class: 'btn', onclick: () => go('select') }, '← Back'), h('button', { class: 'btn primary', onclick: () => { const errs = validateRules(state.rules); if (errs.length) return toast(errs.join(' '), 'err'); go('discover'); } }, 'Next: discover →')),
  );
}

// ---------------- Discover ----------------

async function runDiscovery() {
  if (!state.source || !state.seeds) return;
  const errs = validateRules(state.rules);
  if (errs.length) return toast(errs.join(' '), 'err');
  resetGraph();
  state.discovering = true;
  state.discLog = [];
  state.cancel = { cancelled: false };
  render();
  try {
    const engine = new DiscoveryEngine(state.source.client, state.source.describe);
    const g = await engine.run({
      seeds: state.seeds,
      rules: state.rules,
      cancel: state.cancel,
      onProgress: (p) => {
        state.discProgress = p;
        if (p.message) state.discLog.push(`Depth ${p.depth}: ${p.message}`);
        updateProgress();
      },
    });
    g.source = state.source.info;
    await collectReferenceData(state.source.client, g, state.cancel);
    state.graph = g;
    state.graphOrigin = 'discovery';
    state.browseObject = g.objects()[0] ?? '';
    toast(`Discovered ${g.nodes.size} record(s) across ${g.objects().length} object(s)`, 'ok');
  } catch (e) {
    toast(errMsg(e), 'err');
  }
  state.discovering = false;
  state.cancel = null;
  render();
}

function updateProgress() {
  const el = document.getElementById('live');
  if (!el) return;
  const p = state.discProgress;
  clear(el);
  el.append(
    h('div', { class: 'progress indeterminate' }, h('div', null)),
    h('p', null, p ? `${p.phase} · depth ${p.depth} · ${fmt(p.records)} record(s)` : 'Starting…'),
    h('pre', { class: 'log' }, state.discLog.slice(-8).join('\n')),
  );
}

const STATUS_TEXT: Record<EdgeStatus, string> = {
  'in-graph': 'Included',
  'reference-data': 'Matched at migration',
  excluded: 'Excluded by rules',
  'out-of-limit': 'Limit reached',
  missing: 'Not found / no access',
  'unknown-object': 'Unknown object',
};

function nodeLabel(g: RecordGraph, key: string) {
  const n = g.nodes.get(key);
  if (!n) return key;
  const name = n.fields.Name ?? n.fields.LastName ?? n.fields.Subject ?? n.fields.CaseNumber ?? '';
  return `${n.object} · ${name ? `${name} · ` : ''}${n.id}`;
}

function treeNode(g: RecordGraph, key: string, seen: Set<string>, depth: number): HTMLElement {
  const edges = g.edgesFrom(key);
  const d = h('details', { class: 'tree' }, h('summary', null, nodeLabel(g, key), edges.length ? h('span', { class: 'muted small' }, ` (${edges.length} reference${edges.length === 1 ? '' : 's'})`) : null));
  let filled = false;
  d.addEventListener('toggle', () => {
    if (filled || !d.open) return;
    filled = true;
    for (const e of edges) {
      const tk = g.targetKey(e);
      const row = h('div', { class: 'tree-edge' }, h('span', { class: 'mono small' }, e.field), ' → ');
      if (e.status === 'in-graph' && tk && !seen.has(tk) && depth < 12) {
        row.append(treeNode(g, tk, new Set([...seen, tk]), depth + 1));
      } else {
        row.append(h('span', null, e.status === 'in-graph' && tk ? nodeLabel(g, tk) : `${e.toObject ?? '?'} · ${e.toId}`), ' ', h('span', { class: `tag ${e.status}` }, e.status === 'in-graph' && tk && seen.has(tk) ? 'Cycle' : STATUS_TEXT[e.status]));
      }
      d.append(row);
    }
  });
  return d;
}

function viewDiscover() {
  const g = state.graph;
  const counts = g ? [...g.countsByObject()].sort((a, b) => b[1] - a[1]) : [];
  const issues = g ? g.issues() : [];
  const seedsTotal = state.seeds ? [...state.seeds.values()].reduce((a, b) => a + b.length, 0) : 0;
  return page(
    'Discover related records',
    'Fetches the selected records, follows their references according to your rules, and builds a dependency graph. Nothing is written anywhere.',
    need(!!state.seeds || state.graphOrigin === 'package', 'Select and validate records first.', 'select', 'Go to Select'),
    state.seeds &&
      card(
        null,
        h(
          'div',
          { class: 'toolbar spread' },
          h('div', null, h('b', null, `${seedsTotal} starting record(s)`), h('span', { class: 'muted' }, ` · depth ≤ ${state.rules.maxDepth} · up to ${fmt(state.rules.maxRecords)} records · ${state.rules.childRules.length} child relationship(s)`)),
          state.discovering
            ? h('button', { class: 'btn danger', onclick: () => state.cancel && (state.cancel.cancelled = true) }, 'Cancel')
            : h('button', { class: 'btn primary', onclick: runDiscovery }, g && state.graphOrigin === 'discovery' ? 'Run again' : 'Run discovery'),
        ),
        state.discovering && h('div', { id: 'live' }),
      ),
    g && g.truncated && banner('warn', h('b', null, 'Incomplete: '), 'discovery stopped at a configured limit. Records referenced beyond the limit are listed under References not included. Raise the limits in Rules if you need them.'),
    g && g.warnings.filter((w) => !w.startsWith('Discovery stopped')).map((w) => banner('warn', w)),
    g &&
      h(
        'div',
        { class: 'stats' },
        stat('Records', g.nodes.size),
        stat('Objects', g.objects().length),
        stat('Relationships', g.edges.filter((e) => e.status === 'in-graph').length),
        stat('Depth reached', g.maxDepthReached),
        stat('References not included', issues.length, issues.length ? 'warn' : ''),
      ),
    g &&
      card(
        'Records by object',
        h(
          'table',
          { class: 'grid' },
          h('thead', null, h('tr', null, h('th', null, 'Object'), h('th', null, 'Label'), h('th', { class: 'num' }, 'Records'), h('th', null, ''))),
          h('tbody', null, counts.map(([o, n]) => h('tr', null, h('td', { class: 'mono' }, o), h('td', null, g.objectLabels.get(o) ?? ''), h('td', { class: 'num' }, fmt(n)), h('td', { class: 'actions' }, h('button', { class: 'btn sm ghost', onclick: () => ((state.browseObject = o), render()) }, 'Browse'))))),
        ),
      ),
    g && state.browseObject && card(`Browse ${state.browseObject}`, recordTable(g, state.browseObject)),
    g &&
      card(
        'Relationship tree',
        h('p', { class: 'muted small' }, 'Expand a record to see each reference it holds and where it leads.'),
        h('div', { class: 'tree-root' }, [...g.nodes.values()].filter((n) => n.seed || state.graphOrigin === 'package').slice(0, 200).map((n) => treeNode(g, n.key, new Set([n.key]), 0))),
      ),
    g && issues.length > 0 && card('References not included', issueTable(g, issues)),
    g && h('div', { class: 'row-end' }, h('button', { class: 'btn', onclick: () => go('export') }, 'Export files →'), h('button', { class: 'btn primary', onclick: () => go('migrate') }, 'Migrate to destination →')),
  );
}

function recordTable(g: RecordGraph, object: string) {
  const nodes = g.nodesOf(object).slice(0, 100);
  const cols = new Set<string>();
  for (const n of nodes) Object.keys(n.fields).forEach((k) => cols.add(k));
  const prefer = ['Id', 'Name', 'FirstName', 'LastName', 'Email', 'Subject', 'Status'];
  const ordered = [...prefer.filter((c) => cols.has(c)), ...[...cols].filter((c) => !prefer.includes(c)).sort()];
  return h(
    'div',
    null,
    h('div', { class: 'table-scroll' }, h('table', { class: 'grid compact' }, h('thead', null, h('tr', null, ordered.map((c) => h('th', null, c)))), h('tbody', null, nodes.map((n) => h('tr', null, ordered.map((c) => h('td', null, cellText(c === 'Id' ? n.id : n.fields[c])))))))),
    g.nodesOf(object).length > 100 && h('p', { class: 'muted small' }, `Showing 100 of ${g.nodesOf(object).length}. Export for the full data.`),
  );
}

function cellText(v: unknown) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

function issueTable(g: RecordGraph, issues: Edge[]) {
  return h(
    'div',
    { class: 'table-scroll' },
    h(
      'table',
      { class: 'grid compact' },
      h('thead', null, h('tr', null, h('th', null, 'Record'), h('th', null, 'Field'), h('th', null, 'Points to'), h('th', null, 'Status'))),
      h('tbody', null, issues.slice(0, 300).map((e) => h('tr', null, h('td', null, nodeLabel(g, e.from)), h('td', { class: 'mono' }, e.field), h('td', null, `${e.toObject ?? '?'} · ${e.toId}`), h('td', null, h('span', { class: `tag ${e.status}` }, STATUS_TEXT[e.status]))))),
    ),
    issues.length > 300 && h('p', { class: 'muted small' }, `Showing 300 of ${issues.length}; the full list is in the export (unresolved.csv).`),
  );
}

// ---------------- Export ----------------

function viewExport() {
  const g = state.graph;
  const base = g?.source?.name?.replace(/[^\w-]+/g, '_') ?? 'export';
  return page(
    'Export (Mode A)',
    'Download a migration-ready package: one CSV per object with source Ids, the load order, every relationship, and the users/record types to match. Re-import it here later to migrate with automatic Id remapping, or load it with Data Loader.',
    need(!!g, 'Run discovery first.', 'discover', 'Go to Discover'),
    g && g.truncated && banner('warn', 'This dataset is incomplete because discovery hit a limit. The package says so in its manifest and README.'),
    g &&
      card(
        'Migration package',
        h('p', null, `${fmt(g.nodes.size)} records · ${g.objects().length} objects · ${fmt(g.edges.length)} references (${g.issues().length} not included)`),
        h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => { download(`sfdm-${base}-${stamp()}.zip`, zipExportPackage(g, state.rules) as BlobPart, 'application/zip'); toast('Package downloaded', 'ok'); } }, 'Download package (.zip)')),
        h('ul', { class: 'files' }, ['manifest.json — objects, fields, source org, warnings', 'objects/<Object>.csv — one per object, source Ids kept', 'load-order.json — insert waves and deferred updates', 'dependencies.csv, unresolved.csv — every reference and its status', 'reference-data.csv — users, queues, record types to match'].map((t) => h('li', null, t))),
      ),
    g &&
      card(
        'Single files',
        h(
          'div',
          { class: 'pills' },
          g.objects().sort().map((o) => h('button', { class: 'btn sm', onclick: () => download(`${o}.csv`, objectCsv(g, o), 'text/csv') }, `${o}.csv`)),
          h('button', { class: 'btn sm ghost', onclick: () => download('dependencies.csv', dependenciesCsv(g.edges, g), 'text/csv') }, 'dependencies.csv'),
        ),
      ),
  );
}

// ---------------- Import ----------------

function viewImport() {
  const g = state.graphOrigin === 'package' ? state.graph : null;
  return page(
    'Import package',
    'Load a package exported by this extension (from any org, by anyone on your team) and migrate it into a destination org. The source org does not need to be connected.',
    card(
      null,
      h(
        'label',
        { class: 'drop' },
        h('input', {
          type: 'file',
          accept: '.zip',
          onchange: async (e: Event) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (!f) return;
            try {
              const graph = await readExportPackage(await readFile(f));
              resetGraph();
              state.graph = graph;
              state.graphOrigin = 'package';
              state.browseObject = graph.objects()[0] ?? '';
              toast(`Loaded ${graph.nodes.size} records from ${f.name}`, 'ok');
            } catch (err) {
              toast(`Could not read package: ${errMsg(err)}`, 'err');
            }
            render();
          },
        }),
        h('b', null, 'Choose an export .zip'),
        h('span', { class: 'muted small' }, 'Files are read locally in your browser.'),
      ),
    ),
    g &&
      card(
        'Loaded package',
        h('p', null, `From ${g.source?.name ?? 'unknown org'} (${g.source?.orgId ?? ''}) · created ${new Date(g.createdAt).toLocaleString()}`),
        h('div', { class: 'stats' }, stat('Records', g.nodes.size), stat('Objects', g.objects().length), stat('References not included', g.issues().length, g.issues().length ? 'warn' : '')),
        g.truncated && banner('warn', 'The export was incomplete when it was created.'),
        h('div', { class: 'row-end' }, h('button', { class: 'btn', onclick: () => go('discover') }, 'Browse records'), h('button', { class: 'btn primary', onclick: () => go('migrate') }, 'Migrate →')),
      ),
  );
}

// ---------------- Migrate ----------------

async function loadDestMeta() {
  if (!state.dest || !state.graph || state.destMetaLoading) return;
  state.destMetaLoading = true;
  try {
    for (const o of state.graph.objects()) {
      if (state.destFields.has(o)) continue;
      const name = await state.dest.describe.resolveName(o);
      state.destFields.set(o, name ? (await state.dest.describe.describe(name)).fields : []);
    }
  } catch (e) {
    toast(errMsg(e), 'err');
  }
  state.destMetaLoading = false;
  render();
}

function invalidatePlan() {
  state.plan = null;
  state.approved = false;
  state.confirmText = '';
  saveSettings();
}

async function buildPreview() {
  if (!state.dest || !state.graph) return;
  state.planning = true;
  state.result = null;
  invalidatePlan();
  render();
  try {
    const planner = new MigrationPlanner(state.graph, state.dest.client, state.dest.describe, state.dest.info);
    state.plan = await planner.plan(state.mig);
    try {
      await state.dest.client.limits();
    } catch {
      /* usage header still updates */
    }
  } catch (e) {
    toast(errMsg(e), 'err');
  }
  state.planning = false;
  render();
}

async function runMigration() {
  if (!state.dest || !state.graph || !state.plan) return;
  state.running = true;
  state.cancel = { cancelled: false };
  state.migProgress = null;
  render();
  try {
    const exec = new MigrationExecutor(state.graph, state.plan, state.dest.client);
    state.result = await exec.run((p) => {
      state.migProgress = p;
      updateMigProgress();
    }, state.cancel);
    const s = summarize(state.result);
    toast(state.result.stoppedReason ? `Stopped: ${state.result.stoppedReason}` : `Done: ${s.inserted} inserted, ${s.updated} updated, ${s.reused} reused, ${s.failed} failed`, state.result.stoppedReason || s.failed ? 'err' : 'ok');
  } catch (e) {
    toast(errMsg(e), 'err');
  }
  state.running = false;
  state.cancel = null;
  state.approved = false;
  state.confirmText = '';
  render();
}

function updateMigProgress() {
  const el = document.getElementById('live');
  const p = state.migProgress;
  if (!el || !p) return;
  clear(el);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  el.append(h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })), h('p', null, `${pct}% · wave ${p.wave} of ${p.waves} · ${p.message}`));
}

const OPS: [Operation, string][] = [
  ['insert', 'Insert new'],
  ['upsert', 'Upsert (match field)'],
  ['reuse-or-insert', 'Reuse match, else insert'],
  ['reuse-only', 'Reuse match only'],
  ['skip', 'Skip'],
];

function objectSettingsTable() {
  const g = state.graph!;
  return h(
    'div',
    { class: 'table-scroll' },
    h(
      'table',
      { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, 'Object'), h('th', { class: 'num' }, 'Records'), h('th', null, 'Operation'), h('th', null, 'Match on (destination field)'), h('th', null, 'Store source Id in'))),
      h(
        'tbody',
        null,
        g.objects().sort().map((o) => {
          const os = (state.mig.objects[o] ??= { operation: 'insert' });
          const fields = state.destFields.get(o);
          const missing = fields && fields.length === 0;
          const matchable = (fields ?? []).filter((f) => (f.externalId || f.idLookup || f.unique) && f.name !== 'Id' && f.type !== 'reference');
          const idFields = (fields ?? []).filter((f) => f.externalId && (f.type === 'string' || f.type === 'textarea') && f.createable);
          return h(
            'tr',
            null,
            h('td', { class: 'mono' }, o, missing ? h('div', { class: 'badge err' }, 'Not in destination') : null),
            h('td', { class: 'num' }, fmt(g.nodesOf(o).length)),
            h('td', null, select(os.operation, OPS, (v) => ((os.operation = v as Operation), invalidatePlan(), render()))),
            h(
              'td',
              null,
              os.operation === 'insert' || os.operation === 'skip'
                ? h('span', { class: 'muted small' }, '—')
                : select(os.matchField ?? '', [['', 'Choose…'], ...matchable.map((f) => [f.name, `${f.label} (${f.name})`] as [string, string])], (v) => ((os.matchField = v || undefined), invalidatePlan(), render())),
            ),
            h(
              'td',
              null,
              idFields.length === 0
                ? h('span', { class: 'muted small', title: 'Create a text External ID field (e.g. Source_Id__c) on this object to make re-runs safe.' }, 'No text External ID field')
                : select(os.sourceIdField ?? '', [['', 'Don’t store'], ...idFields.map((f) => [f.name, f.name] as [string, string])], (v) => {
                    os.sourceIdField = v || undefined;
                    if (v && os.operation === 'insert') {
                      os.operation = 'upsert';
                      os.matchField = v;
                    }
                    invalidatePlan();
                    render();
                  }),
            ),
          );
        }),
      ),
    ),
  );
}

function viewMigrate() {
  const g = state.graph;
  const m = state.mig;
  if (g && state.dest && !state.destMetaLoading && g.objects().some((o) => !state.destFields.has(o))) setTimeout(loadDestMeta, 0);
  const prod = state.dest && !state.dest.info.isSandbox;
  const canRun = !!state.plan && state.approved && (!prod || state.confirmText.trim() === state.dest!.info.name) && !state.running;
  return page(
    'Migrate (Mode B)',
    'Copies the discovered records into the destination org in dependency order, remapping every lookup to the new destination Ids. Nothing is written until you review the preview and approve it.',
    need(!!g, 'Run discovery or import a package first.', 'discover', 'Go to Discover'),
    need(!!state.dest, 'Connect a destination org.', 'connect', 'Go to Connect'),
    g &&
      state.dest &&
      card(
        'Per-object settings',
        state.destMetaLoading && h('p', { class: 'muted' }, 'Loading destination metadata…'),
        objectSettingsTable(),
        h('p', { class: 'muted small' }, 'Tip: storing the source Id in a text External ID field (e.g. Source_Id__c) and choosing Upsert on it makes re-runs safe: nothing is duplicated and failed runs can simply be repeated.'),
      ),
    g &&
      state.dest &&
      card(
        'Matching and policies',
        h(
          'div',
          { class: 'form' },
          h(
            'label',
            { class: 'field' },
            h('span', null, 'Record owners (OwnerId)'),
            select(m.ownerStrategy, [['match-username', 'Match by Username'], ['match-email', 'Match by Email'], ['match-federation', 'Match by Federation Id'], ['running-user', 'Assign to me (destination user)']], (v) => ((m.ownerStrategy = v as MigrationSettings['ownerStrategy']), invalidatePlan(), render())),
            h('small', { class: 'muted' }, 'Unmatched owners fall back to you.'),
          ),
          m.ownerStrategy === 'match-username' &&
            h(
              'label',
              { class: 'field' },
              h('span', null, 'Username suffix change (optional)'),
              h(
                'div',
                { class: 'pair' },
                h('input', { placeholder: 'find e.g. @acme.com', value: m.usernameTransform?.find ?? '', oninput: (e: Event) => ((m.usernameTransform = { find: (e.target as HTMLInputElement).value, replace: m.usernameTransform?.replace ?? '' }), invalidatePlan()) }),
                h('input', { placeholder: 'replace e.g. @acme.com.uat', value: m.usernameTransform?.replace ?? '', oninput: (e: Event) => ((m.usernameTransform = { find: m.usernameTransform?.find ?? '', replace: (e.target as HTMLInputElement).value }), invalidatePlan()) }),
              ),
              h('small', { class: 'muted' }, 'Sandbox usernames usually carry a suffix like .uat.'),
            ),
          h('label', { class: 'field' }, h('span', null, 'Record types'), select(m.recordTypeStrategy, [['match-developer-name', 'Match by developer name'], ['omit', 'Use destination default']], (v) => ((m.recordTypeStrategy = v as MigrationSettings['recordTypeStrategy']), invalidatePlan(), render()))),
          h(
            'label',
            { class: 'field' },
            h('span', null, 'When an optional lookup cannot be resolved'),
            select(m.unresolvedPolicy, [['skip-record', 'Skip the record'], ['blank-field', 'Insert with the lookup blank']], (v) => ((m.unresolvedPolicy = v as MigrationSettings['unresolvedPolicy']), invalidatePlan(), render())),
            h('small', { class: 'muted' }, 'Required lookups (and master-detail) always skip the record.'),
          ),
          h('label', { class: 'field' }, h('span', null, 'Batch size'), h('input', { type: 'number', min: 1, max: 200, value: m.batchSize, oninput: (e: Event) => ((m.batchSize = Math.min(200, Math.max(1, Number((e.target as HTMLInputElement).value) || 200))), invalidatePlan()) }), h('small', { class: 'muted' }, 'Lower it if destination triggers hit limits (max 200).')),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.includeAuditFields, onchange: (e: Event) => ((m.includeAuditFields = (e.target as HTMLInputElement).checked), invalidatePlan()) }), 'Copy audit fields (CreatedDate…) — needs “Set Audit Fields upon Record Creation” in the destination'),
          h(
            'label',
            { class: 'field wide' },
            h('span', null, 'Id mapping from a previous run (optional)'),
            h('input', { type: 'file', accept: '.csv', onchange: async (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return; try { m.priorMappings = parseMappingCsv(new TextDecoder().decode(await readFile(f))); toast(`Loaded ${m.priorMappings.length} mappings`, 'ok'); invalidatePlan(); render(); } catch (err) { toast(errMsg(err), 'err'); } } }),
            h('small', { class: 'muted' }, `Use id-mapping.csv from an earlier migration report to reuse records already migrated.${m.priorMappings.length ? ` ${m.priorMappings.length} loaded.` : ''}`),
          ),
        ),
        h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', disabled: state.planning || state.running || state.destMetaLoading, onclick: buildPreview }, state.planning ? 'Building preview…' : state.plan ? 'Rebuild preview' : 'Build preview')),
      ),
    state.plan && previewView(state.plan, prod ?? false),
    state.plan &&
      card(
        'Approve and run',
        state.running
          ? h('div', null, h('div', { id: 'live' }, h('div', { class: 'progress' }, h('div', { style: 'width:0%' })), h('p', null, 'Starting…')), h('button', { class: 'btn danger', onclick: () => state.cancel && (state.cancel.cancelled = true) }, 'Cancel after current batch'))
          : h(
              'div',
              null,
              h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.approved, onchange: (e: Event) => ((state.approved = (e.target as HTMLInputElement).checked), render()) }), `I reviewed the preview. Write records to ${state.dest!.info.name}.`),
              prod && h('label', { class: 'field' }, h('span', null, `Production destination: type the org name “${state.dest!.info.name}” to confirm`), h('input', { value: state.confirmText, oninput: (e: Event) => { state.confirmText = (e.target as HTMLInputElement).value; const b = document.getElementById('runbtn') as HTMLButtonElement | null; if (b) b.disabled = !(state.approved && state.confirmText.trim() === state.dest!.info.name); } })),
              h('div', { class: 'toolbar' }, h('button', { id: 'runbtn', class: 'btn primary', disabled: !canRun, onclick: runMigration }, 'Run migration')),
            ),
      ),
    state.result && state.plan && resultView(state.result, state.plan),
  );
}

function previewView(plan: MigrationPlan, prod: boolean) {
  const tot = (a: PlannedAction) => [...plan.counts.values()].reduce((s, c) => s + c[a], 0);
  const usage = state.dest?.client.usage;
  const order = plan.waves.map((w, i) => {
    const per = new Map<string, number>();
    for (const k of w) {
      const o = plan.nodes.get(k)!.object;
      per.set(o, (per.get(o) ?? 0) + 1);
    }
    return `${i + 1}. ${[...per].map(([o, n]) => `${o} (${n})`).join(', ')}`;
  });
  return card(
    'Preview',
    h('p', { class: 'muted' }, `${plan.source?.name ?? 'Package'} → ${plan.destination.name} (${prod ? 'Production' : plan.destination.orgType})`),
    h(
      'div',
      { class: 'stats' },
      stat('Insert', tot('insert')),
      stat('Upsert', tot('upsert')),
      stat('Reuse existing', tot('reuse')),
      stat('Skip', tot('skip'), tot('skip') ? 'warn' : ''),
      stat('Blocked', tot('blocked'), tot('blocked') ? 'err' : ''),
      stat('Deferred updates', plan.deferred.length),
      stat('Est. API calls', `~${plan.estimatedCalls}`),
      usage ? stat('Destination API left', fmt(usage.max - usage.used)) : null,
    ),
    plan.warnings.map((w) => banner('warn', w)),
    plan.conflicts.map((c) => banner('err', c)),
    h(
      'details',
      { open: true },
      h('summary', null, 'By object'),
      h(
        'table',
        { class: 'grid compact' },
        h('thead', null, h('tr', null, ['Object', 'Insert', 'Upsert', 'Reuse', 'Skip', 'Blocked'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
        h('tbody', null, [...plan.counts].sort().map(([o, c]) => h('tr', null, h('td', { class: 'mono' }, o), h('td', { class: 'num' }, c.insert), h('td', { class: 'num' }, c.upsert), h('td', { class: 'num' }, c.reuse), h('td', { class: 'num' }, c.skip), h('td', { class: 'num' }, c.blocked)))),
      ),
    ),
    h('details', null, h('summary', null, `Load order (${plan.waves.length} wave${plan.waves.length === 1 ? '' : 's'})`), h('pre', { class: 'log' }, order.join('\n') || 'Nothing to write')),
    plan.unresolved.length > 0 &&
      h(
        'details',
        null,
        h('summary', null, `Unresolved references (${plan.unresolved.length})`),
        h('div', { class: 'table-scroll' }, h('table', { class: 'grid compact' }, h('thead', null, h('tr', null, ['Record', 'Field', 'Effect', 'Reason'].map((t) => h('th', null, t)))), h('tbody', null, plan.unresolved.slice(0, 300).map((u) => h('tr', null, h('td', null, `${u.object} · ${u.sourceId}`), h('td', { class: 'mono' }, u.field), h('td', null, u.effect), h('td', { class: 'small' }, u.reason)))))),
      ),
    plan.fieldIssues.length > 0 &&
      h('details', null, h('summary', null, `Field differences (${plan.fieldIssues.length})`), h('table', { class: 'grid compact' }, h('tbody', null, plan.fieldIssues.map((f) => h('tr', null, h('td', { class: 'mono' }, `${f.object}.${f.field}`), h('td', null, f.issue)))))),
    [...plan.nodes.values()].some((n) => n.action === 'skip' || n.action === 'blocked') &&
      h('details', null, h('summary', null, 'Skipped and blocked records'), h('table', { class: 'grid compact' }, h('tbody', null, [...plan.nodes.values()].filter((n) => n.action === 'skip' || n.action === 'blocked').slice(0, 300).map((n) => h('tr', null, h('td', null, `${n.object} · ${n.sourceId}`), h('td', null, n.action), h('td', { class: 'small' }, n.reason ?? '')))))),
    h('p', { class: 'muted small' }, 'Destination automation (triggers, flows, validation and duplicate rules, emails) will run as records are inserted.'),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn sm ghost', onclick: () => download(`sfdm-preview-${stamp()}.csv`, previewCsv(plan), 'text/csv') }, 'Download preview (.csv)')),
  );
}

function resultView(r: MigrationResult, plan: MigrationPlan) {
  const s = summarize(r);
  const rows = r.records.filter((x) => state.resultFilter === 'all' || !['inserted', 'updated', 'reused'].includes(x.status));
  return card(
    'Results',
    r.stoppedReason && banner('err', r.stoppedReason),
    h(
      'div',
      { class: 'stats' },
      stat('Inserted', s.inserted, 'ok'),
      stat('Updated', s.updated, 'ok'),
      stat('Reused', s.reused),
      stat('Failed', s.failed, s.failed ? 'err' : ''),
      stat('Skipped', s.skipped, s.skipped ? 'warn' : ''),
      stat('Deferred updates', `${s.deferredUpdated}/${r.deferred.length}`),
      stat('API calls', s.apiCalls),
    ),
    r.apiErrors.length > 0 && h('details', null, h('summary', null, `API errors (${r.apiErrors.length})`), h('pre', { class: 'log' }, r.apiErrors.join('\n'))),
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => download(`sfdm-report-${stamp()}.zip`, buildMigrationReport(r, plan) as BlobPart, 'application/zip') }, 'Download report (.zip)'),
      h('button', { class: 'btn sm', onclick: () => download(`id-mapping-${stamp()}.csv`, toCsv(['sourceObject', 'sourceId', 'destinationId', 'status'], r.records.filter((x) => x.destId).map((x) => [x.object, x.sourceId, x.destId, x.status])), 'text/csv') }, 'Id mapping (.csv)'),
      select(state.resultFilter, [['problems', 'Show problems'], ['all', 'Show all records']], (v) => ((state.resultFilter = v as 'all' | 'problems'), render())),
    ),
    h(
      'div',
      { class: 'table-scroll' },
      h(
        'table',
        { class: 'grid compact' },
        h('thead', null, h('tr', null, ['Object', 'Source Id', 'Destination Id', 'Status', 'Field', 'Message'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.slice(0, 500).map((x) => h('tr', null, h('td', { class: 'mono' }, x.object), h('td', { class: 'mono small' }, x.sourceId), h('td', { class: 'mono small' }, x.destId ? h('a', { href: `${r.destination.instanceUrl}/${x.destId}`, target: '_blank', rel: 'noopener' }, x.destId) : ''), h('td', null, h('span', { class: `tag s-${x.status}` }, x.status)), h('td', { class: 'mono small' }, x.field ?? ''), h('td', { class: 'small' }, x.message ?? '')))),
      ),
    ),
    rows.length === 0 && h('p', { class: 'muted' }, 'No problems. Every record was written or reused.'),
  );
}

// ---------------- Help ----------------

function viewHelp() {
  return page(
    'Help & settings',
    'How the extension works, what it cannot do, and a few preferences.',
    card(
      'Preferences',
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.showLauncher, onchange: (e: Event) => ((state.showLauncher = (e.target as HTMLInputElement).checked), saveSettings()) }), 'Show the launcher button on Salesforce pages'),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn sm ghost', onclick: async () => { await chrome.storage.local.clear(); state.rules = defaultRules(); state.profiles = {}; state.mig = defaultMigrationSettings(); resetGraph(); toast('Saved settings and profiles cleared', 'ok'); render(); } }, 'Clear saved settings and profiles'), h('button', { class: 'btn sm ghost', onclick: () => { resetGraph(); state.seeds = null; toast('Working data cleared', 'ok'); render(); } }, 'Clear working data')),
    ),
    card(
      'How it works',
      h('ol', null, [
        'Connect: the extension reads the Salesforce session your browser already has (like Salesforce Inspector). It never sees your password, stores no tokens, and only calls Salesforce hosts.',
        'Discover: starting records are fetched, then every populated lookup and master-detail reference is followed up to your limits. Each record is fetched once even if many records point to it.',
        'Export writes everything to a zip on your computer. Migrate inserts records parent-first, replaces each lookup with the new destination Id, and fixes circular references with a follow-up update.',
        'All data stays in this browser tab’s memory. Closing the tab discards it.',
      ].map((t) => h('li', null, t))),
    ),
    card(
      'Known limitations',
      h('ul', null, [
        'Files and attachments (ContentVersion, Attachment), notes, feeds, history and sharing rows are not migrated.',
        'Users, profiles, roles and queues are matched in the destination, never created.',
        'A cycle made only of required (master-detail or required lookup) fields cannot be inserted through the API; those records are reported as blocked.',
        'Destination triggers, flows and validation rules run on insert. Errors are reported per record.',
        'Datasets are held in browser memory; the hard limit is 50,000 records per run. Use Data Loader or Bulk API tools for larger volumes.',
        'If your org restricts API access for your profile, or locks sessions to the Salesforce domain, the extension cannot connect.',
      ].map((t) => h('li', null, t))),
    ),
  );
}

// ---------------- boot ----------------

async function boot() {
  await loadSettings();
  render();
  await scanSessions();
  const host = new URLSearchParams(location.search).get('host');
  if (host) {
    try {
      const s = await sessionForUiHost(host);
      const row = s && state.sessions.find((r) => r.session.orgId === s.orgId);
      if (row?.conn) {
        state.source = row.conn;
        state.step = 'select';
      }
    } catch {
      /* fall back to manual choice */
    }
  }
  render();
}

window.addEventListener('beforeunload', (e) => {
  if (state.running || state.discovering) {
    e.preventDefault();
    e.returnValue = '';
  }
});

boot();
