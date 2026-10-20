// Export package (zip of CSVs + metadata) and re-import into a RecordGraph, plus migration reports.

import { RecordGraph, Edge, FieldMeta, ReferenceDataRecord, planWaves, nodeKey } from './graph';
import { toCsv, parseCsvObjects } from './csv';
import { createZip, readZip, ZipEntry } from './zip';
import type { MigrationPlan, MigrationResult } from './migrate';
import { summarize } from './migrate';

export const PACKAGE_FORMAT = 'sfdm-export';
export const PACKAGE_VERSION = 1;

const TYPE_COL = (f: string) => `@type:${f}`;

export interface PackageManifest {
  format: string;
  version: number;
  createdAt: string;
  tool: string;
  source: RecordGraph['source'];
  truncated: boolean;
  warnings: string[];
  rules?: unknown;
  objects: { name: string; label: string; file: string; count: number; columns: string[]; fields: FieldMeta[] }[];
  totals: { records: number; dependencies: number; unresolved: number };
}

function objectColumns(graph: RecordGraph, object: string): { cols: string[]; refs: string[] } {
  const nodes = graph.nodesOf(object);
  const present = new Set<string>();
  for (const n of nodes) for (const k of Object.keys(n.fields)) present.add(k);
  const meta = graph.objectFields.get(object) ?? [];
  const ordered = meta.map((m) => m.name).filter((f) => present.has(f) && f !== 'Id');
  for (const f of present) if (f !== 'Id' && !ordered.includes(f)) ordered.push(f);
  const refs = meta.filter((m) => m.type === 'reference' && ordered.includes(m.name)).map((m) => m.name);
  return { cols: ['Id', ...ordered], refs };
}

export function objectCsv(graph: RecordGraph, object: string): string {
  const { cols, refs } = objectColumns(graph, object);
  const edgeType = new Map<string, string>();
  for (const e of graph.edges) if (e.toObject) edgeType.set(`${e.from}|${e.field}`, e.toObject);
  const rows = graph.nodesOf(object).map((n) => [...cols.map((c) => (c === 'Id' ? n.id : n.fields[c])), ...refs.map((r) => edgeType.get(`${n.key}|${r}`) ?? '')]);
  return toCsv([...cols, ...refs.map(TYPE_COL)], rows);
}

export function dependenciesCsv(edges: Edge[], graph: RecordGraph): string {
  return toCsv(
    ['fromObject', 'fromId', 'field', 'toObject', 'toId', 'kind', 'required', 'status'],
    edges.map((e) => {
      const n = graph.nodes.get(e.from)!;
      return [n.object, n.id, e.field, e.toObject ?? '', e.toId, e.kind, e.required, e.status];
    }),
  );
}

