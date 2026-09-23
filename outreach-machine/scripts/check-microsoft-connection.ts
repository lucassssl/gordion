import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { readMailboxEvidence } from '../src/mail/mailbox-identity.js';
import { AppOnlyMsalTokenProvider } from '../src/mail/token-provider.js';
import { probeMailboxAccess, probeTargetMailboxRead } from '../src/mail/connection-probe.js';

const configPath = new URL('../config/microsoft-365.json', import.meta.url);
const configured = existsSync(configPath);
const config = JSON.parse(readFileSync(configured ? configPath : new URL('../config/microsoft-365.example.json', import.meta.url), 'utf8')) as {
  tenantId: string; mailboxObjectId: string; senderCandidates: string[];
};
// Do not load server config: this check needs no DB, API key, webhook, or worker.
const targetOnly = process.argv.includes('--target-only');
const environmentSchema = z.object({
  GRAPH_CLIENT_ID: z.uuid(),
  GRAPH_CERTIFICATE_PATH: z.string().min(1),
  GRAPH_PRIVATE_KEY_PATH: z.string().min(1),
  GRAPH_MAILBOX_EVIDENCE_PATH: z.string().min(1),
  GRAPH_SENDER_ADDRESS: z.email(),
  GRAPH_CONTROL_MAILBOX_OBJECT_ID: targetOnly ? z.uuid().optional() : z.uuid(),
});
const parsed = environmentSchema.safeParse(process.env);
const missing = parsed.success ? [] : parsed.error.issues.map(issue => issue.path.join('.'));
const report = { mode: 'read_only', configured, tenantId: config.tenantId, mailboxObjectId: config.mailboxObjectId,
  senderCandidates: config.senderCandidates, missingOrInvalid: missing, connected: false };

async function main() {
  if (!process.argv.includes('--connect')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\nOffline check only. Use --connect after configuring the listed fields.\n`);
    return;
  }
  if (!configured) throw new Error('Create and verify local config/microsoft-365.json first');
  if (process.env.LIVE_SEND_ENABLED === 'true' || (process.env.GRAPH_ACCESS_STAGE && process.env.GRAPH_ACCESS_STAGE !== 'read_only')) {
    throw new Error('Setup requires LIVE_SEND_ENABLED=false and GRAPH_ACCESS_STAGE=read_only');
  }
  if (!parsed.success) throw new Error(`Missing or invalid setup fields: ${missing.join(', ')}`);
  const env = parsed.data;
  if ((process.env.GRAPH_TENANT_ID && process.env.GRAPH_TENANT_ID !== config.tenantId) ||
      (process.env.GRAPH_MAILBOX_OBJECT_ID && process.env.GRAPH_MAILBOX_OBJECT_ID !== config.mailboxObjectId)) {
    throw new Error('Environment differs from the configured Gordion tenant/mailbox');
  }
  const evidence = readMailboxEvidence(env.GRAPH_MAILBOX_EVIDENCE_PATH, {
    tenantId: config.tenantId, mailboxObjectId: config.mailboxObjectId, senderAddress: env.GRAPH_SENDER_ADDRESS,
  });
  if (!config.senderCandidates.includes(evidence.primarySmtpAddress.toLowerCase())) throw new Error('Unexpected primary sender address');
  const provider = new AppOnlyMsalTokenProvider({ tenantId: config.tenantId, clientId: env.GRAPH_CLIENT_ID,
    certificatePath: env.GRAPH_CERTIFICATE_PATH, privateKeyPath: env.GRAPH_PRIVATE_KEY_PATH });
  const result = targetOnly
    ? await probeTargetMailboxRead(provider, config.mailboxObjectId)
    : { ...await probeMailboxAccess(provider, config.mailboxObjectId, env.GRAPH_CONTROL_MAILBOX_OBJECT_ID!), mailboxIsolationVerified: true };
  process.stdout.write(`${JSON.stringify({ ...report, ...result, connected: true, verifiedPrimarySmtpAddress: evidence.primarySmtpAddress,
    note: targetOnly
      ? 'Target read only. Negative control test pending; mailbox isolation NOT verified by this probe. No writes or sends.'
      : 'Read access and negative control verified. No send/write rights tested or enabled; identity comes from the Exchange export.' }, null, 2)}\n`);
}

main().catch(() => {
  // Avoid raw MSAL/network diagnostics, which can contain credentials or response payloads.
  process.stderr.write('Connection check failed. Check required fields, Exchange evidence, certificate, admin grants and RBAC propagation. No send was attempted.\n');
  process.exitCode = 1;
});
