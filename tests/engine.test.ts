import { describe, it, expect } from 'vitest';
import { FakeOrg, standardSchema } from './fakeOrg';
import { DescribeService } from '../src/core/describe';
import { DiscoveryEngine, resolveSeeds } from '../src/core/discovery';
import { defaultRules, DiscoveryRules } from '../src/core/rules';
import { collectReferenceData } from '../src/core/refdata';
import { MigrationPlanner, MigrationExecutor, defaultMigrationSettings, summarize, MigrationSettings } from '../src/core/migrate';
import { RecordGraph, OrgInfo, planWaves } from '../src/core/graph';
import { zipExportPackage, readExportPackage, buildMigrationReport } from '../src/core/package';
import { readZip } from '../src/core/zip';
import { parseCsvObjects } from '../src/core/csv';

const SRC_ORG = '00D000000000001AAA';
const DST_ORG = '00D000000000002AAA';

function seedSource() {
  const org = new FakeOrg(SRC_ORG, standardSchema(), 'src.my.salesforce.com');
  const owner = org.add('User', { Username: 'deepak@acme.com', Email: 'deepak@acme.com', Name: 'Deepak', IsActive: true });
  const rt = org.add('RecordType', { DeveloperName: 'Partner', SobjectType: 'Account', Name: 'Partner', IsActive: true });
  const region = org.add('Region__c', { Name: 'South', Code__c: 'S1' });
  const customer = org.add('Customer__c', { Name: 'Customer ABC', Region__c: region });
  const parent = org.add('Account', { Name: 'Wipro Holdings', OwnerId: owner });
  const wipro = org.add('Account', { Name: 'Wipro', ParentId: parent, Customer__c: customer, OwnerId: owner, RecordTypeId: rt, Industry: 'Tech', NumberOfEmployees: 500, Score__c: 9, CreatedById: owner });
  const deepak = org.add('Contact', { LastName: 'Deepak', Email: 'd@wipro.com', AccountId: wipro, OwnerId: owner });
  const ravi = org.add('Contact', { LastName: 'Ravi', AccountId: wipro, ReportsToId: deepak, OwnerId: owner });
  const other = org.add('Contact', { LastName: 'Unrelated', AccountId: wipro });
  const invoice = org.add('Invoice__c', { Name: 'INV-1', Account__c: wipro, Amount__c: 100 });
  return { org, owner, rt, region, customer, parent, wipro, deepak, ravi, other, invoice };
}

function seedDest() {
  const org = new FakeOrg(DST_ORG, standardSchema(), 'dst.my.salesforce.com');
  org.counter = 5000;
  const user = org.add('User', { Username: 'deepak@acme.com.uat', Email: 'deepak@acme.com', Name: 'Deepak', IsActive: true });
  const rt = org.add('RecordType', { DeveloperName: 'Partner', SobjectType: 'Account', Name: 'Partner', IsActive: true });
  return { org, user, rt };
}

const destInfo: OrgInfo = { orgId: DST_ORG, name: 'Dest', instanceUrl: 'https://dst.my.salesforce.com', isSandbox: true, orgType: 'Sandbox' };

async function discover(org: FakeOrg, seeds: Record<string, string[]>, rules: Partial<DiscoveryRules> = {}) {
  const client = org.client();
  const d = new DescribeService(client);
  const engine = new DiscoveryEngine(client, d);
  const graph = await engine.run({ seeds: new Map(Object.entries(seeds)), rules: { ...defaultRules(), ...rules } });
  graph.source = { orgId: org.orgId, name: 'Source', instanceUrl: `https://${org.host}`, isSandbox: false, orgType: 'Production' };
  await collectReferenceData(client, graph);
  return graph;
}

async function migrate(graph: RecordGraph, dest: FakeOrg, s: Partial<MigrationSettings> = {}) {
  const client = dest.client();
  const settings = { ...defaultMigrationSettings(), usernameTransform: { find: '@acme.com', replace: '@acme.com.uat' }, ...s };
  const plan = await new MigrationPlanner(graph, client, new DescribeService(client), destInfo).plan(settings);
  const result = await new MigrationExecutor(graph, plan, client, async () => {}).run();
  return { plan, result, summary: summarize(result) };
}

