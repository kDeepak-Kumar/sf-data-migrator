// An in-memory Salesforce org that speaks the REST endpoints the extension uses.

import { SalesforceClient } from '../src/core/client';
import { to18 } from '../src/core/ids';

export interface FField {
  name: string;
  type?: string;
  referenceTo?: string[];
  nillable?: boolean;
  createable?: boolean;
  updateable?: boolean;
  calculated?: boolean;
  md?: boolean;
  externalId?: boolean;
  unique?: boolean;
  restrictedPicklist?: boolean;
  picklistValues?: string[];
}

export interface FObject {
  prefix: string;
  fields: FField[];
}

type Rec = Record<string, any> & { Id: string; attributes: { type: string } };

const BASE = '/services/data/v62.0';

export class FakeOrg {
  records = new Map<string, Rec>();
  calls: { method: string; path: string }[] = [];
  counter = 1;
  pageSize = 2000;
  validate?: (type: string, rec: Record<string, any>) => string | null;
  failNextRequest?: { status: number; body: unknown; matching?: RegExp };
  networkFailOnCreate = false;
  username = 'admin@example.com';

  constructor(public orgId: string, public schema: Record<string, FObject>, public host = 'test.my.salesforce.com') {
    for (const o of Object.values(schema)) {
      if (!o.fields.some((f) => f.name === 'Id')) o.fields.unshift({ name: 'Id', type: 'id', createable: false, updateable: false, nillable: false });
      if (!o.fields.some((f) => f.name === 'CreatedDate')) o.fields.push({ name: 'CreatedDate', type: 'datetime', createable: false, updateable: false, nillable: false });
    }
  }

  newId(type: string): string {
    const prefix = this.schema[type].prefix;
    const body = String(this.counter++).padStart(12, '0');
    return to18(prefix + body);
  }

  add(type: string, fields: Record<string, any>): string {
    const Id = fields.Id ?? this.newId(type);
    this.records.set(Id, { ...fields, Id, attributes: { type } });
    return Id;
  }

  ofType(type: string): Rec[] {
    return [...this.records.values()].filter((r) => r.attributes.type === type);
  }

  client(): SalesforceClient {
    const c = new SalesforceClient({ getSession: async () => ({ instanceUrl: `https://${this.host}`, accessToken: `${this.orgId}!fake` }) }, { fetchImpl: this.fetch as any, sleep: async () => {} });
    c.apiVersion = '62.0';
    return c;
  }

  private field(type: string, name: string) {
    return this.schema[type]?.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
  }

