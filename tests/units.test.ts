import { describe, it, expect } from 'vitest';
import { to18, isValidId, parseIdList } from '../src/core/ids';
import { assertSalesforceApiOrigin, isSalesforceUiHost } from '../src/core/hosts';
import { checkSoql } from '../src/core/soql';
import { toCsv, parseCsv } from '../src/core/csv';
import { createZip, readZip } from '../src/core/zip';
import { soqlString } from '../src/core/client';
import { sanitize } from '../src/core/errors';
import { planWaves } from '../src/core/graph';

describe('ids', () => {
  it('converts 15 to 18 and validates checksums', () => {
    expect(to18('001D000000IqhSL')).toBe('001D000000IqhSLIAZ');
    expect(isValidId('001D000000IqhSLIAZ')).toBe(true);
    expect(isValidId('001D000000IqhSLIAA')).toBe(false);
    expect(isValidId('001D000000IqhSLiaz')).toBe(true);
    const r = parseIdList("'001D000000IqhSL', 001D000000IqhSLIAZ\nbad-id");
    expect(r.ids).toEqual(['001D000000IqhSLIAZ']);
    expect(r.invalid).toEqual(['bad-id']);
  });
});

describe('host gate', () => {
  it('allows Salesforce API hosts only', () => {
    expect(assertSalesforceApiOrigin('https://acme.my.salesforce.com/services/data')).toBe('https://acme.my.salesforce.com');
    expect(assertSalesforceApiOrigin('https://acme--uat.sandbox.my.salesforce.com')).toBe('https://acme--uat.sandbox.my.salesforce.com');
    expect(() => assertSalesforceApiOrigin('https://evil.com')).toThrow();
    expect(() => assertSalesforceApiOrigin('https://salesforce.com.evil.com')).toThrow();
    expect(() => assertSalesforceApiOrigin('http://acme.my.salesforce.com')).toThrow();
    expect(() => assertSalesforceApiOrigin('https://user:pw@acme.my.salesforce.com')).toThrow();
    expect(isSalesforceUiHost('acme.lightning.force.com')).toBe(true);
  });
});

describe('soql guard', () => {
  it('accepts Id queries and rejects others', () => {
    expect(checkSoql("SELECT Id FROM Contact WHERE AccountId = '001'")).toEqual({ ok: true, object: 'Contact' });
    expect(checkSoql('SELECT Id, Name, (SELECT Id FROM Contacts) FROM Account').object).toBe('Account');
    expect(checkSoql('SELECT Name FROM Account').ok).toBe(false);
    expect(checkSoql('SELECT COUNT(Id) FROM Account').ok).toBe(false);
    expect(checkSoql('DELETE FROM Account').ok).toBe(false);
    expect(checkSoql("SELECT Id FROM Account WHERE Name = 'x; y'").ok).toBe(true);
  });
  it('escapes SOQL literals', () => {
    expect(soqlString("O'Brien\\")).toBe("'O\\'Brien\\\\'");
  });
});

describe('csv', () => {
  it('escapes and round-trips commas, quotes, newlines and unicode', () => {
    const csv = toCsv(['a', 'b'], [['x,y', 'he said "hi"'], ['line1\nline2', 'ಕನ್ನಡ ✓'], [null, 5]]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(parseCsv(csv)).toEqual([['a', 'b'], ['x,y', 'he said "hi"'], ['line1\nline2', 'ಕನ್ನಡ ✓'], ['', '5']]);
  });
});

describe('zip', () => {
  it('round-trips stored entries', async () => {
    const z = createZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.csv', data: 'x,y' }]);
    const files = await readZip(z);
    expect(new TextDecoder().decode(files.get('dir/b.csv'))).toBe('x,y');
  });
});

describe('ordering', () => {
  it('blocks cycles made only of required references', () => {
    const wp = planWaves(['A', 'B', 'C'], [
      { from: 'A', to: 'B', field: 'f', deferrable: false },
      { from: 'B', to: 'A', field: 'g', deferrable: false },
      { from: 'C', to: 'A', field: 'h', deferrable: false },
    ]);
    expect([...wp.blocked.keys()].sort()).toEqual(['A', 'B']);
    expect(wp.waves.flat()).toEqual(['C']);
  });
  it('orders parents before children', () => {
    const wp = planWaves(['child', 'parent', 'grand'], [
      { from: 'child', to: 'parent', field: 'p', deferrable: true },
      { from: 'parent', to: 'grand', field: 'p', deferrable: true },
    ]);
    expect(wp.waves).toEqual([['grand'], ['parent'], ['child']]);
  });
});

describe('sanitize', () => {
  it('redacts session ids', () => {
    expect(sanitize('bad 00D5g000004ABCD!AQ4AQFakeTokenValue1234567890 here')).toBe('bad [session] here');
  });
});
