// Migration planning and execution: matching, reference remapping, dependency-ordered batched writes.

import { SalesforceClient, chunk, queryIn, SaveResult } from './client';
import { DescribeService, FieldInfo, ObjectInfo, AUDIT_FIELDS, UNSUPPORTED_TYPES, fieldMap } from './describe';
import { RecordGraph, Dep, planWaves, OrgInfo, Edge, nodeKey } from './graph';
import { CancelToken, SfError, RETRYABLE_RECORD_CODES, sanitize } from './errors';
import { to18 } from './ids';

export type Operation = 'insert' | 'upsert' | 'reuse-or-insert' | 'reuse-only' | 'skip';

export interface ObjectSettings {
  operation: Operation;
  /** Destination field used to find existing records (External ID or unique field). Required for upsert and reuse. */
  matchField?: string;
  /** Destination text External ID field that receives the source record Id (enables safe re-runs). */
  sourceIdField?: string;
}

export interface MigrationSettings {
  objects: Record<string, ObjectSettings>;
  ownerStrategy: 'match-username' | 'match-email' | 'match-federation' | 'running-user';
  usernameTransform?: { find: string; replace: string };
  recordTypeStrategy: 'match-developer-name' | 'omit';
  unresolvedPolicy: 'skip-record' | 'blank-field';
  includeAuditFields: boolean;
  batchSize: number;
  priorMappings: { sourceObject: string; sourceId: string; destId: string }[];
}

export function defaultMigrationSettings(): MigrationSettings {
  return {
    objects: {},
    ownerStrategy: 'match-username',
    recordTypeStrategy: 'match-developer-name',
    unresolvedPolicy: 'skip-record',
    includeAuditFields: false,
    batchSize: 200,
    priorMappings: [],
  };
}

export type PlannedAction = 'insert' | 'upsert' | 'reuse' | 'skip' | 'blocked';

export interface NodePlan {
  key: string;
  object: string;
  sourceId: string;
  action: PlannedAction;
  destId?: string;
  matchedBy?: string;
  reason?: string;
  upsertValue?: string;
}

export interface UnresolvedRef {
  key: string;
  object: string;
  sourceId: string;
  field: string;
  targetObject: string | null;
  targetId: string;
  reason: string;
  effect: 'record skipped' | 'field left blank' | 'field omitted (destination default)';
}

export interface FieldIssue {
  object: string;
  field: string;
  issue: string;
}

export interface MigrationPlan {
  source: OrgInfo | null;
  destination: OrgInfo;
  nodes: Map<string, NodePlan>;
  sendFields: Map<string, string[]>; // non-reference fields to write per object
  refFields: Map<string, Map<string, FieldInfo>>; // reference fields writable in the destination per object
  destTypes: Map<string, Map<string, string>>;
  refDataMap: Map<string, string>; // `${object}:${sourceId}` -> destination Id
  waves: string[][];
  deferred: Dep[];
  unresolved: UnresolvedRef[];
  omittedRefs: Set<string>; // `${key}|${field}` references deliberately left out
  fieldIssues: FieldIssue[];
  conflicts: string[];
  warnings: string[];
  counts: Map<string, Record<PlannedAction, number>>;
  estimatedCalls: number;
  settings: MigrationSettings;
}

const SYSTEM_FIELDS = new Set(['Id', 'IsDeleted', 'SystemModstamp']);

export class MigrationPlanner {
  constructor(private graph: RecordGraph, private dest: SalesforceClient, private destDescribe: DescribeService, private destination: OrgInfo) {}