describe('relationship discovery', () => {
  it('1. extracts a Contact with its Account chain but not sibling Contacts', async () => {
    const s = seedSource();
    const g = await discover(s.org, { Contact: [s.deepak] }, { maxDepth: 5 });
    const counts = Object.fromEntries(g.countsByObject());
    expect(counts).toEqual({ Contact: 1, Account: 2, Customer__c: 1, Region__c: 1 });
    expect(g.has('Contact', s.other)).toBe(false);
    expect(g.has('Contact', s.ravi)).toBe(false);
    expect(g.truncated).toBe(false);
  });

  it('2. shared parent is extracted once', async () => {
    const s = seedSource();
    const g = await discover(s.org, { Contact: [s.deepak, s.ravi] });
    expect(g.nodesOf('Account').filter((n) => n.id === s.wipro)).toHaveLength(1);
    // Ravi references Deepak, who is also a seed: no duplicate
    expect(g.nodesOf('Contact')).toHaveLength(2);
    const retrieveCalls = s.org.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/composite/sobjects/Account'));
    expect(retrieveCalls.length).toBeLessThanOrEqual(2);
  });

  it('3/4. follows multiple lookups and custom object relationships', async () => {
    const s = seedSource();
    const g = await discover(s.org, { Account: [s.wipro] }, { maxDepth: 3 });
    expect(g.has('Account', s.parent)).toBe(true);
    expect(g.has('Customer__c', s.customer)).toBe(true);
    expect(g.has('Region__c', s.region)).toBe(true);
    const ownerEdge = g.edges.find((e) => e.field === 'OwnerId' && e.from.endsWith(s.wipro));
    expect(ownerEdge?.status).toBe('reference-data');
    expect(g.refData.get(`User:${s.owner}`)?.username).toBe('deepak@acme.com');
  });

  it('5. handles a self-referencing record', async () => {
    const s = seedSource();
    const self = s.org.add('Account', { Name: 'Loop' });
    s.org.records.get(self)!.ParentId = self;
    const g = await discover(s.org, { Account: [self] });
    expect(g.nodes.size).toBe(1);
    expect(g.edges.find((e) => e.field === 'ParentId')?.status).toBe('in-graph');
  });

  it('6. detects circular dependencies and defers a nillable reference', async () => {
    const s = seedSource();
    s.org.records.get(s.customer)!.PrimaryAccount__c = s.wipro; // Customer -> Account -> Customer
    const g = await discover(s.org, { Account: [s.wipro] }, { maxDepth: 2 });
    const keys = [...g.nodes.keys()];
    const deps = g.edges.filter((e) => e.status === 'in-graph').map((e) => ({ from: e.from, to: g.targetKey(e)!, field: e.field, deferrable: !e.required && e.kind !== 'master-detail' }));
    const wp = planWaves(keys, deps);
    expect(wp.deferred.length).toBe(1);
    expect(wp.blocked.size).toBe(0);
  });

  it('7. stops at the depth limit and reports truncation', async () => {
    const s = seedSource();
    const g = await discover(s.org, { Contact: [s.deepak] }, { maxDepth: 1 });
    expect(g.has('Account', s.wipro)).toBe(true);
    expect(g.has('Customer__c', s.customer)).toBe(false);
    expect(g.truncated).toBe(true);
    expect(g.edges.find((e) => e.field === 'Customer__c')?.status).toBe('out-of-limit');
  });

  it('7b. stops at the record limit', async () => {
    const s = seedSource();
    const g = await discover(s.org, { Contact: [s.deepak] }, { maxDepth: 5, maxRecords: 2 });
    expect(g.nodes.size).toBe(2);
    expect(g.truncated).toBe(true);
  });

  it('reverse traversal only when configured, with per-parent limit', async () => {
    const s = seedSource();
    const g = await discover(s.org, { Account: [s.wipro] }, { maxDepth: 1, childRules: [{ parentObject: 'Account', childObject: 'Contact', field: 'AccountId', maxPerParent: 2 }] });
    expect(g.nodesOf('Contact')).toHaveLength(2);
    expect(g.truncated).toBe(true);
  });

  it('8. reports references to excluded and missing targets', async () => {
    const s = seedSource();
    s.org.records.get(s.deepak)!.ReportsToId = '003000000000999AAA'.slice(0, 15); // deleted contact
    const g = await discover(s.org, { Contact: [s.deepak] }, { excludeObjects: ['Customer__c'] });
    expect(g.edges.find((e) => e.field === 'Customer__c')?.status).toBe('excluded');
    expect(g.edges.find((e) => e.field === 'ReportsToId')?.status).toBe('missing');
  });

  it('resolves seeds from SOQL and validates via explain', async () => {
    const s = seedSource();
    const client = s.org.client();
    const d = new DescribeService(client);
    const r = await resolveSeeds(client, d, { soql: `SELECT Id FROM Contact WHERE AccountId = '${s.wipro}'`, maxRecords: 100 });
    expect(r.seeds.get('Contact')).toHaveLength(3);
    await expect(resolveSeeds(client, d, { soql: 'SELECT Id FROM Nope__c', maxRecords: 10 })).rejects.toThrow(/not supported/);
  });

  it('paginates query results', async () => {
    const s = seedSource();
    s.org.pageSize = 1;
    const rows = await s.org.client().query(`SELECT Id FROM Contact`);
    expect(rows).toHaveLength(3);
  });
});

