import { describe, expect, it } from "vitest";
import type { DeltaMessage } from "../src/mail/provider.js";
import { inboundClassificationForTest } from "../src/services/inbox-sync.js";

function message(overrides: Partial<DeltaMessage> = {}): DeltaMessage {
  return {
    id: "id",
    internetMessageId: null,
    conversationId: "conversation",
    senderAddress: "alice@example.com",
    subject: "Re: Hello",
    receivedDateTime: "2026-09-23T10:00:00Z",
    isDraft: false,
    bodyPreview: "Thanks for reaching out.",
    ...overrides,
  };
}

describe("inbound classification", () => {
  it("never takes automated action for an unmatched message", () => {
    expect(inboundClassificationForTest(message(), false)).toBe("needs_review");
  });

  it("recognizes replies, explicit opt-outs, absence, and delivery failures", () => {
    expect(inboundClassificationForTest(message(), true)).toBe("reply");
    expect(
      inboundClassificationForTest(
        message({ bodyPreview: "Please unsubscribe me from your list." }),
        true,
      ),
    ).toBe("unsubscribe");
    expect(
      inboundClassificationForTest(
        message({ subject: "Automatic reply: Re: Hello" }),
        true,
      ),
    ).toBe("out_of_office");
    expect(
      inboundClassificationForTest(
        message({ senderAddress: "postmaster@example.com", subject: "Undeliverable" }),
        true,
      ),
    ).toBe("bounce");
  });
});