  async plan(settings: MigrationSettings, cancel?: CancelToken): Promise<MigrationPlan> {
    const g = this.graph;
    const plan: MigrationPlan = {
      source: g.source,
      destination: this.destination,
      nodes: new Map(),
      sendFields: new Map(),
      refFields: new Map(),
      destTypes: new Map(),
      refDataMap: new Map(),
      waves: [],
      deferred: [],
      unresolved: [],
      omittedRefs: new Set(),
      fieldIssues: [],
      conflicts: [],
      warnings: [...g.warnings.filter((w) => w.startsWith('Discovery stopped'))],
      counts: new Map(),
      estimatedCalls: 0,
      settings,
    };
    const destInfo = new Map<string, ObjectInfo>();
    let queries = 0;

    // 1. Destination metadata and field selection per object.
    for (const object of g.objects()) {
      const os = settings.objects[object] ?? { operation: 'insert' };
      const nodes = g.nodesOf(object);
      const destName = await this.destDescribe.resolveName(object);
      if (!destName) {
        for (const n of nodes) plan.nodes.set(n.key, { key: n.key, object, sourceId: n.id, action: 'blocked', reason: `Object ${object} does not exist in the destination org.` });
        plan.fieldIssues.push({ object, field: '*', issue: 'Object not found in destination' });
        continue;
      }
      const info = await this.destDescribe.describe(destName);
      destInfo.set(object, info);
      if (!info.createable && os.operation !== 'skip' && os.operation !== 'reuse-only') {
        plan.warnings.push(`Your destination user cannot create ${object} records.`);
      }
      const dmap = fieldMap(info);
      plan.destTypes.set(object, new Map(info.fields.map((f) => [f.name, f.type])));
      const send: string[] = [];
      const refs = new Map<string, FieldInfo>();
      const srcMeta = g.objectFields.get(object) ?? [];
      const populated = (f: string) => nodes.some((n) => n.fields[f] !== null && n.fields[f] !== undefined && n.fields[f] !== '');
      for (const m of srcMeta) {
        if (SYSTEM_FIELDS.has(m.name) || !populated(m.name)) continue;
        if (AUDIT_FIELDS.has(m.name) && !settings.includeAuditFields) continue;
        if (m.name === os.sourceIdField) continue;
        const d = dmap.get(m.name);
        if (!d) {
          if (m.createable) plan.fieldIssues.push({ object, field: m.name, issue: 'Not found in destination (or not visible to your user); values will not be migrated' });
          continue;
        }
        if (UNSUPPORTED_TYPES.has(d.type)) continue;
        if (!d.createable || d.calculated || d.autoNumber) {
          if (m.createable && !d.calculated && !d.autoNumber) plan.fieldIssues.push({ object, field: m.name, issue: 'Not writable in destination for your user' });
          continue;
        }
        if (m.name === 'OwnerId' && settings.ownerStrategy === 'running-user') continue;
        if (m.name === 'RecordTypeId' && settings.recordTypeStrategy === 'omit') continue;
        if (d.type === 'reference') refs.set(m.name, d);
        else send.push(m.name);
        if (d.restrictedPicklist && (d.type === 'picklist' || d.type === 'multipicklist')) {
          const allowed = new Set(d.picklistValues.filter((p) => p.active).map((p) => p.value));
          const bad = new Set<string>();
          for (const n of nodes) {
            const v = n.fields[m.name];
            if (typeof v !== 'string' || !v) continue;
            for (const part of d.type === 'multipicklist' ? v.split(';') : [v]) if (!allowed.has(part)) bad.add(part);
          }
          if (bad.size) plan.conflicts.push(`${object}.${m.name}: value(s) ${[...bad].slice(0, 5).map((b) => `"${b}"`).join(', ')} are not active in the destination restricted picklist; those records will fail.`);
        }
      }
      if (os.sourceIdField) {
        const f = dmap.get(os.sourceIdField);
        if (!f || !f.createable) plan.conflicts.push(`${object}: source-Id field ${os.sourceIdField} is missing or not writable in the destination.`);
      }
      if ((os.operation === 'upsert' || os.operation.startsWith('reuse')) && !os.matchField) {
        plan.conflicts.push(`${object}: "${os.operation}" needs a match field; records will be inserted instead.`);
      }
      plan.sendFields.set(object, send);
      plan.refFields.set(object, refs);
      for (const n of nodes) {
        let action: PlannedAction = 'insert';
        if (os.operation === 'skip') action = 'skip';
        else if (os.operation === 'upsert' && os.matchField) action = 'upsert';
        plan.nodes.set(n.key, { key: n.key, object, sourceId: n.id, action, reason: action === 'skip' ? 'Object set to skip' : undefined });
      }
    }

    // 2. Mappings from an earlier run, verified to still exist in the destination.
    if (settings.priorMappings.length) {
      const byObj = new Map<string, { sourceId: string; destId: string }[]>();
      for (const m of settings.priorMappings) {
        const k = nodeKey(m.sourceObject, to18(m.sourceId));
        if (!plan.nodes.has(k)) continue;
        (byObj.get(m.sourceObject) ?? byObj.set(m.sourceObject, []).get(m.sourceObject)!).push({ sourceId: to18(m.sourceId), destId: to18(m.destId) });
      }
      for (const [obj, list] of byObj) {
        queries++;
        const found = new Set((await queryIn<{ Id: string }>(this.dest, ['Id'], obj, 'Id', list.map((l) => l.destId), '', cancel)).map((r) => to18(r.Id)));
        for (const l of list) {
          const np = plan.nodes.get(nodeKey(obj, l.sourceId))!;
          if (found.has(l.destId)) Object.assign(np, { action: 'reuse', destId: l.destId, matchedBy: 'mapping file', reason: undefined });
          else plan.warnings.push(`Mapping for ${obj} ${l.sourceId} points to ${l.destId}, which no longer exists in the destination; it will be handled normally.`);
        }
      }
    }

    // 3. Matching existing destination records and upsert keys.
    for (const object of g.objects()) {
      const os = settings.objects[object];
      if (!os?.matchField || !destInfo.has(object)) continue;
      const nodes = g.nodesOf(object).map((n) => ({ n, p: plan.nodes.get(n.key)! })).filter(({ p }) => p.action !== 'reuse' && p.action !== 'skip' && p.action !== 'blocked');
      const valueOf = (n: { id: string; fields: Record<string, unknown> }) => (os.matchField === os.sourceIdField ? n.id : n.fields[os.matchField!]);
      if (!fieldMap(destInfo.get(object)!).has(os.matchField)) {
        plan.conflicts.push(`${object}: match field ${os.matchField} does not exist in the destination.`);
        continue;
      }
      if (os.operation === 'upsert') {
        for (const { n, p } of nodes) {
          const v = valueOf(n);
          if (v === null || v === undefined || v === '') {
            p.action = 'insert';
            p.reason = `No ${os.matchField} value; inserted`;
          } else p.upsertValue = String(v);
        }
        continue;
      }
      if (os.operation !== 'reuse-or-insert' && os.operation !== 'reuse-only') continue;
      const values = nodes.map(({ n }) => valueOf(n)).filter((v) => v !== null && v !== undefined && v !== '').map(String);
      queries += Math.ceil(values.length / 150);
      const found = await queryIn<Record<string, unknown>>(this.dest, ['Id', os.matchField], object, os.matchField, values, '', cancel);
      const byVal = new Map<string, string[]>();
      for (const r of found) {
        const v = String(r[os.matchField] ?? '');
        (byVal.get(v.toLowerCase()) ?? byVal.set(v.toLowerCase(), []).get(v.toLowerCase())!).push(to18(String(r.Id)));
      }
      for (const { n, p } of nodes) {
        const v = valueOf(n);
        const hits = v === null || v === undefined || v === '' ? [] : byVal.get(String(v).toLowerCase()) ?? [];
        if (hits.length === 1) Object.assign(p, { action: 'reuse', destId: hits[0], matchedBy: os.matchField });
        else if (hits.length > 1) Object.assign(p, { action: 'skip', reason: `${hits.length} destination records match ${os.matchField} = "${v}"; ambiguous, not migrated` });
        else if (os.operation === 'reuse-only') Object.assign(p, { action: 'skip', reason: `No destination record matches ${os.matchField}` });
        else p.action = 'insert';
      }
    }

    // 4. Reference data (owners, record types, queues).
    queries += await this.mapReferenceData(plan, settings, cancel);

    // 5. Resolve references, propagate skips, and build dependencies.
    const isWritten = (a: PlannedAction) => a === 'insert' || a === 'upsert';
    let changed = true;
    let guard = 0;
    const skippedRefs: UnresolvedRef[] = [];
    while (changed && guard++ < 1000) {
      changed = false;
      plan.unresolved = [];
      plan.omittedRefs = new Set();
      for (const np of plan.nodes.values()) {
        if (!isWritten(np.action)) continue;
        const refs = plan.refFields.get(np.object) ?? new Map<string, FieldInfo>();
        for (const e of g.edgesFrom(np.key)) {
          const df = refs.get(e.field);
          if (!df) continue; // field not written (not in destination, not createable, or omitted by strategy)
          const problem = this.referenceProblem(e, plan);
          if (!problem) continue;
          const isOwnerOrRt = e.field === 'OwnerId' || e.field === 'RecordTypeId';
          if (isOwnerOrRt && df.nillable !== false) {
            plan.omittedRefs.add(`${np.key}|${e.field}`);
            plan.unresolved.push(this.unresolved(np, e, problem, 'field omitted (destination default)'));
            continue;
          }
          const mustSkip = !df.nillable || settings.unresolvedPolicy === 'skip-record';
          if (mustSkip) {
            np.action = 'skip';
            np.reason = `Unresolved ${df.nillable ? '' : 'required '}reference ${e.field}: ${problem}`;
            skippedRefs.push(this.unresolved(np, e, problem, 'record skipped'));
            changed = true;
            break;
          }
          plan.omittedRefs.add(`${np.key}|${e.field}`);
          plan.unresolved.push(this.unresolved(np, e, problem, 'field left blank'));
        }
      }
    }

    plan.unresolved = [...skippedRefs, ...plan.unresolved];

    const deps: Dep[] = [];
    for (const np of plan.nodes.values()) {
      if (!isWritten(np.action)) continue;
      const refs = plan.refFields.get(np.object)!;
      for (const e of g.edgesFrom(np.key)) {
        const df = refs.get(e.field);
        if (!df || e.status !== 'in-graph') continue;
        const tk = g.targetKey(e)!;
        const tp = plan.nodes.get(tk);
        if (!tp || !isWritten(tp.action)) continue; // reused targets already have a destination Id
        deps.push({ from: np.key, to: tk, field: e.field, deferrable: df.nillable && df.updateable && e.kind !== 'master-detail' });
      }
    }
    const writeKeys = [...plan.nodes.values()].filter((p) => isWritten(p.action)).map((p) => p.key);
    const wp = planWaves(writeKeys, deps);
    for (const [k, reason] of wp.blocked) Object.assign(plan.nodes.get(k)!, { action: 'blocked', reason });
    plan.waves = wp.waves;
    plan.deferred = wp.deferred;

    // 6. Counts and call estimate.
    for (const np of plan.nodes.values()) {
      const c = plan.counts.get(np.object) ?? plan.counts.set(np.object, { insert: 0, upsert: 0, reuse: 0, skip: 0, blocked: 0 }).get(np.object)!;
      c[np.action]++;
    }
    let calls = queries;
    for (const wave of plan.waves) {
      const per = new Map<string, number>();
      for (const k of wave) {
        const p = plan.nodes.get(k)!;
        const gk = `${p.object}|${p.action}`;
        per.set(gk, (per.get(gk) ?? 0) + 1);
      }
      for (const n of per.values()) calls += Math.ceil(n / settings.batchSize);
    }
    calls += Math.ceil(new Set(plan.deferred.map((d) => d.from)).size / settings.batchSize);
    plan.estimatedCalls = calls;
    return plan;
  }

