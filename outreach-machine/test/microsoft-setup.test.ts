import { describe, expect, it, vi } from 'vitest';
import { verifyMailboxEvidence } from '../src/mail/mailbox-identity.js';
import { probeMailboxAccess, probeTargetMailboxRead } from '../src/mail/connection-probe.js';
import { MicrosoftGraphMailProvider } from '../src/mail/microsoft-graph-provider.js';
import { loadConfig } from '../src/config.js';

const expected = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  mailboxObjectId: '00000000-0000-4000-8000-000000000002',
  senderAddress: 'outreach@example.org',
};
const now = new Date('2026-09-23T10:00:00Z');
const evidence = {
  ...expected, primarySmtpAddress: expected.senderAddress,
  userPrincipalName: 'alias@example.org',
  emailAddresses: ['SMTP:outreach@example.org', 'smtp:alias@example.org'],
  recipientTypeDetails: 'UserMailbox', checkedAt: now.toISOString(),
};

describe('Exchange identity verification', () => {
  it('uses primary SMTP rather than UPN or an alias', () => {
    expect(verifyMailboxEvidence(evidence, expected, now).primarySmtpAddress).toBe(expected.senderAddress);
    expect(() => verifyMailboxEvidence(evidence, { ...expected, senderAddress: 'alias@example.org' }, now)).toThrow('primary SMTP');
  });
  it('rejects wrong tenant/object, old evidence and missing proxy address', () => {
    expect(() => verifyMailboxEvidence({ ...evidence, mailboxObjectId: expected.tenantId }, expected, now)).toThrow('different');
    expect(() => verifyMailboxEvidence({ ...evidence, tenantId: expected.mailboxObjectId }, expected, now)).toThrow('different');
    expect(() => verifyMailboxEvidence({ ...evidence, checkedAt: '2026-01-01T00:00:00Z' }, expected, now)).toThrow('expired');
    expect(() => verifyMailboxEvidence({ ...evidence, emailAddresses: [] }, expected, now)).toThrow('absent');
  });
});

describe('read-only access boundary', () => {
  it('blocks all Graph writes before token acquisition', async () => {
    const token = vi.fn(async () => 'unused');
    const network = vi.fn<typeof fetch>();
    const provider = new MicrosoftGraphMailProvider({ mailboxObjectId: expected.mailboxObjectId,
      tokenProvider: { getAccessToken: token }, fetchImplementation: network });
    await expect(provider.createDraft({ idempotencyKey: 'id', recipientAddress: 'x@example.test', subject: 'x', bodyText: 'x' }))
      .rejects.toMatchObject({ code: 'graph_read_only' });
    await expect(provider.sendDraft('id')).rejects.toMatchObject({ code: 'live_send_disabled' });
    await expect(provider.createInboxSubscription({ notificationUrl: 'https://example.test', lifecycleNotificationUrl: 'https://example.test',
      clientState: 'state', expirationDateTime: now.toISOString() })).rejects.toMatchObject({ code: 'graph_read_only' });
    expect(token).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it('blocks sends even in send stage unless separately enabled', async () => {
    const provider = new MicrosoftGraphMailProvider({ mailboxObjectId: expected.mailboxObjectId, accessStage: 'send',
      tokenProvider: { getAccessToken: async () => 'unused' } });
    await expect(provider.sendDraft('id')).rejects.toMatchObject({ code: 'live_send_disabled' });
  });
  it('rejects contradictory runtime configuration', () => {
    const env = { DATABASE_URL: 'postgres://local', ADMIN_API_KEY: 'x'.repeat(32), MAIL_PROVIDER: 'microsoft_graph',
      GRAPH_TENANT_ID: expected.tenantId, GRAPH_CLIENT_ID: expected.tenantId,
      GRAPH_MAILBOX_OBJECT_ID: expected.mailboxObjectId, GRAPH_SENDER_ADDRESS: expected.senderAddress,
      GRAPH_MAILBOX_EVIDENCE_PATH: 'evidence.json', GRAPH_CERTIFICATE_PATH: 'public.pem', GRAPH_PRIVATE_KEY_PATH: 'private.pem' };
    expect(loadConfig(env).GRAPH_ACCESS_STAGE).toBe('read_only');
    expect(() => loadConfig({ ...env, LIVE_SEND_ENABLED: 'true' })).toThrow();
    expect(() => loadConfig({ ...env, GRAPH_CLIENT_SECRET: 'conflicting-secret' })).toThrow();
  });
});

describe('real Graph positive/negative probe', () => {
  it('marks a target-only read as incomplete isolation verification', async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'inbox' }), { status: 200 }));
    await expect(probeTargetMailboxRead({ getAccessToken: async () => 'token' }, 'target', network))
      .resolves.toEqual({ targetReadable: true, controlDenied: null, mailboxIsolationVerified: false });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('rejects target-only failures and empty folder IDs', async () => {
    for (const response of [new Response('{}', { status: 403 }), new Response('{"id":""}', { status: 200 })]) {
      const network = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(probeTargetMailboxRead({ getAccessToken: async () => 'token' }, 'target', network)).rejects.toThrow('not verified');
    }
  });
  it.each([200, 401, 404, 429, 500])('does not mistake HTTP %i for effective mailbox isolation', async status => {
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'inbox' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied' } }), { status }));
    await expect(probeMailboxAccess({ getAccessToken: async () => 'token' }, 'target', 'control', network)).rejects.toThrow('not verified');
  });
  it('uses metadata-only GETs and requires a specific 403 for the existing control mailbox', async () => {
    const network = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'inbox' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied' } }), { status: 403 }));
    await expect(probeMailboxAccess({ getAccessToken: async () => 'token' }, 'target', 'control', network))
      .resolves.toEqual({ targetReadable: true, controlDenied: true });
    for (const [url, init] of network.mock.calls) {
      expect(String(url)).toContain('/mailFolders/inbox?$select=id');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
    }
  });
});
