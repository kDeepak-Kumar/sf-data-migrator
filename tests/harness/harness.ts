// Browser harness: runs the real app UI against two in-memory orgs with a stubbed chrome.* API.
import { FakeOrg, standardSchema } from '../fakeOrg';

function schemaWithOrg() {
  const s = standardSchema() as any;
  s.Organization = { prefix: '00D', fields: [{ name: 'Name' }, { name: 'IsSandbox', type: 'boolean' }, { name: 'OrganizationType' }] };
  return s;
}

const src = new FakeOrg('00D5g000001SRCAAA', schemaWithOrg(), 'acme.my.salesforce.com');
src.username = 'bharath@acme.com';
src.add('Organization', { Name: 'Acme Corp', IsSandbox: false, OrganizationType: 'Enterprise Edition' });
const owner = src.add('User', { Username: 'deepak@acme.com', Email: 'deepak@acme.com', Name: 'Deepak', IsActive: true });
const rt = src.add('RecordType', { DeveloperName: 'Partner', SobjectType: 'Account', Name: 'Partner', IsActive: true });
const region = src.add('Region__c', { Name: 'South', Code__c: 'S1' });
const customer = src.add('Customer__c', { Name: 'Customer ABC', Region__c: region });
const parent = src.add('Account', { Name: 'Wipro Holdings', OwnerId: owner });
const wipro = src.add('Account', { Name: 'Wipro', ParentId: parent, Customer__c: customer, OwnerId: owner, RecordTypeId: rt, Industry: 'Tech', NumberOfEmployees: 500 });
src.records.get(customer)!.PrimaryAccount__c = wipro;
const deepak = src.add('Contact', { LastName: 'Deepak', Email: 'deepak@wipro.com', AccountId: wipro, OwnerId: owner });
for (let i = 1; i <= 6; i++) src.add('Contact', { LastName: `Contact ${i}`, Email: `c${i}@wipro.com`, AccountId: wipro, ReportsToId: deepak, OwnerId: owner });
src.add('Invoice__c', { Name: 'INV-001', Account__c: wipro, Amount__c: 1200 });
(window as any).__ids = { deepak, wipro };

const dst = new FakeOrg('00D5g000002DSTAAA', schemaWithOrg(), 'acme--uat.sandbox.my.salesforce.com');
dst.counter = 9000;
dst.username = 'bharath@acme.com.uat';
dst.add('Organization', { Name: 'Acme UAT', IsSandbox: true, OrganizationType: 'Enterprise Edition' });
dst.add('User', { Username: 'deepak@acme.com.uat', Email: 'deepak@acme.com', Name: 'Deepak', IsActive: true });
dst.add('RecordType', { DeveloperName: 'Partner', SobjectType: 'Account', Name: 'Partner', IsActive: true });
dst.add('Region__c', { Name: 'South', Code__c: 'S1' });
(window as any).__dst = dst;

const orgs = [src, dst];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const org = orgs.find((o) => new URL(url).hostname === o.host);
  if (!org) throw new TypeError('Failed to fetch');
  await new Promise((r) => setTimeout(r, 15));
  return org.fetch(url, init);
}) as typeof fetch;

const store: Record<string, unknown> = {};
const cookies = orgs.map((o) => ({ name: 'sid', domain: o.host, value: `${o.orgId}!AQ4AQFakeSessionTokenForHarness` }));
(window as any).chrome = {
  cookies: {
    getAll: async ({ name }: { name: string }) => cookies.filter((c) => c.name === name),
    get: async ({ url, name }: { url: string; name: string }) => cookies.find((c) => c.name === name && new URL(url).hostname === c.domain) ?? null,
  },
  storage: {
    local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (o: Record<string, unknown>) => Object.assign(store, structuredClone(o)),
      clear: async () => Object.keys(store).forEach((k) => delete store[k]),
    },
  },
  runtime: { getURL: (p: string) => p, id: 'harness' },
};
