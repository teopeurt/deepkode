import { expect, test } from "bun:test";
import { EmailAdapter, intakeToTriageInput } from "./index";
import { plain } from "./testkit";

const parse = (body: string, messageId: string) =>
  intakeToTriageInput(new EmailAdapter().parse(plain(body, { messageId }), { receivedAt: "2026-11-06T00:00:00Z" }));

test("email externalId comes from the content hash, so a re-send with a new Message-ID gets the same workflow id", () => {
  const a = parse("The checkout total is wrong after applying a coupon.", "<a@example.org>");
  const b = parse("The checkout total is wrong after applying a coupon.", "<b-forged@evil.test>");
  expect(a.workflowId).toBe(b.workflowId);
  expect(a.externalId).toBe(a.contentHash);
  expect(a.messageId).toBe("a@example.org");
  expect(b.messageId).toBe("b-forged@evil.test");
});

test("different content gets a different workflow id even with the same Message-ID", () => {
  const a = parse("The checkout total is wrong.", "<same@example.org>");
  const b = parse("The login page crashes on submit.", "<same@example.org>");
  expect(a.workflowId).not.toBe(b.workflowId);
});
