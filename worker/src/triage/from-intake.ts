// Adapter from intake's TriageInput (WP-C) to triage's local TriageInput (WP-D). Spec C 9a trust labels:
// intake says `internal` or `untrusted`; the triage decision treats only the exact value "trusted" as trusted.
import type { TriageInput as IntakeTriageInput } from "../intake/delivery";
import type { TriageInput } from "./types";

/**
 * `internal` becomes `trusted`; anything else is `untrusted` (fail closed). The text handed to the classifier is
 * the intake `dataBlock`, the only sanctioned embedding of untrusted text, never the raw body.
 */
export function fromIntake(i: IntakeTriageInput): TriageInput {
  return {
    id: i.inputId,
    source: i.source,
    inputType: i.source,
    trust: i.trust === "internal" ? "trusted" : "untrusted",
    author: i.author.address,
    receivedAt: i.receivedAt,
    body: i.dataBlock,
    searchText: i.summary,
  };
}
