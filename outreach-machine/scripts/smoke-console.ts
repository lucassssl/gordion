import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { buildHttpApp } from "../src/http/app.js";
import { prepareAutomaticCampaigns } from "../src/services/preparation.js";
import { MessageRepository } from "../src/repositories/message-repository.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required");
const target = new URL(databaseUrl);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
  !target.pathname.endsWith("_test")
) {
  throw new Error("Requires a disposable local database ending in _test");
}
const adminKey = randomUUID().repeat(2),
  researchKey = randomUUID().repeat(2);
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  ADMIN_API_KEY: adminKey,
  RESEARCH_IMPORT_API_KEY: researchKey,
  LOCAL_DASHBOARD_ENABLED: "true",
  LOG_LEVEL: "silent",
});
const sql = createDatabase(config),
  app = buildHttpApp(config, sql);
const admin = { "x-admin-api-key": adminKey },
  research = { "x-research-api-key": researchKey };
const batchId = randomUUID(),
  domain = `broker-${batchId}.example`;
const payload = {
  externalId: batchId,
  source: "research",
  contacts: [
    {
      companyName: "Synthetic Broker",
      domain,
      countryCode: "DE",
      fitTier: "A",
      email: `compliance@${domain}`,
      firstName: "Test",
      roleTitle: "Compliance",
      sourceUrl: `https://${domain}/team`,
      sourceCheckedAt: new Date().toISOString(),
      executionEvidence: "Synthetic only; never a real researched prospect.",
      executionEvidenceUrl: `https://${domain}/services`,
    },
  ],
};
try {
  const noAuth = await app.inject({ url: "/v1/console" });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/local/session",
        headers: { host: "127.0.0.1:4310", origin: "https://evil.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/local/session",
        headers: { host: "evil.example", origin: "http://evil.example" },
      })
    ).statusCode,
    403,
  );
  const session = await app.inject({
    method: "POST",
    url: "/local/session",
    headers: { host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" },
  });
  assert.equal(session.statusCode, 200);
  const cookie = String(session.headers["set-cookie"]).split(";")[0]!;
  assert.equal(
    (
      await app.inject({
        url: "/v1/console",
        headers: { host: "127.0.0.1:4310", cookie },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/system/pause",
        headers: { host: "127.0.0.1:4310", cookie },
        payload: { reason: "CSRF", actor: "test" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: "/v1/console", headers: research })).statusCode,
    403,
  );
  const imported = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload,
  });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().importedCount, 1);
  const repeated = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload,
  });
  assert.equal(repeated.json().replayed, true);
  const changed = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload: {
      ...payload,
      contacts: [{ ...payload.contacts[0], firstName: "Changed" }],
    },
  });
  assert.equal(changed.statusCode, 409);
  const duplicate = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload: { ...payload, externalId: randomUUID() },
  });
  assert.equal(duplicate.json().duplicateCount, 1);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/imports",
        headers: research,
        payload: {
          ...payload,
          externalId: randomUUID(),
          contacts: [{ ...payload.contacts[0], reviewStatus: "eligible" }],
        },
      })
    ).statusCode,
    400,
  );
  const [contact] =
    await sql`SELECT * FROM contacts WHERE email = ${payload.contacts[0]!.email}`;
  assert.equal(contact!.reviewStatus, "needs_review");
  assert.equal(contact!.outreachBasis, null);
  const campaign = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: admin,
    payload: {
      name: `Synthetic ${batchId}`,
      subject: "Hello {{company}}",
      body: "Hello {{firstName}}, this is a synthetic preview only.",
      signature: "Synthetic test signature only",
      legalReference: "Own synthetic test addresses only",
      countries: ["DE"],
      initialLimit: 5,
      totalLimit: 5,
      confirmation: "APPROVE_TEMPLATE_ONLY",
    },
  });
  assert.equal(campaign.statusCode, 200, campaign.body);
  const campaignId = campaign.json().id;
  const prepare = () =>
    app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/prepare`,
      headers: admin,
      payload: {},
    });
  assert.equal((await prepare()).json().prepared, 0);
  const review = await app.inject({
    method: "POST",
    url: `/v1/contacts/${contact!.id}/authorize`,
    headers: admin,
    payload: {
      basis: "own_test_address",
      evidence: "Synthetic simulator fixture, not a real recipient",
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      confirmation: "VERIFY_OUTREACH_BASIS",
    },
  });
  assert.equal(review.statusCode, 200, review.body);
  const prepared = await prepare();
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json().prepared, 1);
  assert.equal((await prepare()).json().prepared, 0);
  const [message] =
    await sql`SELECT m.* FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.campaign_id = ${campaignId}`;
  assert.equal(message!.status, "awaiting_approval");
  const approve = await app.inject({
    method: "POST",
    url: `/v1/messages/${message!.id}/approve`,
    headers: admin,
    payload: { contentSha256: message!.contentSha256 },
  });
  assert.equal(approve.statusCode, 200, approve.body);
  // Stale/replaced preview must not approve a different content snapshot.
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/messages/${message!.id}/approve`,
        headers: admin,
        payload: { contentSha256: "a".repeat(64) },
      })
    ).statusCode,
    409,
  );
  const autoDomain = `auto-${batchId}.example`;
  const autoPayload = {
    ...payload,
    externalId: randomUUID(),
    contacts: [
      {
        ...payload.contacts[0],
        domain: autoDomain,
        email: `person@${autoDomain}`,
      },
    ],
  };
  await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload: autoPayload,
  });
  const [autoContact] =
    await sql`SELECT id FROM contacts WHERE email = ${autoPayload.contacts[0]!.email}`;
  await app.inject({
    method: "POST",
    url: `/v1/campaigns/${campaignId}/automation`,
    headers: admin,
    payload: { enabled: true, confirmation: "PREPARATION_ONLY_NO_SEND" },
  });
  await prepareAutomaticCampaigns(sql);
  const [before] =
    await sql`SELECT count(*)::int AS count FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.campaign_id = ${campaignId}`;
  assert.equal(
    before!.count,
    1,
    "Unreviewed automatic import must not create a message",
  );
  await app.inject({
    method: "POST",
    url: `/v1/contacts/${autoContact!.id}/authorize`,
    headers: admin,
    payload: {
      basis: "own_test_address",
      evidence: "Synthetic automatically prepared fixture only",
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      confirmation: "VERIFY_OUTREACH_BASIS",
    },
  });
  await prepareAutomaticCampaigns(sql);
  await prepareAutomaticCampaigns(sql);
  const automaticMessages =
    await sql`SELECT m.* FROM messages m JOIN enrollments e ON e.id = m.enrollment_id WHERE e.contact_id = ${autoContact!.id}`;
  assert.equal(automaticMessages.length, 1);
  assert.equal(automaticMessages[0]!.status, "approved");
  assert.equal(automaticMessages[0]!.approvedBy, "campaign-policy");
  const [inactive] =
    await sql`SELECT status, live_send_enabled FROM campaigns WHERE id = ${campaignId}`;
  assert.equal(inactive!.status, "draft");
  assert.equal(inactive!.liveSendEnabled, false);
  await sql`UPDATE messages SET status = 'leased', lease_owner = 'crashed', lease_expires_at = now() - interval '3 minutes' WHERE id = ${message!.id}`;
  await new MessageRepository(sql).leaseNextDraftCreation("recovery-test");
  const [recovered] =
    await sql`SELECT status FROM messages WHERE id = ${message!.id}`;
  assert.equal(recovered!.status, "reconciliation_required");
  const [control] = await sql`SELECT globally_paused FROM system_control`;
  assert.equal(control!.globallyPaused, true);
  const suppression = await app.inject({
    method: "POST",
    url: `/v1/contacts/${contact!.id}/suppress`,
    headers: admin,
    payload: { reason: "Synthetic unsubscribe test" },
  });
  assert.equal(suppression.statusCode, 200);
  const blocked = await app.inject({
    method: "POST",
    url: "/v1/imports",
    headers: research,
    payload: { ...payload, externalId: randomUUID() },
  });
  assert.equal(blocked.json().blockedCount, 1);
  await prepareAutomaticCampaigns(sql);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/system/resume",
        headers: admin,
        payload: {
          reason: "Attempted activation",
          actor: "test",
          confirmation: "RESUME_OUTREACH",
        },
      })
    ).statusCode,
    409,
  );
  const page = await app.inject({
    url: "/",
    headers: { host: "127.0.0.1:4310" },
  });
  assert.equal(page.statusCode, 200);
  assert.match(
    String(page.headers["content-security-policy"]),
    /frame-ancestors 'none'/,
  );
  console.log(
    "Console smoke passed: local auth/CSRF, import scopes, dedupe, review, preview, automatic preparation, expired-lease quarantine, suppression and send lock.",
  );
} finally {
  await app.close();
  await sql.end();
}
