import { describe, expect, it } from "vitest";
import { contentHash } from "../src/domain/message.js";
import { evaluateSendPolicy, type SendPolicyInput } from "../src/domain/send-policy.js";

function validInput(): SendPolicyInput {
  const finalContent = {
    recipientAddress: "alice@example.com",
    subject: "Best Execution controls at Example",
    bodyText: "Dear Alice,\n\nA fully reviewed message.",
  };
  return {
    now: new Date("2026-09-22T08:00:00.000Z"),
    globallyPaused: false,
    campaignStatus: "active",
    campaignLiveSendEnabled: true,
    environmentLiveSendEnabled: true,
    enrollmentStatus: "active",
    companyReviewStatus: "eligible",
    contactReviewStatus: "eligible",
    hasActiveSuppression: false,
    timezone: "Europe/Berlin",
    businessWeekdays: [1, 2, 3, 4, 5],
    sendWindowStart: "09:00",
    sendWindowEnd: "16:30",
    dailyInitialLimit: 10,
    dailyTotalLimit: 15,
    usedInitialSlots: 0,
    usedTotalSlots: 0,
    messageKind: "initial",
    finalContent,
    approvedContentSha256: contentHash(finalContent),
  };
}

describe("evaluateSendPolicy", () => {
  it("allows a fully approved message in the configured window", () => {
    expect(evaluateSendPolicy(validInput())).toEqual({
      allowed: true,
      reasons: [],
      businessDate: "2026-09-22",
    });
  });

  it("rejects unresolved placeholders and changed approved content", () => {
    const input = validInput();
    input.finalContent.bodyText = "Dear [First name],\n\nA changed message.";
    const decision = evaluateSendPolicy(input);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("unresolved placeholder: [First name]");
    expect(decision.reasons).toContain(
      "approved content hash does not match final content",
    );
  });

  it("rejects paused, suppressed, out-of-window, and exhausted sends", () => {
    const input = validInput();
    input.now = new Date("2026-09-20T21:00:00.000Z");
    input.globallyPaused = true;
    input.hasActiveSuppression = true;
    input.usedInitialSlots = 10;
    input.usedTotalSlots = 15;
    const decision = evaluateSendPolicy(input);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "system is globally paused",
        "an active suppression applies",
        "outside configured business weekdays",
        "outside configured send window",
        "daily total limit reached",
        "daily initial-contact limit reached",
      ]),
    );
  });
});

describe("contentHash", () => {
  it("normalizes address case and line endings", () => {
    const first = contentHash({
      recipientAddress: "ALICE@example.com",
      subject: " Subject ",
      bodyText: "Hello\r\nWorld\r\n",
    });
    const second = contentHash({
      recipientAddress: "alice@example.com",
      subject: "Subject",
      bodyText: "Hello\nWorld",
    });
    expect(first).toBe(second);
  });
});
