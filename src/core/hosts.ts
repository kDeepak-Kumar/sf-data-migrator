// Host validation: the only gate through which any Salesforce URL passes.

/** Domains that serve the Salesforce REST API (commercial, sandbox, scratch, Government Cloud). */
export const API_DOMAIN_SUFFIXES = [
  '.salesforce.com',
  '.cloudforce.com',
  '.salesforce.mil',
  '.cloudforce.mil',
  '.sfcrmproducts.cn',
];

/** Domains a Salesforce UI page may be served from (used to detect the org from the current tab). */
export const UI_DOMAIN_SUFFIXES = [
  ...API_DOMAIN_SUFFIXES,
  '.force.com',
  '.salesforce-setup.com',
  '.visualforce.com',
  '.force.mil',
  '.salesforce-setup.mil',
  '.sfcrmapps.cn',
];

function hostOf(input: string): string {
  if (/^https:\/\//i.test(input)) {
    const u = new URL(input);
    if (u.username || u.password || (u.port && u.port !== '443')) throw new Error(`Rejected URL: ${input}`);
    return u.hostname.toLowerCase();
  }
  if (/^[a-z0-9.-]+$/i.test(input)) return input.toLowerCase();
  throw new Error(`Rejected host: ${input}`);
}

function matches(host: string, suffixes: string[]): boolean {
  return suffixes.some((s) => host.endsWith(s) && host.length > s.length);
}

export function isSalesforceApiHost(input: string): boolean {
  try {
    return matches(hostOf(input), API_DOMAIN_SUFFIXES);
  } catch {
    return false;
  }
}

export function isSalesforceUiHost(input: string): boolean {
  try {
    return matches(hostOf(input), UI_DOMAIN_SUFFIXES);
  } catch {
    return false;
  }
}

/** Throws unless the URL is an https URL on a Salesforce API domain. Returns the normalised origin. */
export function assertSalesforceApiOrigin(url: string): string {
  if (!/^https:\/\//i.test(url)) throw new Error('Only https Salesforce URLs are allowed.');
  const host = hostOf(url);
  if (!matches(host, API_DOMAIN_SUFFIXES)) throw new Error(`Blocked request to non-Salesforce host: ${host}`);
  return `https://${host}`;
}
