// Salesforce record Id helpers: 15/18 conversion, checksum validation, parsing.

const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/** Converts a 15-character Id to its 18-character case-insensitive form. */
export function to18(id: string): string {
  if (id.length === 18) return id.slice(0, 15) + id.slice(15).toUpperCase();
  if (id.length !== 15) throw new Error(`Invalid Salesforce Id length: ${id}`);
  let suffix = '';
  for (let block = 0; block < 3; block++) {
    let flags = 0;
    for (let i = 0; i < 5; i++) {
      const c = id.charAt(block * 5 + i);
      if (c >= 'A' && c <= 'Z') flags += 1 << i;
    }
    suffix += SUFFIX_CHARS.charAt(flags);
  }
  return id + suffix;
}

/** True when the string is a well-formed 15- or 18-character Id (checksum verified for 18). */
export function isValidId(id: string): boolean {
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)) return false;
  if (id.length === 18) return to18(id.slice(0, 15)) === id.slice(0, 15) + id.slice(15).toUpperCase();
  return true;
}

export function normalizeId(id: string): string {
  const trimmed = id.trim();
  if (!isValidId(trimmed)) throw new Error(`Invalid Salesforce Id: ${trimmed}`);
  return to18(trimmed);
}

export function keyPrefix(id: string): string {
  return id.slice(0, 3);
}

/** Parses Ids from free text (newlines, commas, spaces, quotes). Returns valid 18-char Ids and the invalid tokens. */
export function parseIdList(text: string): { ids: string[]; invalid: string[] } {
  const tokens = text.split(/[\s,;'"()]+/).map((t) => t.trim()).filter(Boolean);
  const ids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (isValidId(t)) {
      const n = to18(t);
      if (!seen.has(n)) {
        seen.add(n);
        ids.push(n);
      }
    } else invalid.push(t);
  }
  return { ids, invalid };
}

export function looksLikeId(value: unknown): value is string {
  return typeof value === 'string' && isValidId(value);
}
