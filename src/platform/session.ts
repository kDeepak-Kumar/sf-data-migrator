// Chrome adapter: reuses the browser's existing Salesforce session (sid cookie), like other inspector tools.
// The session never leaves this extension; it is read on demand and never written to storage or logs.

import { SessionProvider, Session, SalesforceClient } from '../core/client';
import { DescribeService } from '../core/describe';
import { isSalesforceApiHost } from '../core/hosts';
import { OrgInfo } from '../core/graph';
import { SfError } from '../core/errors';

export interface DetectedSession {
  orgId: string;
  apiHost: string;
}

const SID = /^(00D[a-zA-Z0-9]{12,15})!/;

export async function listSessions(): Promise<DetectedSession[]> {
  const cookies = await chrome.cookies.getAll({ name: 'sid' });
  const byOrg = new Map<string, DetectedSession>();
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, '');
    const m = SID.exec(c.value);
    if (!m || !isSalesforceApiHost(host) || /^login\.|^test\./.test(host)) continue;
    const existing = byOrg.get(m[1]);
    // Prefer My Domain API hosts over instance hosts.
    if (!existing || (/\.my\.salesforce\./.test(host) && !/\.my\.salesforce\./.test(existing.apiHost))) byOrg.set(m[1], { orgId: m[1], apiHost: host });
  }
  return [...byOrg.values()];
}

/** Maps a Salesforce UI host (Lightning, Setup, Visualforce) to the org's API session. */
export async function sessionForUiHost(uiHost: string): Promise<DetectedSession | null> {
  const c = await chrome.cookies.get({ url: `https://${uiHost}`, name: 'sid' });
  const m = c && SID.exec(c.value);
  const all = await listSessions();
  if (m) return all.find((s) => s.orgId === m[1]) ?? null;
  return all.find((s) => s.apiHost === uiHost) ?? null;
}

export class CookieSessionProvider implements SessionProvider {
  private last = '';
  constructor(public apiHost: string, public orgId: string) {}

  async getSession(): Promise<Session> {
    const c = await chrome.cookies.get({ url: `https://${this.apiHost}`, name: 'sid' });
    if (!c || !c.value.startsWith(this.orgId)) {
      throw new SfError(`No active session for ${this.apiHost}. Log in to this org in a browser tab, then click Reconnect.`, 'auth', 401, 'INVALID_SESSION_ID');
    }
    this.last = c.value;
    return { instanceUrl: `https://${this.apiHost}`, accessToken: c.value };
  }

  async refresh(): Promise<boolean> {
    const c = await chrome.cookies.get({ url: `https://${this.apiHost}`, name: 'sid' });
    return !!c && c.value !== this.last && c.value.startsWith(this.orgId);
  }
}

export interface OrgConnection {
  info: OrgInfo;
  client: SalesforceClient;
  describe: DescribeService;
}

export async function connect(s: DetectedSession): Promise<OrgConnection> {
  const client = new SalesforceClient(new CookieSessionProvider(s.apiHost, s.orgId));
  await client.init();
  const [org] = await client.query<{ Id: string; Name: string; IsSandbox: boolean; OrganizationType: string }>('SELECT Id, Name, IsSandbox, OrganizationType FROM Organization LIMIT 1');
  let username: string | undefined;
  let userId: string | undefined;
  try {
    const u = await client.request<{ preferred_username?: string; user_id?: string }>('GET', '/services/oauth2/userinfo');
    username = u.preferred_username;
    userId = u.user_id;
  } catch {
    /* optional */
  }
  const isScratch = /\.scratch\./.test(s.apiHost);
  return {
    client,
    describe: new DescribeService(client),
    info: {
      orgId: s.orgId,
      name: org?.Name ?? s.apiHost,
      instanceUrl: `https://${s.apiHost}`,
      isSandbox: !!org?.IsSandbox || isScratch,
      orgType: isScratch ? 'Scratch' : org?.IsSandbox ? 'Sandbox' : org?.OrganizationType ?? 'Unknown',
      username,
      userId,
    },
  };
}