  private referenceProblem(e: Edge, plan: MigrationPlan): string | null {
    if (e.status === 'reference-data') {
      return plan.refDataMap.has(`${e.toObject}:${e.toId}`) ? null : `${e.toObject} ${e.toId} has no match in the destination`;
    }
    if (e.status !== 'in-graph') {
      const why: Record<string, string> = {
        excluded: 'target object or field excluded by rules',
        'out-of-limit': 'target not extracted (depth or record limit)',
        missing: 'target not found or not readable in the source',
        'unknown-object': 'target object not recognised',
      };
      return `${e.toObject ?? '?'} ${e.toId} — ${why[e.status] ?? e.status}`;
    }
    const tp = plan.nodes.get(this.graph.targetKey(e)!);
    if (!tp) return 'target not in dataset';
    if (tp.action === 'skip' || tp.action === 'blocked') return `${tp.object} ${tp.sourceId} is not being migrated (${tp.reason ?? tp.action})`;
    return null;
  }

  private unresolved(np: NodePlan, e: Edge, reason: string, effect: UnresolvedRef['effect']): UnresolvedRef {
    return { key: np.key, object: np.object, sourceId: np.sourceId, field: e.field, targetObject: e.toObject, targetId: e.toId, reason, effect };
  }

  private async mapReferenceData(plan: MigrationPlan, s: MigrationSettings, cancel?: CancelToken): Promise<number> {
    const g = this.graph;
    let queries = 0;
    const all = [...g.refData.values()];
    const set = (obj: string, id: string, dest: string) => plan.refDataMap.set(`${obj}:${id}`, to18(dest));
    const rts = all.filter((r) => r.object === 'RecordType');
    if (rts.length && s.recordTypeStrategy === 'match-developer-name') {
      queries++;
      const rows = await queryIn<Record<string, string>>(this.dest, ['Id', 'DeveloperName', 'SobjectType'], 'RecordType', 'SobjectType', [...new Set(rts.map((r) => r.sobjectType!))], 'IsActive = true', cancel);
      const idx = new Map(rows.map((r) => [`${r.SobjectType}|${r.DeveloperName}`.toLowerCase(), r.Id]));
      for (const r of rts) {
        const d = idx.get(`${r.sobjectType}|${r.developerName}`.toLowerCase());
        if (d) set('RecordType', r.id, d);
      }
    }
    const users = all.filter((r) => r.object === 'User');
    if (users.length) {
      const transform = (u: string) => (s.usernameTransform?.find ? u.split(s.usernameTransform.find).join(s.usernameTransform.replace) : u);
      let field: string;
      let keyOf: (r: (typeof users)[number]) => string | undefined;
      if (s.ownerStrategy === 'match-email') {
        field = 'Email';
        keyOf = (r) => r.email;
      } else if (s.ownerStrategy === 'match-federation') {
        field = 'FederationIdentifier';
        keyOf = (r) => r.federationIdentifier;
      } else {
        field = 'Username';
        keyOf = (r) => (r.username ? transform(r.username) : undefined);
      }
      const keys = users.map(keyOf).filter((k): k is string => !!k);
      if (keys.length) {
        queries += Math.ceil(keys.length / 150);
        const rows = await queryIn<Record<string, string>>(this.dest, ['Id', field], 'User', field, keys, 'IsActive = true', cancel);
        const idx = new Map<string, string[]>();
        for (const r of rows) {
          const k = String(r[field] ?? '').toLowerCase();
          (idx.get(k) ?? idx.set(k, []).get(k)!).push(r.Id);
        }
        for (const u of users) {
          const hits = idx.get((keyOf(u) ?? '').toLowerCase()) ?? [];
          if (hits.length === 1) set('User', u.id, hits[0]);
          else if (hits.length > 1) plan.warnings.push(`User ${u.username ?? u.id}: ${hits.length} active destination users share the same ${field}; not mapped.`);
        }
      }
    }
    const groups = all.filter((r) => r.object === 'Group');
    if (groups.length) {
      queries++;
      const rows = await queryIn<Record<string, string>>(this.dest, ['Id', 'DeveloperName', 'Type'], 'Group', 'DeveloperName', groups.map((r) => r.developerName!).filter(Boolean), '', cancel);
      const idx = new Map(rows.map((r) => [`${r.Type}|${r.DeveloperName}`.toLowerCase(), r.Id]));
      for (const r of groups) {
        const d = idx.get(`${r.type}|${r.developerName}`.toLowerCase());
        if (d) set('Group', r.id, d);
      }
    }
    return queries;
  }
}

