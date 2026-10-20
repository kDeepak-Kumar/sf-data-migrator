// Local SOQL guard. Full syntax checking is done server-side with the explain endpoint.

export interface SoqlCheck {
  ok: boolean;
  object?: string;
  error?: string;
}

export function checkSoql(soql: string): SoqlCheck {
  const q = soql.trim().replace(/;\s*$/, '');
  if (!q) return { ok: false, error: 'Enter a SOQL query.' };
  if (!/^select\s/i.test(q)) return { ok: false, error: 'The query must start with SELECT.' };
  // Strip string literals and subqueries before inspecting the outer query.
  const noStrings = q.replace(/'(?:\\.|[^'\\])*'/g, "''");
  if (/;/.test(noStrings)) return { ok: false, error: 'Only one query is allowed.' };
  const outer = stripParens(noStrings);
  const from = /\sfrom\s+([A-Za-z0-9_]+)/i.exec(outer);
  if (!from) return { ok: false, error: 'Could not find a FROM clause.' };
  const selectList = outer.slice(6, from.index).trim();
  if (/\b(count|sum|avg|min|max|count_distinct)\s*\(/i.test(noStrings.slice(6, noStrings.search(/\sfrom\s/i))) || /\sgroup\s+by\s/i.test(outer)) {
    return { ok: false, error: 'Aggregate queries are not supported; select record Ids instead.' };
  }
  const fields = selectList.split(',').map((s) => s.trim().toLowerCase());
  if (!fields.includes('id')) return { ok: false, error: 'The query must select the Id field, e.g. SELECT Id FROM Contact WHERE ...' };
  return { ok: true, object: from[1] };
}

function stripParens(s: string): string {
  let depth = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (depth === 0) out += ch;
    if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return out;
}

export function normalizeSoql(soql: string): string {
  return soql.trim().replace(/;\s*$/, '');
}