  describe(type: string) {
    const o = this.schema[type];
    const childRelationships: any[] = [];
    for (const [ct, co] of Object.entries(this.schema)) {
      for (const f of co.fields) if (f.referenceTo?.includes(type)) childRelationships.push({ childSObject: ct, field: f.name, relationshipName: `${ct}s`, cascadeDelete: !!f.md });
    }
    return {
      name: type,
      label: type,
      keyPrefix: o.prefix,
      createable: true,
      updateable: true,
      queryable: true,
      childRelationships,
      fields: o.fields.map((f) => ({
        name: f.name,
        label: f.name,
        type: f.type ?? (f.referenceTo ? 'reference' : 'string'),
        referenceTo: f.referenceTo ?? [],
        relationshipName: f.referenceTo ? f.name.replace(/Id$|__c$/, '') : null,
        createable: f.createable ?? true,
        updateable: f.updateable ?? (f.md ? false : f.createable ?? true),
        nillable: f.md ? false : f.nillable ?? true,
        calculated: !!f.calculated,
        autoNumber: false,
        externalId: !!f.externalId,
        idLookup: f.name === 'Id' || !!f.externalId,
        unique: !!f.unique,
        cascadeDelete: !!f.md,
        relationshipOrder: f.md ? 0 : null,
        defaultedOnCreate: false,
        restrictedPicklist: !!f.restrictedPicklist,
        picklistValues: (f.picklistValues ?? []).map((v) => ({ value: v, active: true })),
      })),
    };
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    if (u.hostname !== this.host) throw new Error(`Fake org got request for ${u.hostname}`);
    const method = init.method ?? 'GET';
    this.calls.push({ method, path: u.pathname + u.search });
    if (this.failNextRequest && (!this.failNextRequest.matching || this.failNextRequest.matching.test(u.pathname + u.search))) {
      const f = this.failNextRequest;
      this.failNextRequest = undefined;
      return json(f.body, f.status);
    }
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const p = u.pathname;
    try {
      if (p === '/services/data/') return json([{ version: '61.0' }, { version: '62.0' }]);
      if (p === '/services/oauth2/userinfo') return json({ preferred_username: this.username, user_id: 'user' });
      if (p === `${BASE}/limits`) return json({ DailyApiRequests: { Max: 15000, Remaining: 14990 } });
      if (p === `${BASE}/sobjects/`) return json({ sobjects: Object.entries(this.schema).map(([name, o]) => ({ name, label: name, keyPrefix: o.prefix, queryable: true, createable: true })) });
      let m = /^\/services\/data\/v62\.0\/sobjects\/(\w+)\/describe$/.exec(p);
      if (m) return this.schema[m[1]] ? json(this.describe(m[1])) : json([{ errorCode: 'NOT_FOUND', message: 'not found' }], 404);
      if (p === `${BASE}/query`) {
        if (u.searchParams.has('explain')) {
          this.runQuery(u.searchParams.get('explain')!);
          return json({ plans: [] });
        }
        const rows = this.runQuery(u.searchParams.get('q')!);
        return this.page(rows, 0);
      }
      m = /^\/services\/data\/v62\.0\/query\/next-(\d+)-(.+)$/.exec(p);
      if (m) return this.page(JSON.parse(decodeURIComponent(m[2])), Number(m[1]));
      m = /^\/services\/data\/v62\.0\/composite\/sobjects\/(\w+)$/.exec(p);
      if (m && method === 'POST') {
        return json(
          body.ids.map((id: string) => {
            const r = this.records.get(to18(id));
            if (!r || r.attributes.type !== m![1]) return null;
            const out: any = { attributes: { type: m![1] } };
            for (const f of body.fields) {
              if (!this.field(m![1], f)) throw new ApiErr(400, 'INVALID_FIELD', `No such column '${f}'`);
              out[f] = r[f] ?? null;
            }
            return out;
          }),
        );
      }
      if (p === `${BASE}/composite/sobjects` && method === 'POST') {
        if (this.networkFailOnCreate) {
          this.networkFailOnCreate = false;
          body.records.forEach((r: any) => this.insert(r));
          throw new TypeError('Failed to fetch');
        }
        return json(body.records.map((r: any) => this.insert(r)));
      }
      if (p === `${BASE}/composite/sobjects` && method === 'PATCH') return json(body.records.map((r: any) => this.updateRec(r)));
      m = /^\/services\/data\/v62\.0\/composite\/sobjects\/(\w+)\/(\w+)$/.exec(p);
      if (m && method === 'PATCH') {
        const [, type, ext] = m;
        return json(
          body.records.map((r: any) => {
            const existing = this.ofType(type).find((x) => x[ext] !== undefined && String(x[ext]).toLowerCase() === String(r[ext]).toLowerCase());
            if (existing) {
              const res = this.updateRec({ ...r, Id: existing.Id });
              return { ...res, created: false };
            }
            return { ...this.insert(r), created: true };
          }),
        );
      }
      return json([{ errorCode: 'NOT_FOUND', message: `No route ${method} ${p}` }], 404);
    } catch (e) {
      if (e instanceof ApiErr) return json([{ errorCode: e.code, message: e.message }], e.status);
      throw e;
    }
  };