// ---------------- Execution ----------------

export type RecordStatus = 'inserted' | 'updated' | 'reused' | 'failed' | 'skipped' | 'blocked' | 'unknown' | 'cancelled' | 'not-run';

export interface RecordResult {
  key: string;
  object: string;
  sourceId: string;
  destId?: string;
  action: PlannedAction;
  status: RecordStatus;
  method?: string;
  field?: string;
  message?: string;
}

export interface DeferredResult {
  key: string;
  object: string;
  sourceId: string;
  field: string;
  status: 'updated' | 'failed' | 'skipped';
  message?: string;
}

export interface MigrationProgress {
  done: number;
  total: number;
  wave: number;
  waves: number;
  message: string;
}

export interface MigrationResult {
  startedAt: string;
  finishedAt: string;
  source: OrgInfo | null;
  destination: OrgInfo;
  records: RecordResult[];
  deferred: DeferredResult[];
  stoppedReason?: string;
  apiCalls: number;
  apiErrors: string[];
}

class StopRun extends Error {}

export class MigrationExecutor {
  private destIds = new Map<string, string>();
  private results = new Map<string, RecordResult>();
  private apiErrors: string[] = [];

  constructor(private graph: RecordGraph, private plan: MigrationPlan, private dest: SalesforceClient, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  async run(onProgress?: (p: MigrationProgress) => void, cancel?: CancelToken): Promise<MigrationResult> {
    const startedAt = new Date().toISOString();
    const startCalls = this.dest.requestCount;
    const plan = this.plan;
    let stoppedReason: string | undefined;

    for (const np of plan.nodes.values()) {
      const base: RecordResult = { key: np.key, object: np.object, sourceId: np.sourceId, action: np.action, status: 'not-run' };
      if (np.action === 'reuse') {
        this.destIds.set(np.key, np.destId!);
        Object.assign(base, { status: 'reused', destId: np.destId, method: np.matchedBy, message: `Matched on ${np.matchedBy}` });
      } else if (np.action === 'skip') Object.assign(base, { status: 'skipped', message: np.reason });
      else if (np.action === 'blocked') Object.assign(base, { status: 'blocked', message: np.reason });
      this.results.set(np.key, base);
    }
    const total = plan.waves.reduce((a, w) => a + w.length, 0);
    let done = 0;
    const deferredSet = new Set(plan.deferred.map((d) => `${d.from}|${d.field}`));

    try {
      for (let wi = 0; wi < plan.waves.length; wi++) {
        const groups = new Map<string, string[]>();
        for (const k of plan.waves[wi]) {
          const p = plan.nodes.get(k)!;
          const gk = `${p.action}|${p.object}`;
          (groups.get(gk) ?? groups.set(gk, []).get(gk)!).push(k);
        }
        for (const [gk, keys] of groups) {
          const [action, object] = gk.split('|') as [PlannedAction, string];
          for (const batch of chunk(keys, plan.settings.batchSize)) {
            if (cancel?.cancelled) throw new StopRun('Cancelled by user');
            onProgress?.({ done, total, wave: wi + 1, waves: plan.waves.length, message: `${action === 'upsert' ? 'Upserting' : 'Inserting'} ${batch.length} ${object}` });
            await this.writeBatch(object, action, batch, deferredSet, cancel);
            done += batch.length;
          }
        }
      }
      if (plan.deferred.length) {
        onProgress?.({ done, total, wave: plan.waves.length, waves: plan.waves.length, message: `Applying ${plan.deferred.length} deferred reference update(s)` });
      }
    } catch (e) {
      stoppedReason = e instanceof StopRun ? e.message : sanitize((e as Error).message);
      for (const r of this.results.values()) if (r.status === 'not-run') r.status = stoppedReason === 'Cancelled by user' ? 'cancelled' : 'not-run';
    }
    const deferred = stoppedReason ? this.skipDeferred('Run stopped before deferred updates') : await this.applyDeferred(cancel);
    onProgress?.({ done: total, total, wave: plan.waves.length, waves: plan.waves.length, message: stoppedReason ?? 'Finished' });

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      source: plan.source,
      destination: plan.destination,
      records: [...this.results.values()],
      deferred,
      stoppedReason,
      apiCalls: this.dest.requestCount - startCalls,
      apiErrors: this.apiErrors,
    };
  }

