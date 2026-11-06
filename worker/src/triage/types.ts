// Triage types (Spec C 9a). Offline: nothing here calls a model or the network.
import type { ProjectRecord } from "./registry";

export type TrustLabel = "trusted" | "untrusted";

/**
 * Minimal local shape of the normalized Input record (Spec C 9). WP-C builds the real record in
 * worker/src/intake/; this type is structurally compatible with its fields and deliberately does not
 * import it. `trust` is the 9a trust label derived from the source, not from the body.
 */
export interface TriageInput {
  id: string;
  source: string;
  /** Which pre-processor produced the text, e.g. "email" or "crash_report". Does not change the flow. */
  inputType: string;
  trust: TrustLabel;
  author?: string;
  receivedAt?: string;
  subject?: string;
  body: string;
  /**
   * Optional bounded text used only to search memory (never given to a model as instructions). Intake supplies its
   * neutralised summary, so the sanctioned data block's header lines do not dilute the match.
   */
  searchText?: string;
}

export const LABELS = ["bug", "crash", "feature", "question", "feedback", "noise", "security"] as const;
export type Label = (typeof LABELS)[number];

export interface Classification {
  label: Label;
  /** Registered project id, or null when none fits. */
  project: string | null;
  repos: string[];
  /** 0..1 */
  confidence: number;
  rationale: string;
  /** Other plausible projects with their own confidence, for the ambiguity check. */
  alternatives?: { project: string; confidence: number }[];
}

/** Injected classifier. A model-backed one would be read-only and treat `input` as quoted data. */
export interface Classifier {
  classify(input: TriageInput, ctx: { projects: ProjectRecord[] }): Promise<Classification>;
}
