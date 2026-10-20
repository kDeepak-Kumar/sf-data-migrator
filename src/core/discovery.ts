// Relationship discovery: breadth-first walk over populated references, one depth level at a time.

import { SalesforceClient, chunk, queryIn } from './client';
import { DescribeService, ObjectInfo, UNSUPPORTED_TYPES, referenceKind } from './describe';
import { RecordGraph, nodeKey, Edge, EdgeStatus, FieldMeta } from './graph';
import { DiscoveryRules, isFieldExcluded, isObjectExcluded, isReferenceData } from './rules';
import { CancelToken, checkCancel } from './errors';
import { looksLikeId, to18 } from './ids';

export interface DiscoveryProgress {
  phase: string;
  depth: number;
  records: number;
  message?: string;
}

export interface DiscoveryInput {
  /** Seed records grouped by object API name, Ids already normalised to 18 characters. */
  seeds: Map<string, string[]>;
  rules: DiscoveryRules;
  onProgress?: (p: DiscoveryProgress) => void;
  cancel?: CancelToken;
}

const RETRIEVE_CHUNK = 500;

export class DiscoveryEngine {
  constructor(private client: SalesforceClient, private describe: DescribeService) {}

  /** Chooses which fields to read for an object according to the rules. */
  fieldsToFetch(info: ObjectInfo, rules: DiscoveryRules): string[] {
    return info.fields
      .filter((f) => !UNSUPPORTED_TYPES.has(f.type))
      .filter((f) => f.name === 'Id' || !isFieldExcluded(rules, info.name, f.name))
      .filter((f) => rules.fieldMode === 'all' || f.name === 'Id' || f.name === 'Name' || f.createable || f.updateable || f.type === 'reference')
      .map((f) => f.name);
  }

  async run(input: DiscoveryInput): Promise<RecordGraph> {
    const { rules, cancel } = input;
    const graph = new RecordGraph();
    const visited = new Set<string>(); // node keys fetched or queued (org is implicit: one graph per source org)
    const report = (phase: string, depth: number, message?: string) => input.onProgress?.({ phase, depth, records: graph.nodes.size, message });

    let frontier = new Map<string, Set<string>>();
    for (const [obj, ids] of input.seeds) {
      const name = (await this.describe.resolveName(obj)) ?? obj;
      for (const id of ids) {
        visited.add(nodeKey(name, id));
        (frontier.get(name) ?? frontier.set(name, new Set()).get(name)!).add(id);
      }
    }
    const seedKeys = new Set(visited);
    const queuedCount = () => visited.size;

    for (let depth = 0; frontier.size > 0; depth++) {
      checkCancel(cancel);
      const next = new Map<string, Set<string>>();
      const fetchedThisLevel: string[] = [];

      for (const [object, idSet] of frontier) {
        checkCancel(cancel);
        let info: ObjectInfo;
        try {
          info = await this.describe.describe(object);
        } catch (e) {
          graph.warnings.push(`Could not describe ${object}: ${(e as Error).message}`);
          continue;
        }
        if (!info.queryable) {
          graph.warnings.push(`${object} is not queryable by your user; its records were skipped.`);
          continue;
        }
        this.captureMeta(graph, info);
        const fields = this.fieldsToFetch(info, rules);
        for (const part of chunk([...idSet], RETRIEVE_CHUNK)) {
          checkCancel(cancel);
          report('Fetching records', depth, `${object}: ${part.length} record(s)`);
          const rows = await this.client.retrieve(object, part, fields, cancel);
          rows.forEach((row) => {
            if (!row) return;
            const id = to18(String(row.Id));
            const values: Record<string, unknown> = {};
            for (const f of fields) if (f in row) values[f] = row[f];
            const key = nodeKey(object, id);
            graph.addNode({ key, object, id, depth, seed: seedKeys.has(key), fields: values });
            fetchedThisLevel.push(key);
          });
        }
      }

      // Forward references from records fetched at this level.
      for (const key of fetchedThisLevel) {
        const node = graph.nodes.get(key)!;
        const info = await this.describe.describe(node.object);
        for (const f of info.fields) {
          if (f.type !== 'reference' || f.name === 'Id') continue;
          const raw = node.fields[f.name];
          if (!looksLikeId(raw)) continue;
          if (isFieldExcluded(rules, node.object, f.name)) continue;
          const toId = to18(raw);
          const toObject = await this.describe.objectForId(toId);
          const kind = referenceKind(f);
          const edge: Edge = { from: key, field: f.name, toObject, toId, kind, required: !f.nillable, status: 'in-graph' };
          edge.status = this.classify(edge, depth, rules, visited, queuedCount, graph);
          graph.edges.push(edge);
          if (edge.status === 'in-graph' && toObject) {
            const tk = nodeKey(toObject, toId);
            if (!visited.has(tk)) {
              visited.add(tk);
              (next.get(toObject) ?? next.set(toObject, new Set()).get(toObject)!).add(toId);
            }
          }
        }
      }

      // Reverse (child) relationships, only those the user switched on.
      if (rules.childRules.length && depth < rules.maxDepth) {
        for (const rule of rules.childRules) {
          checkCancel(cancel);
          const parents = fetchedThisLevel.filter((k) => graph.nodes.get(k)!.object.toLowerCase() === rule.parentObject.toLowerCase()).map((k) => graph.nodes.get(k)!.id);
          if (!parents.length) continue;
          if (isObjectExcluded(rules, rule.childObject)) continue;
          const remaining = rules.maxRecords - queuedCount();
          if (remaining <= 0) {
            graph.truncated = true;
            graph.warnings.push(`Record limit reached before child records of ${rule.parentObject} (${rule.childObject}.${rule.field}) were collected.`);
            continue;
          }
          report('Collecting child records', depth, `${rule.childObject} via ${rule.field}`);
          const children = await queryIn<{ Id: string } & Record<string, unknown>>(this.client, ['Id', rule.field], rule.childObject, rule.field, parents, '', cancel);
          const perParent = new Map<string, number>();
          let added = 0;
          for (const c of children) {
            const cid = to18(c.Id);
            const k = nodeKey(rule.childObject, cid);
            if (visited.has(k)) continue;
            const parent = String(c[rule.field] ?? '');
            const n = (perParent.get(parent) ?? 0) + 1;
            if (rule.maxPerParent && n > rule.maxPerParent) {
              graph.truncated = true;
              continue;
            }
            if (queuedCount() >= rules.maxRecords) {
              graph.truncated = true;
              graph.warnings.push(`Record limit reached while collecting ${rule.childObject} children; some were not extracted.`);
              break;
            }
            perParent.set(parent, n);
            visited.add(k);
            added++;
            (next.get(rule.childObject) ?? next.set(rule.childObject, new Set()).get(rule.childObject)!).add(cid);
          }
          if (rule.maxPerParent && children.length > added) graph.warnings.push(`${rule.childObject}: per-parent limit of ${rule.maxPerParent} applied.`);
        }
      }
      frontier = next;
    }

    graph.finalize();
    if (graph.edges.some((e) => e.status === 'out-of-limit')) graph.truncated = true;
    if (graph.truncated) graph.warnings.unshift('Discovery stopped at a configured limit. The dataset is incomplete: some referenced records were not extracted.');
    report('Done', graph.maxDepthReached);
    return graph;
  }