  /** Builds the payload for one record, or returns a reason it cannot be written. */
  private buildRecord(key: string, deferredSet: Set<string>): { rec?: Record<string, unknown>; fail?: { message: string; field?: string; status: RecordStatus } } {
    const plan = this.plan;
    const np = plan.nodes.get(key)!;
    const node = this.graph.nodes.get(key)!;
    const os = plan.settings.objects[np.object] ?? { operation: 'insert' };
    const types = plan.destTypes.get(np.object)!;
    const rec: Record<string, unknown> = { attributes: { type: np.object } };
    for (const f of plan.sendFields.get(np.object) ?? []) {
      const v = node.fields[f];
      if (v === null || v === undefined || v === '') continue;
      rec[f] = coerce(v, types.get(f));
    }
    const refs = plan.refFields.get(np.object) ?? new Map();
    for (const e of this.graph.edgesFrom(key)) {
      const df = refs.get(e.field);
      if (!df) continue;
      if (deferredSet.has(`${key}|${e.field}`) || plan.omittedRefs.has(`${key}|${e.field}`)) continue;
      if (e.status === 'reference-data') {
        const d = plan.refDataMap.get(`${e.toObject}:${e.toId}`);
        if (d) rec[e.field] = d;
        continue;
      }
      if (e.status !== 'in-graph') continue;
      const tk = this.graph.targetKey(e)!;
      const destId = this.destIds.get(tk);
      if (destId) {
        rec[e.field] = destId;
        continue;
      }
      const tr = this.results.get(tk);
      const why = `Referenced ${e.toObject} ${e.toId} was not migrated (${tr?.status ?? 'unknown'}${tr?.message ? ': ' + tr.message : ''})`;
      if (!df.nillable || plan.settings.unresolvedPolicy === 'skip-record') return { fail: { message: why, field: e.field, status: 'skipped' } };
      // optional reference with blank-field policy: leave it out
    }
    if (os.sourceIdField) rec[os.sourceIdField] = node.id;
    if (np.action === 'upsert' && os.matchField) rec[os.matchField] = np.upsertValue;
    return { rec };
  }

