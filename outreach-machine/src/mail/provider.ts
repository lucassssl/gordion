export interface OutboundMessage {
  idempotencyKey: string;
  recipientAddress: string;
  subject: string;
  bodyText: string;
}

export interface ProviderMessage {
  id: string;
  internetMessageId: string | null;
  conversationId: string | null;
  isDraft: boolean;
  subject: string;
  bodyText: string;
  recipientAddresses: string[];
}

export interface DeltaMessage {
  id: string;
  internetMessageId: string | null;
  conversationId: string | null;
  senderAddress: string | null;
  subject: string | null;
  receivedDateTime: string | null;
  isDraft: boolean;
  bodyPreview: string | null;
}

export interface DeltaPage {
  messages: DeltaMessage[];
  nextLink: string | null;
  deltaLink: string | null;
}

export interface MailProvider {
  readonly name: "simulated" | "microsoft_graph";
  createDraft(message: OutboundMessage): Promise<ProviderMessage>;
  sendDraft(providerMessageId: string): Promise<{ requestId: string | null }>;
  getMessage(providerMessageId: string): Promise<ProviderMessage | null>;
  getDeltaPage(folder: "inbox" | "sentitems" | "drafts", cursor?: string): Promise<DeltaPage>;
}

export class ProviderError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly uncertain: boolean;

  constructor(options: {
    message: string;
    status?: number | null;
    code: string;
    requestId?: string | null;
    retryAfterSeconds?: number | null;
    uncertain?: boolean;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ProviderError";
    this.status = options.status ?? null;
    this.code = options.code;
    this.requestId = options.requestId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.uncertain = options.uncertain ?? false;
  }
}