  private page(rows: any[], start: number): Response {
    const slice = rows.slice(start, start + this.pageSize);
    const done = start + this.pageSize >= rows.length;
    return json({ totalSize: rows.length, done, records: slice, nextRecordsUrl: done ? undefined : `${BASE}/query/next-${start + this.pageSize}-${encodeURIComponent(JSON.stringify(rows))}` });
  }

  private insert(r: any) {
    const type = r.attributes?.type;
    const errors = this.check(type, r, true);
    if (errors) return { success: false, errors: [errors] };
    const id = this.newId(type);
    const rec: any = { Id: id, attributes: { type } };
    for (const [k, v] of Object.entries(r)) if (k !== 'attributes') rec[k] = v;
    this.records.set(id, rec);
    return { id, success: true, errors: [] };
  }

  private updateRec(r: any) {
    const ex = this.records.get(to18(r.Id));
    if (!ex) return { success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'not found' }] };
    const errors = this.check(ex.attributes.type, r, false);
    if (errors) return { id: ex.Id, success: false, errors: [errors] };
    for (const [k, v] of Object.entries(r)) if (k !== 'attributes' && k !== 'Id') ex[k] = v;
    return { id: ex.Id, success: true, errors: [] };
  }

  private check(type: string, r: any, isCreate: boolean): any {
    const o = this.schema[type];
    if (!o) return { statusCode: 'INVALID_TYPE', message: `bad type ${type}` };
    for (const [k, v] of Object.entries(r)) {
      if (k === 'attributes' || k === 'Id') continue;
      const f = this.field(type, k);
      if (!f) return { statusCode: 'INVALID_FIELD', message: `No such column '${k}'`, fields: [k] };
      if ((f.createable ?? true) === false) return { statusCode: 'INVALID_FIELD_FOR_INSERT_UPDATE', message: `${k} not writable`, fields: [k] };
      if (f.referenceTo && v) {
        const target = this.records.get(to18(String(v)));
        if (!target || !f.referenceTo.includes(target.attributes.type)) return { statusCode: 'INVALID_CROSS_REFERENCE_KEY', message: `invalid cross reference id ${v}`, fields: [k] };
      }
      if (f.restrictedPicklist && v && !(f.picklistValues ?? []).includes(String(v))) return { statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', message: `bad value ${v}`, fields: [k] };
    }
    if (isCreate) {
      for (const f of o.fields) {
        const required = (f.md || f.nillable === false) && (f.createable ?? true) && f.type !== 'boolean';
        if (required && (r[f.name] === undefined || r[f.name] === null || r[f.name] === '')) return { statusCode: 'REQUIRED_FIELD_MISSING', message: `Required fields are missing: [${f.name}]`, fields: [f.name] };
      }
    }
    const v = this.validate?.(type, r);
    if (v) return { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: v };
    return null;
  }

  runQuery(soql: string): any[] {
    const m = /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?\s*$/is.exec(soql.trim());
    if (!m) throw new ApiErr(400, 'MALFORMED_QUERY', 'unexpected token');
    const [, sel, type, where, limit] = m;
    if (!this.schema[type]) throw new ApiErr(400, 'INVALID_TYPE', `sObject type '${type}' is not supported.`);
    const fields = sel.split(',').map((s) => s.trim());
    for (const f of fields) if (!this.field(type, f)) throw new ApiErr(400, 'INVALID_FIELD', `No such column '${f}'`);
    const conds = where ? splitAnd(where).map(parseCond) : [];
    let rows = this.ofType(type).filter((r) => conds.every((c) => c(r)));
    if (limit) rows = rows.slice(0, Number(limit));
    return rows.map((r) => {
      const out: any = { attributes: { type } };
      for (const f of fields) out[this.field(type, f)!.name] = r[this.field(type, f)!.name] ?? null;
      return out;
    });
  }
}

class ApiErr extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Sforce-Limit-Info': 'api-usage=10/15000' } });
}