  private async writeBatch(object: string, action: PlannedAction, keys: string[], deferredSet: Set<string>, cancel?: CancelToken) {
    const os = this.plan.settings.objects[object];
    let pending: { key: string; rec: Record<string, unknown> }[] = [];
    for (const k of keys) {
      const b = this.buildRecord(k, deferredSet);
      const r = this.results.get(k)!;
      if (b.fail) Object.assign(r, { status: b.fail.status, message: b.fail.message, field: b.fail.field });
      else pending.push({ key: k, rec: b.rec! });
    }
    for (let attempt = 0; pending.length && attempt < 3; attempt++) {
      if (attempt > 0) await this.sleep(1000 * attempt);
      let res: SaveResult[];
      try {
        res = action === 'upsert' ? await this.dest.upsert(object, os!.matchField!, pending.map((p) => p.rec), cancel) : await this.dest.create(pending.map((p) => p.rec), cancel);
      } catch (e) {
        const err = e as SfError;
        this.apiErrors.push(`${object} ${action}: ${sanitize(err.message)}`);
        if (err.kind === 'ambiguous') {
          for (const p of pending) Object.assign(this.results.get(p.key)!, { status: 'unknown', message: 'Network failure after the request was sent; check the destination before re-running.' });
          throw new StopRun('Stopped: a write may or may not have been applied (network failure). Re-run with a source-Id field and upsert to reconcile safely.');
        }
        if (err.kind === 'auth' || err.kind === 'limit' || err.kind === 'cancelled') {
          throw new StopRun(err.message);
        }
        for (const p of pending) Object.assign(this.results.get(p.key)!, { status: 'failed', message: sanitize(err.message), field: err.fields?.join(', ') });
        return;
      }
      const retry: typeof pending = [];
      res.forEach((r, i) => {
        const p = pending[i];
        const out = this.results.get(p.key)!;
        if (r.success && r.id) {
          const id = to18(r.id);
          this.destIds.set(p.key, id);
          const status: RecordStatus = action === 'upsert' && r.created === false ? 'updated' : 'inserted';
          Object.assign(out, { status, destId: id, method: action === 'upsert' ? `upsert on ${os!.matchField}` : 'insert', message: undefined, field: undefined });
        } else {
          const errs = r.errors ?? [];
          if (errs.length && errs.every((x) => RETRYABLE_RECORD_CODES.has(x.statusCode))) retry.push(p);
          Object.assign(out, {
            status: 'failed',
            message: sanitize(errs.map((x) => `${x.statusCode}: ${x.message}`).join('; ') || 'Unknown error'),
            field: errs.flatMap((x) => x.fields ?? []).join(', ') || undefined,
          });
        }
      });
      pending = retry;
    }
  }

