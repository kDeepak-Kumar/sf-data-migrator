// Reference data (User, Group, RecordType): captured from the source so it can be matched in the destination.

import { SalesforceClient, queryIn } from './client';
import { RecordGraph, ReferenceDataRecord } from './graph';
import { CancelToken } from './errors';
import { to18 } from './ids';

export async function collectReferenceData(client: SalesforceClient, graph: RecordGraph, cancel?: CancelToken): Promise<void> {
  const byObject = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.status !== 'reference-data' || !e.toObject) continue;
    (byObject.get(e.toObject) ?? byObject.set(e.toObject, new Set()).get(e.toObject)!).add(e.toId);
  }
  const put = (r: ReferenceDataRecord) => graph.refData.set(`${r.object}:${r.id}`, r);
  const safe = async (fn: () => Promise<void>, what: string) => {
    try {
      await fn();
    } catch (e) {
      graph.warnings.push(`Could not read ${what} details from the source: ${(e as Error).message}`);
    }
  };
  const users = [...(byObject.get('User') ?? [])];
  if (users.length) {
    await safe(async () => {
      const rows = await queryIn<Record<string, any>>(client, ['Id', 'Username', 'Email', 'FederationIdentifier', 'Name'], 'User', 'Id', users, '', cancel);
      for (const u of rows) put({ object: 'User', id: to18(u.Id), username: u.Username, email: u.Email, federationIdentifier: u.FederationIdentifier ?? undefined, name: u.Name });
    }, 'User');
  }
  const groups = [...(byObject.get('Group') ?? [])];
  if (groups.length) {
    await safe(async () => {
      const rows = await queryIn<Record<string, any>>(client, ['Id', 'DeveloperName', 'Type', 'Name'], 'Group', 'Id', groups, '', cancel);
      for (const g of rows) put({ object: 'Group', id: to18(g.Id), developerName: g.DeveloperName, type: g.Type, name: g.Name });
    }, 'Group/Queue');
  }
  const rts = [...(byObject.get('RecordType') ?? [])];
  if (rts.length) {
    await safe(async () => {
      const rows = await queryIn<Record<string, any>>(client, ['Id', 'DeveloperName', 'SobjectType', 'Name'], 'RecordType', 'Id', rts, '', cancel);
      for (const r of rows) put({ object: 'RecordType', id: to18(r.Id), developerName: r.DeveloperName, sobjectType: r.SobjectType, name: r.Name });
    }, 'RecordType');
  }
}
