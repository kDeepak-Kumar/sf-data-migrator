// RFC 4180 CSV writing and parsing.

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

/** Builds a CSV document; a UTF-8 BOM is added so Excel reads non-ASCII text correctly. */
export function toCsv(header: string[], rows: unknown[][], bom = true): string {
  const lines = [csvRow(header), ...rows.map(csvRow)];
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function parseCsvObjects(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.filter((r) => r.length > 1 || r[0] !== '').map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
