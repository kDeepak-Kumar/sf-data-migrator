// Describe metadata, cached per org, with a key-prefix index for resolving any Id to its object.

import type { SalesforceClient } from './client';

export interface FieldInfo {
  name: string;
  label: string;
  type: string;
  referenceTo: string[];
  relationshipName: string | null;
  createable: boolean;
  updateable: boolean;
  nillable: boolean;
  calculated: boolean;
  autoNumber: boolean;
  externalId: boolean;
  idLookup: boolean;
  unique: boolean;
  cascadeDelete: boolean;
  relationshipOrder: number | null;
  defaultedOnCreate: boolean;
  restrictedPicklist: boolean;
  picklistValues: { value: string; active: boolean }[];
}

export interface ChildRelationship {
  childSObject: string;
  field: string;
  relationshipName: string | null;
  cascadeDelete: boolean;
}

export interface ObjectInfo {
  name: string;
  label: string;
  keyPrefix: string | null;
  createable: boolean;
  updateable: boolean;
  queryable: boolean;
  fields: FieldInfo[];
  childRelationships: ChildRelationship[];
}

export interface GlobalObject {
  name: string;
  label: string;
  keyPrefix: string | null;
  queryable: boolean;
  createable: boolean;
}

export type ReferenceKind = 'lookup' | 'master-detail' | 'polymorphic';

export function referenceKind(f: FieldInfo): ReferenceKind {
  if (f.relationshipOrder !== null && f.relationshipOrder !== undefined) return 'master-detail';
  if (f.cascadeDelete && !f.nillable) return 'master-detail';
  if (f.referenceTo.length > 1) return 'polymorphic';
  return 'lookup';
}

/** Field types the REST API cannot read or write as plain values in this tool. */
export const UNSUPPORTED_TYPES = new Set(['address', 'location', 'base64', 'complexvalue', 'anyType']);

export const AUDIT_FIELDS = new Set(['CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById', 'SystemModstamp', 'LastActivityDate', 'LastViewedDate', 'LastReferencedDate']);

export class DescribeService {
  private globalList: GlobalObject[] | null = null;
  private byPrefix = new Map<string, string>();
  private byName = new Map<string, GlobalObject>();
  private cache = new Map<string, Promise<ObjectInfo>>();

  constructor(private client: SalesforceClient) {}

  async global(): Promise<GlobalObject[]> {
    if (!this.globalList) {
      const res = await this.client.describeGlobal();
      this.globalList = res.sobjects.map((s) => ({ name: s.name, label: s.label, keyPrefix: s.keyPrefix, queryable: s.queryable, createable: s.createable }));
      for (const s of this.globalList) {
        this.byName.set(s.name.toLowerCase(), s);
        if (s.keyPrefix && !this.byPrefix.has(s.keyPrefix)) this.byPrefix.set(s.keyPrefix, s.name);
      }
    }
    return this.globalList;
  }

  async objectForId(id: string): Promise<string | null> {
    await this.global();
    return this.byPrefix.get(id.slice(0, 3)) ?? null;
  }

  async objectForPrefix(prefix: string): Promise<string | null> {
    await this.global();
    return this.byPrefix.get(prefix) ?? null;
  }

  /** Returns the canonical API name (correct case) or null if the object does not exist. */
  async resolveName(name: string): Promise<string | null> {
    await this.global();
    return this.byName.get(name.toLowerCase())?.name ?? null;
  }

  async exists(name: string): Promise<boolean> {
    return (await this.resolveName(name)) !== null;
  }

  describe(name: string): Promise<ObjectInfo> {
    const key = name.toLowerCase();
    let p = this.cache.get(key);
    if (!p) {
      p = this.client.describe(name).then(normalizeDescribe);
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
    }
    return p;
  }
}

function normalizeDescribe(raw: unknown): ObjectInfo {
  const d = raw as Record<string, any>;
  return {
    name: d.name,
    label: d.label,
    keyPrefix: d.keyPrefix ?? null,
    createable: !!d.createable,
    updateable: !!d.updateable,
    queryable: d.queryable !== false,
    fields: (d.fields ?? []).map((f: Record<string, any>) => ({
      name: f.name,
      label: f.label ?? f.name,
      type: f.type,
      referenceTo: f.referenceTo ?? [],
      relationshipName: f.relationshipName ?? null,
      createable: !!f.createable,
      updateable: !!f.updateable,
      nillable: f.nillable !== false,
      calculated: !!f.calculated,
      autoNumber: !!f.autoNumber,
      externalId: !!f.externalId,
      idLookup: !!f.idLookup,
      unique: !!f.unique,
      cascadeDelete: !!f.cascadeDelete,
      relationshipOrder: f.relationshipOrder ?? null,
      defaultedOnCreate: !!f.defaultedOnCreate,
      restrictedPicklist: !!f.restrictedPicklist,
      picklistValues: (f.picklistValues ?? []).map((p: Record<string, any>) => ({ value: p.value, active: p.active !== false })),
    })),
    childRelationships: (d.childRelationships ?? []).map((c: Record<string, any>) => ({
      childSObject: c.childSObject,
      field: c.field,
      relationshipName: c.relationshipName ?? null,
      cascadeDelete: !!c.cascadeDelete,
    })),
  };
}

export function fieldMap(info: ObjectInfo): Map<string, FieldInfo> {
  return new Map(info.fields.map((f) => [f.name, f]));
}