  private classify(edge: Edge, depth: number, rules: DiscoveryRules, visited: Set<string>, queued: () => number, graph: RecordGraph): EdgeStatus {
    if (!edge.toObject) return 'unknown-object';
    if (isReferenceData(edge.toObject)) return 'reference-data';
    if (isObjectExcluded(rules, edge.toObject)) return 'excluded';
    if (edge.kind === 'master-detail' && !rules.followMasterDetail) return 'excluded';
    if (edge.kind === 'lookup' && !rules.followLookups) return 'excluded';
    if (edge.kind === 'polymorphic' && !rules.followPolymorphic) return 'excluded';
    if (visited.has(nodeKey(edge.toObject, edge.toId))) return 'in-graph';
    if (depth + 1 > rules.maxDepth) {
      graph.truncated = true;
      return 'out-of-limit';
    }
    if (queued() >= rules.maxRecords) {
      graph.truncated = true;
      return 'out-of-limit';
    }
    return 'in-graph';
  }

  private captureMeta(graph: RecordGraph, info: ObjectInfo) {
    if (graph.objectFields.has(info.name)) return;
    graph.objectLabels.set(info.name, info.label);
    const meta: FieldMeta[] = info.fields
      .filter((f) => !UNSUPPORTED_TYPES.has(f.type))
      .map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        referenceTo: f.referenceTo,
        kind: f.type === 'reference' ? referenceKind(f) : undefined,
        nillable: f.nillable,
        createable: f.createable,
        updateable: f.updateable,
      }));
    graph.objectFields.set(info.name, meta);
  }
}

/** Resolves selection input (Ids or SOQL) into seeds grouped by object. */
export async function resolveSeeds(
  client: SalesforceClient,
  describe: DescribeService,
  input: { ids?: string[]; soql?: string; maxRecords: number },
): Promise<{ seeds: Map<string, string[]>; warnings: string[] }> {
  const seeds = new Map<string, string[]>();
  const warnings: string[] = [];
  if (input.ids?.length) {
    for (const id of input.ids) {
      const obj = await describe.objectForId(id);
      if (!obj) {
        warnings.push(`Id ${id} does not match any object in this org.`);
        continue;
      }
      (seeds.get(obj) ?? seeds.set(obj, []).get(obj)!).push(id);
    }
  }
  if (input.soql) {
    await client.explain(input.soql);
    const rows = await client.query<{ Id: string; attributes?: { type: string } }>(input.soql, input.maxRecords + 1);
    if (rows.length > input.maxRecords) {
      warnings.push(`The query returned more than ${input.maxRecords} records; only the first ${input.maxRecords} were used.`);
      rows.length = input.maxRecords;
    }
    for (const r of rows) {
      if (!r.Id) throw new Error('The query result has no Id column.');
      const id = to18(r.Id);
      const obj = r.attributes?.type ?? (await describe.objectForId(id));
      if (!obj) continue;
      const list = seeds.get(obj) ?? seeds.set(obj, []).get(obj)!;
      if (!list.includes(id)) list.push(id);
    }
  }
  return { seeds, warnings };
}
