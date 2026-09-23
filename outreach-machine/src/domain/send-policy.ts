import { DateTime } from "luxon";
import type { FinalMessageContent } from "./message.js";
import { contentHash, validateFinalContent } from "./message.js";

export interface SendPolicyInput {
  now: Date;
  globallyPaused: boolean;
  campaignStatus: "draft" | "paused" | "active" | "completed" | "archived";
  campaignLiveSendEnabled: boolean;
  environmentLiveSendEnabled: boolean;
  enrollmentStatus: string;
  companyReviewStatus: string;
  contactReviewStatus: string;
  hasActiveSuppression: boolean;
  timezone: string;
  businessWeekdays: number[];
  sendWindowStart: string;
  sendWindowEnd: string;
  dailyInitialLimit: number;
  dailyTotalLimit: number;
  usedInitialSlots: number;
  usedTotalSlots: number;
  messageKind: "initial" | "followup";
  finalContent: FinalMessageContent;
  approvedContentSha256: string | null;
}

export interface SendPolicyDecision {
  allowed: boolean;
  reasons: string[];
  businessDate: string | null;
}

function minutesSinceMidnight(value: string): number {
  const [hour = Number.NaN, minute = Number.NaN] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function evaluateSendPolicy(input: SendPolicyInput): SendPolicyDecision {
  const reasons: string[] = [];
  const localNow = DateTime.fromJSDate(input.now, { zone: input.timezone });

  if (!localNow.isValid) reasons.push("invalid campaign timezone");
  if (input.globallyPaused) reasons.push("system is globally paused");
  if (input.campaignStatus !== "active") reasons.push("campaign is not active");
  if (!input.campaignLiveSendEnabled) reasons.push("campaign live send is disabled");
  if (!input.environmentLiveSendEnabled) reasons.push("environment live send is disabled");
  if (input.enrollmentStatus !== "active") reasons.push("enrollment is not active");
  if (input.companyReviewStatus !== "eligible") reasons.push("company is not eligible");
  if (input.contactReviewStatus !== "eligible") reasons.push("contact is not eligible");
  if (input.hasActiveSuppression) reasons.push("an active suppression applies");

  for (const error of validateFinalContent(input.finalContent)) reasons.push(error);

  const currentHash = contentHash(input.finalContent);
  if (!input.approvedContentSha256 || currentHash !== input.approvedContentSha256) {
    reasons.push("approved content hash does not match final content");
  }

  if (localNow.isValid) {
    if (!input.businessWeekdays.includes(localNow.weekday)) {
      reasons.push("outside configured business weekdays");
    }

    const currentMinutes = localNow.hour * 60 + localNow.minute;
    const startMinutes = minutesSinceMidnight(input.sendWindowStart);
    const endMinutes = minutesSinceMidnight(input.sendWindowEnd);
    if (currentMinutes < startMinutes || currentMinutes >= endMinutes) {
      reasons.push("outside configured send window");
    }
  }

  if (input.usedTotalSlots >= input.dailyTotalLimit) {
    reasons.push("daily total limit reached");
  }
  if (
    input.messageKind === "initial" &&
    input.usedInitialSlots >= input.dailyInitialLimit
  ) {
    reasons.push("daily initial-contact limit reached");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    businessDate: localNow.isValid ? localNow.toISODate() : null,
  };
}
