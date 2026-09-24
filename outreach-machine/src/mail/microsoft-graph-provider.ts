import { setTimeout as delay } from "node:timers/promises";
import type {
  DeltaMessage,
  DeltaPage,
  MailProvider,
  OutboundMessage,
  ProviderMessage,
} from "./provider.js";
import { ProviderError } from "./provider.js";
import type { GraphTokenProvider } from "./token-provider.js";

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
const GRAPH_PREFER_HEADER = 'IdType="ImmutableId", outlook.body-content-type="text"';

interface GraphRecipient {
  emailAddress?: { address?: string | null } | null;
}

interface GraphMessage {
  id: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  isDraft?: boolean;
  subject?: string | null;
  body?: { content?: string | null; contentType?: string | null } | null;
  toRecipients?: GraphRecipient[];
  sender?: GraphRecipient | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
}

interface GraphDeltaResponse {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface GraphErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

interface GraphRequestOptions {
  method: "GET" | "POST" | "PATCH";
  url: string;
  body?: unknown;
  safeToRetry: boolean;
  acceptedStatuses: number[];
}

interface GraphResponse<T> {
  data: T | null;
  requestId: string | null;
  status: number;
}

export class MicrosoftGraphMailProvider implements MailProvider {
  readonly name = "microsoft_graph" as const;
  private readonly mailboxObjectId: string;
  private readonly tokenProvider: GraphTokenProvider;
  private readonly requestTimeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly accessStage: "read_only" | "drafts" | "send";
  private readonly liveSendEnabled: boolean;

  constructor(options: {
    mailboxObjectId: string;
    tokenProvider: GraphTokenProvider;
    requestTimeoutMs?: number;
    fetchImplementation?: typeof fetch;
    accessStage?: "read_only" | "drafts" | "send";
    liveSendEnabled?: boolean;
  }) {
    this.mailboxObjectId = options.mailboxObjectId;
    this.tokenProvider = options.tokenProvider;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.accessStage = options.accessStage ?? "read_only";
    this.liveSendEnabled = options.liveSendEnabled ?? false;
  }

  async createDraft(message: OutboundMessage): Promise<ProviderMessage> {
    const response = await this.request<GraphMessage>({
      method: "POST",
      url: `${this.userBase()}/messages`,
      safeToRetry: false,
      acceptedStatuses: [201],
      body: {
        subject: message.subject,
        body: { contentType: "Text", content: message.bodyText },
        toRecipients: [
          { emailAddress: { address: message.recipientAddress } },
        ],
        internetMessageHeaders: [
          { name: "x-gordion-message-id", value: message.idempotencyKey },
        ],
      },
    });

    if (!response.data) {
      throw new ProviderError({
        code: "graph_empty_draft_response",
        message: "Microsoft Graph created a draft without returning a message",
        status: response.status,
        requestId: response.requestId,
        uncertain: true,
      });
    }
    return this.toProviderMessage(response.data);
  }

  async sendDraft(providerMessageId: string): Promise<{ requestId: string | null }> {
    if (this.accessStage !== "send" || !this.liveSendEnabled) {
      throw new ProviderError({ code: "live_send_disabled", message: "Microsoft Graph sending is disabled" });
    }
    const response = await this.request<never>({
      method: "POST",
      url: `${this.userBase()}/messages/${encodeURIComponent(providerMessageId)}/send`,
      safeToRetry: false,
      acceptedStatuses: [202],
    });
    return { requestId: response.requestId };
  }

  async getMessage(providerMessageId: string): Promise<ProviderMessage | null> {
    const select = [
      "id",
      "internetMessageId",
      "conversationId",
      "isDraft",
      "subject",
      "body",
      "toRecipients",
    ].join(",");
    const response = await this.request<GraphMessage>({
      method: "GET",
      url: `${this.userBase()}/messages/${encodeURIComponent(providerMessageId)}?$select=${select}`,
      safeToRetry: true,
      acceptedStatuses: [200, 404],
    });
    if (response.status === 404 || !response.data) return null;
    return this.toProviderMessage(response.data);
  }

  async getDeltaPage(
    folder: "inbox" | "sentitems" | "drafts",
    cursor?: string,
  ): Promise<DeltaPage> {
    const select = [
      "id",
      "internetMessageId",
      "conversationId",
      "sender",
      "subject",
      "receivedDateTime",
      "isDraft",
      "bodyPreview",
    ].join(",");
    const url = cursor ??
      `${this.userBase()}/mailFolders/${folder}/messages/delta?$select=${select}&$top=50`;
    this.assertSafeGraphCursor(url);

    const response = await this.request<GraphDeltaResponse>({
      method: "GET",
      url,
      safeToRetry: true,
      acceptedStatuses: [200],
    });
    const body = response.data ?? {};
    return {
      messages: (body.value ?? []).map((message): DeltaMessage => ({
        id: message.id,
        internetMessageId: message.internetMessageId ?? null,
        conversationId: message.conversationId ?? null,
        senderAddress: message.sender?.emailAddress?.address?.toLowerCase() ?? null,
        subject: message.subject ?? null,
        receivedDateTime: message.receivedDateTime ?? null,
        isDraft: message.isDraft ?? false,
        bodyPreview: message.bodyPreview ?? null,
      })),
      nextLink: body["@odata.nextLink"] ?? null,
      deltaLink: body["@odata.deltaLink"] ?? null,
    };
  }