export function buildExportPackage(graph: RecordGraph, rules?: unknown): { entries: ZipEntry[]; manifest: PackageManifest } {
  const entries: ZipEntry[] = [];
  const objects: PackageManifest['objects'] = [];
  for (const object of graph.objects().sort()) {
    const file = `objects/${object}.csv`;
    entries.push({ name: file, data: objectCsv(graph, object) });
    const { cols, refs } = objectColumns(graph, object);
    objects.push({ name: object, label: graph.objectLabels.get(object) ?? object, file, count: graph.nodesOf(object).length, columns: [...cols, ...refs.map(TYPE_COL)], fields: graph.objectFields.get(object) ?? [] });
  }
  const deps = graph.edges.filter((e) => e.status === 'in-graph').map((e) => ({ from: e.from, to: graph.targetKey(e)!, field: e.field, deferrable: !e.required && e.kind !== 'master-detail' }));
  const wp = planWaves([...graph.nodes.keys()], deps);
  const loadOrder = {
    description: 'Load waves in order. Within a wave, records only reference records from earlier waves. Apply deferredUpdates after all waves.',
    waves: wp.waves.map((w, i) => {
      const byObj: Record<string, string[]> = {};
      for (const k of w) {
        const n = graph.nodes.get(k)!;
        (byObj[n.object] ??= []).push(n.id);
      }
      return { wave: i + 1, objects: byObj };
    }),
    deferredUpdates: wp.deferred.map((d) => ({ object: graph.nodes.get(d.from)!.object, id: graph.nodes.get(d.from)!.id, field: d.field, references: graph.nodes.get(d.to)!.id })),
    blocked: [...wp.blocked].map(([k, reason]) => ({ object: graph.nodes.get(k)!.object, id: graph.nodes.get(k)!.id, reason })),
  };
  const unresolved = graph.issues();
  entries.push({ name: 'load-order.json', data: JSON.stringify(loadOrder, null, 2) });
  entries.push({ name: 'dependencies.csv', data: dependenciesCsv(graph.edges, graph) });
  entries.push({ name: 'unresolved.csv', data: dependenciesCsv(unresolved, graph) });
  entries.push({
    name: 'reference-data.csv',
    data: toCsv(
      ['object', 'id', 'username', 'email', 'federationIdentifier', 'developerName', 'sobjectType', 'type', 'name'],
      [...graph.refData.values()].map((r) => [r.object, r.id, r.username, r.email, r.federationIdentifier, r.developerName, r.sobjectType, r.type, r.name]),
    ),
  });
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    tool: 'Salesforce Data Migrator',
    source: graph.source,
    truncated: graph.truncated,
    warnings: graph.warnings,
    rules,
    objects,
    totals: { records: graph.nodes.size, dependencies: graph.edges.length, unresolved: unresolved.length },
  };
  entries.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  entries.push({ name: 'README.txt', data: packageReadme(manifest) });
  return { entries, manifest };
}

function packageReadme(m: PackageManifest): string {
  return [
    'Salesforce Data Migrator export',
    `Source org: ${m.source?.name ?? 'unknown'} (${m.source?.orgId ?? ''})`,
    `Created: ${m.createdAt}`,
    `Records: ${m.totals.records} across ${m.objects.length} object(s)`,
    m.truncated ? 'WARNING: discovery stopped at a limit; this export is incomplete.' : 'Discovery completed within the configured limits.',
    '',
    'Files',
    '  objects/<Object>.csv  One file per object. Id and all lookup columns hold SOURCE org Ids.',
    '                        @type:<Field> columns name the object a lookup points to.',
    '  load-order.json       Insert order (waves) and deferred updates for circular references.',
    '  dependencies.csv      Every relationship between exported records, with its status.',
    '  unresolved.csv        References to records not included in the export, with the reason.',
    '  reference-data.csv    Users, queues and record types referenced, for matching in the target org.',
    '',
    'Re-import this zip with Salesforce Data Migrator (Import package) to migrate it with automatic Id remapping.',
  ].join('\n');
}

export function zipExportPackage(graph: RecordGraph, rules?: unknown): Uint8Array {
  return createZip(buildExportPackage(graph, rules).entries);
}

