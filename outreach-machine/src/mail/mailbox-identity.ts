import { readFileSync } from "node:fs";
import { z } from "zod";

// Exported by inspect-mailbox.ps1 from the authenticated Exchange tenant.
// This operator-supplied evidence is a configuration check, not a signed identity token.
const evidenceSchema = z.object({
  tenantId: z.uuid(),
  mailboxObjectId: z.uuid(),
  primarySmtpAddress: z.email(),
  userPrincipalName: z.string(),
  emailAddresses: z.array(z.string()),
  recipientTypeDetails: z.literal("UserMailbox"),
  checkedAt: z.iso.datetime(),
});

export function verifyMailboxEvidence(
  evidence: unknown,
  expected: { tenantId: string; mailboxObjectId: string; senderAddress: string },
  now = new Date(),
) {
  const parsed = evidenceSchema.parse(evidence);
  if (parsed.tenantId.toLowerCase() !== expected.tenantId.toLowerCase() ||
      parsed.mailboxObjectId.toLowerCase() !== expected.mailboxObjectId.toLowerCase()) {
    throw new Error("Mailbox evidence belongs to a different tenant or user");
  }
  const age = now.getTime() - Date.parse(parsed.checkedAt);
  if (age < -300_000 || age > 30 * 86_400_000) {
    throw new Error("Mailbox evidence is expired or has a future timestamp; repeat Exchange inspection");
  }
  const sender = expected.senderAddress.toLowerCase();
  if (parsed.primarySmtpAddress.toLowerCase() !== sender) {
    throw new Error("Configured sender is not the Exchange primary SMTP address; alias sending is not configured");
  }
  if (!parsed.emailAddresses.some(address => address.toLowerCase() === `smtp:${sender}`)) {
    throw new Error("Primary SMTP address is absent from Exchange proxy addresses");
  }
  return parsed;
}

export function readMailboxEvidence(path: string, expected: Parameters<typeof verifyMailboxEvidence>[1]) {
  return verifyMailboxEvidence(JSON.parse(readFileSync(path, "utf8")), expected);
}