  async createInboxSubscription(options: {
    notificationUrl: string;
    lifecycleNotificationUrl: string;
    clientState: string;
    expirationDateTime: string;
  }): Promise<{ id: string; expirationDateTime: string }> {
    const response = await this.request<{ id: string; expirationDateTime: string }>({
      method: "POST",
      url: `${GRAPH_BASE}/subscriptions`,
      safeToRetry: false,
      acceptedStatuses: [201],
      body: {
        changeType: "created",
        notificationUrl: options.notificationUrl,
        lifecycleNotificationUrl: options.lifecycleNotificationUrl,
        resource: `users/${this.mailboxObjectId}/mailFolders/inbox/messages`,
        expirationDateTime: options.expirationDateTime,
        clientState: options.clientState,
      },
    });
    if (!response.data) {
      throw new ProviderError({
        code: "graph_empty_subscription_response",
        message: "Microsoft Graph returned no subscription",
        status: response.status,
        requestId: response.requestId,
        uncertain: true,
      });
    }
    return response.data;
  }

  private userBase(): string {
    return `${GRAPH_BASE}/users/${encodeURIComponent(this.mailboxObjectId)}`;
  }

  private toProviderMessage(message: GraphMessage): ProviderMessage {
    return {
      id: message.id,
      internetMessageId: message.internetMessageId ?? null,
      conversationId: message.conversationId ?? null,
      isDraft: message.isDraft ?? false,
      subject: message.subject ?? "",
      bodyText: message.body?.content ?? "",
      recipientAddresses: (message.toRecipients ?? [])
        .map((recipient) => recipient.emailAddress?.address?.toLowerCase())
        .filter((address): address is string => Boolean(address)),
    };
  }

  private assertSafeGraphCursor(value: string): void {
    const url = new URL(value, GRAPH_BASE);
    const mailboxSegment = encodeURIComponent(this.mailboxObjectId).toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.hostname !== "graph.microsoft.com" ||
      !url.pathname.toLowerCase().startsWith(`/v1.0/users/${mailboxSegment}/mailfolders/`)
    ) {
      throw new ProviderError({
        code: "unsafe_graph_cursor",
        message: "Rejected a delta cursor outside the configured Microsoft Graph mailbox",
      });
    }
  }

  private async request<T>(options: GraphRequestOptions): Promise<GraphResponse<T>> {
    if (this.accessStage === "read_only" && options.method !== "GET") {
      throw new ProviderError({ code: "graph_read_only", message: "Graph writes are disabled during connection setup" });
    }
    const maxAttempts = options.safeToRetry ? 3 : 1;
    let lastError: ProviderError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const token = await this.tokenProvider.getAccessToken();
        const requestInit: RequestInit = {
          method: options.method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            Prefer: GRAPH_PREFER_HEADER,
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        };
        if (options.body !== undefined) requestInit.body = JSON.stringify(options.body);
        const response = await this.fetchImplementation(options.url, requestInit);

        const requestId = response.headers.get("request-id") ??
          response.headers.get("client-request-id");
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
        const text = await response.text();
        const data = text ? safeJsonParse<T | GraphErrorBody>(text) : null;

        if (options.acceptedStatuses.includes(response.status)) {
          return { data: data as T | null, requestId, status: response.status };
        }

        const graphError = data as GraphErrorBody | null;
        const error = new ProviderError({
          code: graphError?.error?.code ?? `graph_http_${response.status}`,
          message: graphError?.error?.message ?? `Microsoft Graph returned HTTP ${response.status}`,
          status: response.status,
          requestId,
          retryAfterSeconds,
          uncertain: !options.safeToRetry && response.status >= 500,
        });

        const retryable = options.safeToRetry && (response.status === 429 || response.status >= 500);
        if (!retryable || attempt === maxAttempts) throw error;
        lastError = error;
        await delay(retryDelayMs(attempt, retryAfterSeconds));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        const wrapped = new ProviderError({
          code: "graph_network_error",
          message: `Microsoft Graph request did not complete: ${error instanceof Error ? error.message : "unknown error"}`,
          uncertain: !options.safeToRetry,
          cause: error,
        });
        if (!options.safeToRetry || attempt === maxAttempts) throw wrapped;
        lastError = wrapped;
        await delay(retryDelayMs(attempt, null));
      }
    }

    throw lastError ?? new ProviderError({
      code: "graph_request_failed",
      message: "Microsoft Graph request failed",
    });
  }
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function retryDelayMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  return Math.min(8_000, 250 * 2 ** (attempt - 1));
}
