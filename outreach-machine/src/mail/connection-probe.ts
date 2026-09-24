import type { GraphTokenProvider } from './token-provider.js';

export type ProbeOutcome = { targetReadable: boolean; controlDenied: boolean };

async function readInboxFolder(token: string, id: string, fetchImplementation: typeof fetch) {
  const response = await fetchImplementation(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(id)}/mailFolders/inbox?$select=id`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) },
  );
  const body: unknown = await response.json().catch(() => null);
  const data = body as { id?: unknown; error?: { code?: unknown } } | null;
  return { status: response.status, id: data?.id, code: data?.error?.code };
}

// A positive read alone MUST NOT be reported as proof of mailbox isolation.
export async function probeTargetMailboxRead(
  tokenProvider: GraphTokenProvider,
  targetId: string,
  fetchImplementation: typeof fetch = fetch,
) {
  const target = await readInboxFolder(await tokenProvider.getAccessToken(), targetId, fetchImplementation);
  if (target.status !== 200 || typeof target.id !== 'string' || !target.id) throw new Error(`Target read failed (HTTP ${target.status}); connection is not verified`);
  return { targetReadable: true, controlDenied: null, mailboxIsolationVerified: false } as const;
}

// No mail contents, drafts, subscriptions or sends. 404/401/429 are inconclusive, not evidence of scoping.
export async function probeMailboxAccess(
  tokenProvider: GraphTokenProvider,
  targetId: string,
  controlId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ProbeOutcome> {
  if (targetId.toLowerCase() === controlId.toLowerCase()) throw new Error('Control mailbox must differ from target');
  const token = await tokenProvider.getAccessToken();
  const target = await readInboxFolder(token, targetId, fetchImplementation);
  if (target.status !== 200 || typeof target.id !== 'string' || !target.id) throw new Error(`Target read failed (HTTP ${target.status}); connection is not verified`);
  const control = await readInboxFolder(token, controlId, fetchImplementation);
  const controlDenied = control.status === 403 && control.code === 'ErrorAccessDenied';
  if (!controlDenied) throw new Error(`Control did not return ErrorAccessDenied (HTTP ${control.status}); scoping is not verified`);
  return { targetReadable: true, controlDenied: true };
}