function splitAnd(where: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = false;
  let cur = '';
  for (let i = 0; i < where.length; i++) {
    const c = where[i];
    if (c === "'" && where[i - 1] !== '\\') q = !q;
    if (!q && c === '(') depth++;
    if (!q && c === ')') depth--;
    if (!q && depth === 0 && /^\s+AND\s+/i.test(where.slice(i))) {
      out.push(cur);
      cur = '';
      i += /^\s+AND\s+/i.exec(where.slice(i))![0].length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseValue(s: string): any {
  s = s.trim();
  if (s.startsWith("'")) return s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  return Number(s);
}

function parseCond(c: string): (r: any) => boolean {
  let m = /^(\w+)\s+IN\s*\((.*)\)$/is.exec(c);
  if (m) {
    const vals = (m[2].match(/'(?:\\.|[^'\\])*'/g) ?? []).map(parseValue).map((v) => String(v).toLowerCase());
    const f = m[1];
    return (r) => r[f] !== undefined && r[f] !== null && vals.includes(String(r[f]).toLowerCase());
  }
  m = /^(\w+)\s*=\s*(.+)$/s.exec(c);
  if (m) {
    const v = parseValue(m[2]);
    const f = m[1];
    return (r) => (typeof v === 'string' ? String(r[f] ?? '').toLowerCase() === v.toLowerCase() : r[f] === v);
  }
  throw new ApiErr(400, 'MALFORMED_QUERY', `cannot parse ${c}`);
}

/** A small CRM-like schema: Account, Contact, a custom Customer__c and Region__c, plus reference data. */
export function standardSchema(): Record<string, FObject> {
  return {
    User: { prefix: '005', fields: [{ name: 'Username' }, { name: 'Email' }, { name: 'FederationIdentifier' }, { name: 'Name' }, { name: 'IsActive', type: 'boolean' }] },
    Group: { prefix: '00G', fields: [{ name: 'DeveloperName' }, { name: 'Type' }, { name: 'Name' }] },
    RecordType: { prefix: '012', fields: [{ name: 'DeveloperName' }, { name: 'SobjectType' }, { name: 'Name' }, { name: 'IsActive', type: 'boolean' }] },
    Region__c: { prefix: 'a01', fields: [{ name: 'Name' }, { name: 'Code__c', externalId: true, unique: true }] },
    Customer__c: {
      prefix: 'a02',
      fields: [{ name: 'Name' }, { name: 'Region__c', referenceTo: ['Region__c'] }, { name: 'PrimaryAccount__c', referenceTo: ['Account'] }, { name: 'Source_Id__c', externalId: true }],
    },
    Account: {
      prefix: '001',
      fields: [
        { name: 'Name', nillable: false },
        { name: 'ParentId', referenceTo: ['Account'] },
        { name: 'Customer__c', referenceTo: ['Customer__c'] },
        { name: 'OwnerId', referenceTo: ['User', 'Group'] },
        { name: 'RecordTypeId', referenceTo: ['RecordType'] },
        { name: 'Industry', type: 'picklist', restrictedPicklist: true, picklistValues: ['Tech', 'Retail'] },
        { name: 'NumberOfEmployees', type: 'int' },
        { name: 'Score__c', type: 'double', calculated: true, createable: false, updateable: false },
        { name: 'Source_Id__c', externalId: true },
        { name: 'CreatedById', referenceTo: ['User'], createable: false, updateable: false },
      ],
    },
    Contact: {
      prefix: '003',
      fields: [
        { name: 'LastName', nillable: false },
        { name: 'Email' },
        { name: 'AccountId', referenceTo: ['Account'] },
        { name: 'ReportsToId', referenceTo: ['Contact'] },
        { name: 'OwnerId', referenceTo: ['User', 'Group'] },
        { name: 'Source_Id__c', externalId: true },
      ],
    },
    Invoice__c: { prefix: 'a03', fields: [{ name: 'Name' }, { name: 'Account__c', referenceTo: ['Account'], md: true }, { name: 'Amount__c', type: 'currency' }] },
  };
}