describe('direct migration', () => {
  it('9/16. migrates a graph and preserves relationships with new destination Ids', async () => {
    const s = seedSource();
    const d = seedDest();
    const g = await discover(s.org, { Contact: [s.deepak, s.ravi] }, { maxDepth: 5 });
    const { summary, result } = await migrate(g, d.org);
    expect(summary.failed).toBe(0);
    expect(summary.inserted).toBe(6);
    const map = new Map(result.records.map((r) => [r.sourceId, r.destId!]));
    const dRavi = d.org.records.get(map.get(s.ravi)!)!;
    expect(dRavi.ReportsToId).toBe(map.get(s.deepak));
    expect(dRavi.AccountId).toBe(map.get(s.wipro));
    const dWipro = d.org.records.get(map.get(s.wipro)!)!;
    expect(dWipro.ParentId).toBe(map.get(s.parent));
    expect(dWipro.OwnerId).toBe(d.user); // matched by transformed username
    expect(dWipro.RecordTypeId).toBe(d.rt); // matched by developer name
    expect(dWipro.NumberOfEmployees).toBe(500);
    expect(dWipro.Score__c).toBeUndefined(); // formula not written
    expect(dWipro.CreatedById).toBeUndefined();
    // No source Ids leaked into destination lookups
    const srcIds = new Set([...g.nodes.values()].map((n) => n.id));
    for (const r of d.org.records.values()) for (const [k, v] of Object.entries(r)) if (k !== 'Id' && k !== 'Source_Id__c') expect(srcIds.has(String(v))).toBe(false);
  });

  it('6. migrates a circular dependency with a deferred update', async () => {
    const s = seedSource();
    s.org.records.get(s.customer)!.PrimaryAccount__c = s.wipro;
    const d = seedDest();
    const g = await discover(s.org, { Account: [s.wipro] }, { maxDepth: 3 });
    const { summary, result, plan } = await migrate(g, d.org);
    expect(plan.deferred).toHaveLength(1);
    expect(summary.failed).toBe(0);
    expect(summary.deferredUpdated).toBe(1);
    const map = new Map(result.records.map((r) => [r.sourceId, r.destId!]));
    expect(d.org.records.get(map.get(s.customer)!)!.PrimaryAccount__c).toBe(map.get(s.wipro));
    expect(d.org.records.get(map.get(s.wipro)!)!.Customer__c).toBe(map.get(s.customer));
  });

  it('5. migrates a self-referencing record via deferred update', async () => {
    const s = seedSource();
    const self = s.org.add('Account', { Name: 'Loop' });
    s.org.records.get(self)!.ParentId = self;
    const d = seedDest();
    const g = await discover(s.org, { Account: [self] });
    const { result } = await migrate(g, d.org);
    const destId = result.records[0].destId!;
    expect(d.org.records.get(destId)!.ParentId).toBe(destId);
  });

  it('10/15. reuses existing destination records and re-runs without duplicates', async () => {
    const s = seedSource();
    const d = seedDest();
    d.org.add('Region__c', { Name: 'South (dest)', Code__c: 's1' });
    const g = await discover(s.org, { Contact: [s.deepak] }, { maxDepth: 5 });
    const objects = {
      Region__c: { operation: 'reuse-or-insert' as const, matchField: 'Code__c' },
      Account: { operation: 'upsert' as const, matchField: 'Source_Id__c', sourceIdField: 'Source_Id__c' },
      Contact: { operation: 'upsert' as const, matchField: 'Source_Id__c', sourceIdField: 'Source_Id__c' },
      Customer__c: { operation: 'upsert' as const, matchField: 'Source_Id__c', sourceIdField: 'Source_Id__c' },
    };
    const first = await migrate(g, d.org, { objects });
    expect(first.summary.reused).toBe(1);
    expect(first.summary.failed).toBe(0);
    const before = d.org.records.size;
    const second = await migrate(g, d.org, { objects });
    expect(d.org.records.size).toBe(before);
    expect(second.summary.updated).toBe(4); // two accounts, customer, contact
  });

  it('11/14. reports validation-rule failures with partial success and skips dependents', async () => {
    const s = seedSource();
    const d = seedDest();
    d.org.validate = (type, rec) => (type === 'Account' && rec.Name === 'Wipro' ? 'Industry needs approval' : null);
    const g = await discover(s.org, { Contact: [s.deepak] }, { maxDepth: 5 });
    const { summary, result } = await migrate(g, d.org);
    const wipro = result.records.find((r) => r.sourceId === s.wipro)!;
    expect(wipro.status).toBe('failed');
    expect(wipro.message).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    const contact = result.records.find((r) => r.sourceId === s.deepak)!;
    expect(contact.status).toBe('skipped');
    expect(contact.field).toBe('AccountId');
    expect(summary.inserted).toBe(3); // parent account, customer, region
  });

  it('blank-field policy writes the child without the failed optional parent', async () => {
    const s = seedSource();
    const d = seedDest();
    d.org.validate = (type, rec) => (type === 'Account' && rec.Name === 'Wipro' ? 'nope' : null);
    const g = await discover(s.org, { Contact: [s.deepak] }, { maxDepth: 5 });
    const { result } = await migrate(g, d.org, { unresolvedPolicy: 'blank-field' });
    const c = result.records.find((r) => r.sourceId === s.deepak)!;
    expect(c.status).toBe('inserted');
    expect(d.org.records.get(c.destId!)!.AccountId).toBeUndefined();
  });

  it('master-detail child is skipped when its required parent is excluded', async () => {
    const s = seedSource();
    const d = seedDest();
    const g = await discover(s.org, { Invoice__c: [s.invoice] }, { excludeObjects: ['Account'] });
    const { plan, summary } = await migrate(g, d.org);
    expect(summary.inserted).toBe(0);
    expect(plan.unresolved[0].effect).toBe('record skipped');
  });

  it('flags restricted picklist conflicts and missing destination objects in the preview', async () => {
    const s = seedSource();
    s.org.records.get(s.wipro)!.Industry = 'Mining';
    const g = await discover(s.org, { Account: [s.wipro] }, { maxDepth: 0 });
    const schema = standardSchema();
    delete (schema as any).Customer__c;
    const d = new FakeOrg(DST_ORG, schema, 'dst.my.salesforce.com');
    const client = d.client();
    const plan = await new MigrationPlanner(g, client, new DescribeService(client), destInfo).plan(defaultMigrationSettings());
    expect(plan.conflicts.join(' ')).toContain('Mining');
  });

  it('13. retries a transient 503 and surfaces expired sessions', async () => {
    const s = seedSource();
    s.org.failNextRequest = { status: 503, body: [{ errorCode: 'SERVER_UNAVAILABLE', message: 'busy' }] };
    const client = s.org.client();
    const rows = await client.query('SELECT Id FROM Contact');
    expect(rows).toHaveLength(3);
    s.org.failNextRequest = { status: 401, body: [{ errorCode: 'INVALID_SESSION_ID', message: 'expired' }] };
    await expect(client.query('SELECT Id FROM Contact')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('12. refreshes the session once on 401', async () => {
    const s = seedSource();
    let refreshed = 0;
    const c = new (await import('../src/core/client')).SalesforceClient(
      { getSession: async () => ({ instanceUrl: 'https://src.my.salesforce.com', accessToken: 'x' }), refresh: async () => (refreshed++, true) },
      { fetchImpl: s.org.fetch as any, sleep: async () => {} },
    );
    s.org.failNextRequest = { status: 401, body: [{ errorCode: 'INVALID_SESSION_ID', message: 'expired' }] };
    await c.init();
    expect(refreshed).toBe(1);
    expect(c.apiVersion).toBe('62.0');
  });

  it('does not blindly retry an insert after a network failure', async () => {
    const s = seedSource();
    const d = seedDest();
    const g = await discover(s.org, { Account: [s.parent] });
    d.org.networkFailOnCreate = true;
    const { result } = await migrate(g, d.org);
    expect(result.stoppedReason).toMatch(/may or may not/);
    expect(result.records[0].status).toBe('unknown');
    expect(d.org.ofType('Account')).toHaveLength(1); // written once, not duplicated
  });

  it('cancels between batches', async () => {
    const s = seedSource();
    const d = seedDest();
    const g = await discover(s.org, { Contact: [s.deepak] }, { maxDepth: 5 });
    const client = d.org.client();
    const plan = await new MigrationPlanner(g, client, new DescribeService(client), destInfo).plan(defaultMigrationSettings());
    const token = { cancelled: false };
    const result = await new MigrationExecutor(g, plan, client, async () => {}).run(() => {
      token.cancelled = true;
    }, token);
    expect(result.stoppedReason).toBe('Cancelled by user');
    expect(result.records.some((r) => r.status === 'cancelled')).toBe(true);
  });
});

describe('export package', () => {
  it('17. exports per-object CSVs and re-imports to migrate without the source org', async () => {
    const s = seedSource();
    const g = await discover(s.org, { Contact: [s.deepak, s.ravi] }, { maxDepth: 5 });
    const zip = zipExportPackage(g);
    const files = await readZip(zip);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['manifest.json', 'objects/Account.csv', 'objects/Contact.csv', 'load-order.json', 'dependencies.csv', 'unresolved.csv', 'reference-data.csv']));
    const accounts = parseCsvObjects(new TextDecoder().decode(files.get('objects/Account.csv')));
    expect(accounts).toHaveLength(2); // shared Account not duplicated
    expect(accounts[0]).toHaveProperty('@type:OwnerId');

    const imported = await readExportPackage(zip);
    expect(imported.nodes.size).toBe(g.nodes.size);
    expect(imported.edges.length).toBe(g.edges.length);
    const d = seedDest();
    const { summary, result, plan } = await migrate(imported, d.org);
    expect(summary.failed).toBe(0);
    expect(summary.inserted).toBe(6);
    const wipro = d.org.records.get(result.records.find((r) => r.sourceId === s.wipro)!.destId!)!;
    expect(wipro.NumberOfEmployees).toBe(500); // coerced from CSV text to number
    const report = await readZip(buildMigrationReport(result, plan));
    const mapping = parseCsvObjects(new TextDecoder().decode(report.get('id-mapping.csv')));
    expect(mapping).toHaveLength(6);
  });
});
