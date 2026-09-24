import { timingSafeEqual } from "node:crypto";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db.js";

const reasonSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  actor: z.string().trim().min(1).max(200),
});

const resumeSchema = reasonSchema.extend({
  confirmation: z.literal("RESUME_OUTREACH"),
});

const notificationSchema = z.object({
  value: z.array(
    z.object({
      subscriptionId: z.string().min(1),
      clientState: z.string().optional(),
      changeType: z.string().optional(),
      lifecycleEvent: z.string().optional(),
      resource: z.string().min(1),
      tenantId: z.string().optional(),
      resourceData: z.object({ id: z.string().optional() }).passthrough().optional(),
    }).passthrough(),
  ),
});

export function buildHttpApp(config: AppConfig, sql: Database) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: 1_000_000,
    trustProxy: false,
  });

  void app.register(helmet, { contentSecurityPolicy: false });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const supplied = request.headers["x-admin-api-key"];
    if (typeof supplied !== "string" || !constantTimeEquals(supplied, config.ADMIN_API_KEY)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await sql`SELECT 1`;
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/v1/system/status", async () => {
    const [control, campaigns, messages, sync] = await Promise.all([
      sql`SELECT globally_paused, pause_reason, updated_at, updated_by FROM system_control WHERE singleton`,
      sql`SELECT status, count(*)::int AS count FROM campaigns GROUP BY status ORDER BY status`,
      sql`SELECT status, count(*)::int AS count FROM messages GROUP BY status ORDER BY status`,
      sql`
        SELECT
          count(*) FILTER (WHERE processed_at IS NULL)::int AS pending_notifications,
          max(received_at) AS latest_notification_at
        FROM graph_notifications
      `,
    ]);
    return {
      control: control[0] ?? null,
      campaigns,
      messages,
      graph: sync[0] ?? null,
      runtime: {
        mailProvider: config.MAIL_PROVIDER,
        liveSendEnabled: config.LIVE_SEND_ENABLED,
      },
    };
  });

  app.post("/v1/system/pause", async (request, reply) => {
    const parsed = reasonSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await sql`
      UPDATE system_control
      SET globally_paused = true,
          pause_reason = ${parsed.data.reason},
          updated_by = ${parsed.data.actor}
      WHERE singleton
    `;
    return reply.code(200).send({ globallyPaused: true });
  });

  app.post("/v1/system/resume", async (request, reply) => {
    const parsed = resumeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!config.LIVE_SEND_ENABLED) {
      return reply.code(409).send({
        error: "environment_live_send_disabled",
        message: "LIVE_SEND_ENABLED must be enabled in the runtime before resuming",
      });
    }
    await sql`
      UPDATE system_control
      SET globally_paused = false,
          pause_reason = ${parsed.data.reason},
          updated_by = ${parsed.data.actor}
      WHERE singleton
    `;
    return reply.code(200).send({ globallyPaused: false });
  });

  app.post("/webhooks/microsoft-graph", async (request, reply) => {
    const query = request.query as { validationToken?: string };
    if (query.validationToken) {
      return reply
        .header("content-type", "text/plain; charset=utf-8")
        .code(200)
        .send(query.validationToken);
    }

    const parsed = notificationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(202).send();
    const expectedState = config.GRAPH_WEBHOOK_CLIENT_STATE;
    if (!expectedState) return reply.code(202).send();

    for (const notification of parsed.data.value) {
      if (
        !notification.clientState ||
        !constantTimeEquals(notification.clientState, expectedState)
      ) {
        continue;
      }
      await sql`
        INSERT INTO graph_notifications (
          subscription_id, change_type, resource, resource_id, tenant_id, payload
        ) VALUES (
          ${notification.subscriptionId},
          ${notification.changeType ?? notification.lifecycleEvent ?? "unknown"},
          ${notification.resource},
          ${notification.resourceData?.id ?? null},
          ${notification.tenantId ?? null},
          ${sql.json(notification as postgres.JSONValue)}
        )
        ON CONFLICT (subscription_id, change_type, resource) DO NOTHING
      `;
    }
    return reply.code(202).send();
  });

  return app;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
