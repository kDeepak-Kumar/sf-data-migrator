// Record graph: nodes are records, edges are populated reference fields (child -> referenced record).

import type { ReferenceKind } from './describe';

export type EdgeStatus =
  | 'in-graph' // target record was extracted
  | 'reference-data' // User, Group, RecordType: matched in the destination, never copied
  | 'excluded' // target object or field excluded by rules
  | 'out-of-limit' // depth or record limit reached before the target was fetched
  | 'missing' // target not found or not readable in the source
  | 'unknown-object'; // Id prefix not recognised in the source org

export interface RecordNode {
  key: string; // `${object}:${id}`
  object: string;
  id: string;
  depth: number;
  seed: boolean;
  fields: Record<string, unknown>;
}

export interface Edge {
  from: string; // node key
  field: string;
  toObject: string | null;
  toId: string;
  kind: ReferenceKind;
  required: boolean;
  status: EdgeStatus;
}

export interface FieldMeta {
  name: string;
  label: string;
  type: string;
  referenceTo: string[];
  kind?: ReferenceKind;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
}

export interface ReferenceDataRecord {
  object: string; // User | Group | RecordType
  id: string;
  username?: string;
  email?: string;
  federationIdentifier?: string;
  developerName?: string;
  sobjectType?: string;
  type?: string;
  name?: string;
}

export interface OrgInfo {
  orgId: string;
  name: string;
  instanceUrl: string;
  isSandbox: boolean;
  orgType: string;
  username?: string;
  userId?: string;
}

export const nodeKey = (object: string, id: string) => `${object}:${id}`;

export class RecordGraph {
  nodes = new Map<string, RecordNode>();
  edges: Edge[] = [];
  /** Field metadata per object, captured at extraction time so an export can be re-imported without the source org. */
  objectFields = new Map<string, FieldMeta[]>();
  objectLabels = new Map<string, string>();
  refData = new Map<string, ReferenceDataRecord>();
  truncated = false;
  warnings: string[] = [];
  maxDepthReached = 0;
  source: OrgInfo | null = null;
  createdAt = new Date().toISOString();

  addNode(n: RecordNode) {
    this.nodes.set(n.key, n);
    if (n.depth > this.maxDepthReached) this.maxDepthReached = n.depth;
  }

  has(object: string, id: string) {
    return this.nodes.has(nodeKey(object, id));
  }

  edgesFrom(key: string): Edge[] {
    return this.edgeIndex().get(key) ?? [];
  }

  private _index: Map<string, Edge[]> | null = null;
  private _indexLen = -1;
  private edgeIndex(): Map<string, Edge[]> {
    if (!this._index || this._indexLen !== this.edges.length) {
      this._index = new Map();
      for (const e of this.edges) {
        let arr = this._index.get(e.from);
        if (!arr) this._index.set(e.from, (arr = []));
        arr.push(e);
      }
      this._indexLen = this.edges.length;
    }
    return this._index;
  }

  targetKey(e: Edge): string | null {
    return e.toObject ? nodeKey(e.toObject, e.toId) : null;
  }

  objects(): string[] {
    return [...new Set([...this.nodes.values()].map((n) => n.object))];
  }

  countsByObject(): Map<string, number> {
    const m = new Map<string, number>();
    for (const n of this.nodes.values()) m.set(n.object, (m.get(n.object) ?? 0) + 1);
    return m;
  }

  nodesOf(object: string): RecordNode[] {
    return [...this.nodes.values()].filter((n) => n.object === object);
  }

  issues(): Edge[] {
    return this.edges.filter((e) => e.status !== 'in-graph' && e.status !== 'reference-data');
  }

  /** Recomputes edge statuses after discovery: any edge whose target exists is in-graph. */
  finalize() {
    for (const e of this.edges) {
      const k = this.targetKey(e);
      if (k && this.nodes.has(k)) e.status = 'in-graph';
      else if (e.status === 'in-graph') e.status = 'missing';
    }
  }
}

// ---------------- Ordering ----------------

export interface Dep {
  from: string;
  to: string;
  field: string;
  deferrable: boolean;
}

export interface WavePlan {
  waves: string[][];
  deferred: Dep[];
  blocked: Map<string, string>; // key -> reason
}

/** Tarjan's strongly connected components (iterative, no recursion limits). */
export function stronglyConnected(nodes: string[], adj: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const start of nodes) {
    if (idx.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1];
      const succ = adj.get(top.v) ?? [];
      if (top.i < succ.length) {
        const w = succ[top.i++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
        }
        if (low.get(top.v) === idx.get(top.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== top.v);
          out.push(comp);
        }
      }
    }
  }
  return out;
}

/**
 * Orders records so every record is written after the records it references.
 * Cycles are broken by deferring nillable, non-master-detail references to a later update;
 * cycles with no deferrable reference are reported as blocked.
 */
export function planWaves(nodes: string[], deps: Dep[]): WavePlan {
  const nodeSet = new Set(nodes);
  const live = deps.filter((d) => nodeSet.has(d.from) && nodeSet.has(d.to));
  const deferred: Dep[] = [];
  const blocked = new Map<string, string>();

  const adjOf = (ds: Dep[]) => {
    const adj = new Map<string, string[]>();
    for (const d of ds) {
      let a = adj.get(d.from);
      if (!a) adj.set(d.from, (a = []));
      a.push(d.to);
    }
    return adj;
  };
  const cyclicComponents = (ds: Dep[]) => {
    const selfLoops = new Set(ds.filter((d) => d.from === d.to).map((d) => d.from));
    return stronglyConnected(nodes, adjOf(ds)).filter((c) => c.length > 1 || selfLoops.has(c[0]));
  };

  // Break each cycle by deferring as few references as possible; block cycles with nothing deferrable.
  let active = live;
  for (let guard = 0; guard < live.length + 1; guard++) {
    const comps = cyclicComponents(active);
    if (!comps.length) break;
    const remove = new Set<Dep>();
    for (const comp of comps) {
      const members = new Set(comp);
      const candidate = active.find((d) => d.deferrable && members.has(d.from) && members.has(d.to));
      if (candidate) remove.add(candidate);
      else for (const k of comp) blocked.set(k, 'Circular reference through required (master-detail or non-nillable) fields cannot be inserted through the API.');
    }
    for (const d of remove) deferred.push(d);
    active = active.filter((d) => !remove.has(d) && !blocked.has(d.from) && !blocked.has(d.to));
  }

  // Longest-path layering: wave(n) = 1 + max(wave(dependency)).
  const adj = adjOf(active);
  const wave = new Map<string, number>();
  const order = nodes.filter((n) => !blocked.has(n));
  const visit = (start: string) => {
    const stack: { v: string; i: number }[] = [{ v: start, i: 0 }];
    const onPath = new Set([start]);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const succ = (adj.get(top.v) ?? []).filter((s) => !blocked.has(s));
      if (top.i < succ.length) {
        const w = succ[top.i++];
        if (!wave.has(w) && !onPath.has(w)) {
          onPath.add(w);
          stack.push({ v: w, i: 0 });
        }
      } else {
        stack.pop();
        onPath.delete(top.v);
        let w = 0;
        for (const s of succ) if (wave.has(s)) w = Math.max(w, wave.get(s)! + 1);
        wave.set(top.v, w);
      }
    }
  };
  for (const n of order) if (!wave.has(n)) visit(n);
  const waves: string[][] = [];
  for (const n of order) {
    const w = wave.get(n)!;
    (waves[w] ??= []).push(n);
  }
  return { waves: waves.filter(Boolean), deferred, blocked };
}