  private skipDeferred(reason: string): DeferredResult[] {
    return this.plan.deferred.map((d) => {
      const np = this.plan.nodes.get(d.from)!;
      return { key: d.from, object: np.object, sourceId: np.sourceId, field: d.field, status: 'skipped', message: reason };
    });
  }

  private async applyDeferred(cancel?: CancelToken): Promise<DeferredResult[]> {
    const out: DeferredResult[] = [];
    const byRecord = new Map<string, { object: string; destId: string; fields: Record<string, string>; deps: Dep[] }>();
    for (const d of this.plan.deferred) {
      const np = this.plan.nodes.get(d.from)!;
      const fromId = this.destIds.get(d.from);
      const toId = this.destIds.get(d.to);
      const fromResult = this.results.get(d.from)!;
      if (!fromId || (fromResult.status !== 'inserted' && fromResult.status !== 'updated')) {
        out.push({ key: d.from, object: np.object, sourceId: np.sourceId, field: d.field, status: 'skipped', message: 'Record was not written' });
        continue;
      }
      if (!toId) {
        out.push({ key: d.from, object: np.object, sourceId: np.sourceId, field: d.field, status: 'failed', message: `Referenced record ${d.to} was not migrated; field left blank` });
        continue;
      }
      const entry = byRecord.get(d.from) ?? byRecord.set(d.from, { object: np.object, destId: fromId, fields: {}, deps: [] }).get(d.from)!;
      entry.fields[d.field] = toId;
      entry.deps.push(d);
    }
    for (const part of chunk([...byRecord.entries()], this.plan.settings.batchSize)) {
      const records = part.map(([, v]) => ({ attributes: { type: v.object }, Id: v.destId, ...v.fields }));
      let res: SaveResult[] = [];
      let batchError: string | undefined;
      try {
        res = await this.dest.update(records, cancel);
      } catch (e) {
        batchError = sanitize((e as Error).message);
        this.apiErrors.push(`Deferred updates: ${batchError}`);
      }
      part.forEach(([key, v], i) => {
        const np = this.plan.nodes.get(key)!;
        const r = res[i];
        for (const d of v.deps) {
          const ok = !batchError && r?.success;
          out.push({
            key,
            object: np.object,
            sourceId: np.sourceId,
            field: d.field,
            status: ok ? 'updated' : 'failed',
            message: ok ? undefined : batchError ?? r?.errors?.map((x) => `${x.statusCode}: ${x.message}`).join('; '),
          });
        }
      });
    }
    return out;
  }
}

/** Converts values (e.g. strings from a CSV package) to the JSON type the destination field expects. */
export function coerce(v: unknown, type?: string): unknown {
  if (typeof v !== 'string') return v;
  switch (type) {
    case 'boolean':
      return /^(true|1|yes)$/i.test(v.trim());
    case 'int':
    case 'double':
    case 'currency':
    case 'percent': {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    default:
      return v;
  }
}

export function summarize(result: MigrationResult) {
  const by = (s: RecordStatus) => result.records.filter((r) => r.status === s).length;
  return {
    discovered: result.records.length,
    processed: result.records.filter((r) => r.status !== 'not-run' && r.status !== 'cancelled').length,
    inserted: by('inserted'),
    updated: by('updated'),
    reused: by('reused'),
    failed: by('failed') + by('unknown'),
    skipped: by('skipped') + by('blocked') + by('cancelled') + by('not-run'),
    deferredUpdated: result.deferred.filter((d) => d.status === 'updated').length,
    deferredFailed: result.deferred.filter((d) => d.status !== 'updated').length,
    apiCalls: result.apiCalls,
    apiErrors: result.apiErrors.length,
  };
}