/** Rebuilds a RecordGraph from an export package, so it can be migrated without the source org. */
export async function readExportPackage(bytes: Uint8Array): Promise<RecordGraph> {
  const files = await readZip(bytes);
  const dec = new TextDecoder();
  const text = (n: string) => {
    const f = files.get(n);
    if (!f) throw new Error(`The package is missing ${n}.`);
    return dec.decode(f);
  };
  const manifest = JSON.parse(text('manifest.json')) as PackageManifest;
  if (manifest.format !== PACKAGE_FORMAT) throw new Error('This zip is not a Salesforce Data Migrator export.');
  if (manifest.version > PACKAGE_VERSION) throw new Error('This package was made by a newer version of the extension.');
  const g = new RecordGraph();
  g.source = manifest.source;
  g.truncated = manifest.truncated;
  g.warnings = [...manifest.warnings];
  g.createdAt = manifest.createdAt;
  for (const o of manifest.objects) {
    g.objectFields.set(o.name, o.fields);
    g.objectLabels.set(o.name, o.label);
    const metaByName = new Map(o.fields.map((f) => [f.name, f]));
    for (const row of parseCsvObjects(text(o.file))) {
      const id = row.Id;
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k.startsWith('@type:')) continue;
        fields[k] = v === '' ? null : v;
      }
      if (!metaByName.has('Id')) fields.Id = id;
      g.addNode({ key: nodeKey(o.name, id), object: o.name, id, depth: 0, seed: false, fields });
    }
  }
  for (const d of parseCsvObjects(text('dependencies.csv'))) {
    g.edges.push({
      from: nodeKey(d.fromObject, d.fromId),
      field: d.field,
      toObject: d.toObject || null,
      toId: d.toId,
      kind: (d.kind as Edge['kind']) || 'lookup',
      required: d.required === 'true',
      status: d.status as Edge['status'],
    });
  }
  if (files.has('reference-data.csv')) {
    for (const r of parseCsvObjects(text('reference-data.csv'))) {
      const rec: ReferenceDataRecord = { object: r.object, id: r.id };
      for (const k of ['username', 'email', 'federationIdentifier', 'developerName', 'sobjectType', 'type', 'name'] as const) if (r[k]) rec[k] = r[k];
      g.refData.set(`${r.object}:${r.id}`, rec);
    }
  }
  g.finalize();
  return g;
}

// ---------------- Reports ----------------

export function previewCsv(plan: MigrationPlan): string {
  return toCsv(
    ['object', 'sourceId', 'plannedAction', 'destinationId', 'matchedBy', 'reason'],
    [...plan.nodes.values()].map((n) => [n.object, n.sourceId, n.action, n.destId, n.matchedBy, n.reason]),
  );
}

export function buildMigrationReport(result: MigrationResult, plan: MigrationPlan): Uint8Array {
  const s = summarize(result);
  const entries: ZipEntry[] = [
    { name: 'summary.json', data: JSON.stringify({ ...s, startedAt: result.startedAt, finishedAt: result.finishedAt, source: result.source, destination: result.destination, stoppedReason: result.stoppedReason, apiErrors: result.apiErrors }, null, 2) },
    {
      name: 'results.csv',
      data: toCsv(['object', 'sourceId', 'destinationId', 'plannedAction', 'status', 'method', 'field', 'message'], result.records.map((r) => [r.object, r.sourceId, r.destId, r.action, r.status, r.method, r.field, r.message])),
    },
    {
      name: 'errors.csv',
      data: toCsv(['object', 'sourceId', 'status', 'field', 'message'], result.records.filter((r) => ['failed', 'unknown', 'skipped', 'blocked'].includes(r.status)).map((r) => [r.object, r.sourceId, r.status, r.field, r.message])),
    },
    {
      name: 'id-mapping.csv',
      data: toCsv(
        ['sourceOrgId', 'sourceObject', 'sourceId', 'destinationOrgId', 'destinationObject', 'destinationId', 'method', 'status'],
        result.records.filter((r) => r.destId).map((r) => [result.source?.orgId, r.object, r.sourceId, result.destination.orgId, r.object, r.destId, r.method, r.status]),
      ),
    },
    { name: 'deferred-updates.csv', data: toCsv(['object', 'sourceId', 'field', 'status', 'message'], result.deferred.map((d) => [d.object, d.sourceId, d.field, d.status, d.message])) },
    { name: 'unresolved.csv', data: toCsv(['object', 'sourceId', 'field', 'targetObject', 'targetId', 'effect', 'reason'], plan.unresolved.map((u) => [u.object, u.sourceId, u.field, u.targetObject, u.targetId, u.effect, u.reason])) },
  ];
  return createZip(entries);
}

export function parseMappingCsv(text: string): { sourceObject: string; sourceId: string; destId: string }[] {
  return parseCsvObjects(text)
    .map((r) => ({ sourceObject: r.sourceObject, sourceId: r.sourceId, destId: r.destinationId || r.destId }))
    .filter((r) => r.sourceObject && r.sourceId && r.destId);
}
