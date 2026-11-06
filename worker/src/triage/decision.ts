// The triage decision function (Spec C 9a). Fails closed: anything unexpected is `needs_human`.
import { findInjection } from "../memory/text";
import type { Hit, Memory } from "../memory/types";
import type { ProjectRegistry } from "./registry";
import { LABELS, type Classification, type Classifier, type TriageInput } from "./types";

/** Below this the classification is not trusted to route or to drop. Starting value; tune on real data. */
export const CONFIDENCE_THRESHOLD = 0.6;
/** Another project this close to (or above) the winner makes the input ambiguous. */
export const AMBIGUITY_MARGIN = 0.2;
/** Minimum memory score for a hit to count as a duplicate or known answer (hybrid score, 0..1). */
export const MEMORY_MATCH_MIN_SCORE = 0.5;
/** Convention: a note whose source.kind is this records an open or earlier task; source.ref is the task id. */
export const SOURCE_OPEN_TASK = "open-task";
/** Convention: a note whose source.kind is this carries a human-approved answer in summary/content. */
export const SOURCE_KNOWN_ANSWER = "known-answer";
const MEMORY_QUERY_CHARS = 2000;

export type NeedsHumanCode =
  | "classifier_error" | "invalid_classification" | "injection_suspected" | "empty_input"
  | "untrusted_security" | "low_confidence" | "no_project" | "unknown_project" | "ambiguous_project"
  | "repo_unclear" | "memory_error" | "unverified_memory_match" | "internal_error";

export type TriageOutcome =
  | { kind: "route"; project: string; repos: string[]; /** D4: untrusted origin needs a human before `execute`. */ humanGateBeforeExecute: boolean }
  | { kind: "duplicate"; of: string; noteId: string }
  | { kind: "known_answer"; noteId: string; answer: string }
  | { kind: "drop_noise" }
  | { kind: "needs_human"; code: NeedsHumanCode; reason: string };

export type TriageDecision = TriageOutcome & { classification?: Classification; memorySnapshotId?: string };

export interface TriageDeps {
  classifier: Classifier;
  registry: ProjectRegistry;
  /** Optional. When present it is consulted after classification; a failure here is `needs_human`. */
  memory?: Memory;
  threshold?: number;
}

const human = (code: NeedsHumanCode, reason: string): TriageDecision & { kind: "needs_human" } => ({ kind: "needs_human", code, reason });

function validate(c: unknown): c is Classification {
  if (typeof c !== "object" || c === null) return false;
  const x = c as Record<string, unknown>;
  return (LABELS as readonly string[]).includes(x.label as string) &&
    (x.project === null || typeof x.project === "string") &&
    Array.isArray(x.repos) && x.repos.every((r) => typeof r === "string") &&
    typeof x.confidence === "number" && Number.isFinite(x.confidence) && x.confidence >= 0 && x.confidence <= 1 &&
    typeof x.rationale === "string";
}

/** Consumes an input and returns a route. Never throws; never routes silently on doubt. */
export async function triage(input: TriageInput, deps: TriageDeps): Promise<TriageDecision> {
  try {
    return await decide(input, deps);
  } catch (e) {
    return human("internal_error", `triage failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function decide(input: TriageInput, deps: TriageDeps): Promise<TriageDecision> {
  const threshold = deps.threshold ?? CONFIDENCE_THRESHOLD;
  const text = `${input.subject ?? ""}\n${input.body}`;

  if (text.trim().length === 0) return human("empty_input", "input has no text");

  // Screen before the classifier sees it: injected instructions are a reason for a person to look.
  const inj = findInjection(text);
  if (inj) return human("injection_suspected", `input matches an instruction-injection pattern (${inj}); not classified automatically`);

  let c: Classification;
  try {
    const raw: unknown = await deps.classifier.classify(input, { projects: deps.registry.list() });
    if (!validate(raw)) return human("invalid_classification", "classifier returned a malformed result");
    c = raw;
  } catch (e) {
    return human("classifier_error", `classifier failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const withC = <T extends TriageDecision>(d: T): T => ({ ...d, classification: c });

  // Fail closed on trust: only the exact value "trusted" counts.
  if (c.label === "security" && input.trust !== "trusted") {
    return withC(human("untrusted_security", "security-labelled item from an untrusted origin goes to a person"));
  }
  if (c.confidence < threshold) {
    return withC(human("low_confidence", `confidence ${c.confidence.toFixed(2)} is below ${threshold}: ${c.rationale}`));
  }
  if (c.label === "noise") return withC({ kind: "drop_noise" });

  if (c.project === null) return withC(human("no_project", "no registered project matches (possibly out of scope)"));
  const project = deps.registry.get(c.project);
  if (!project) return withC(human("unknown_project", `classifier named unregistered project ${JSON.stringify(c.project)}`));

  const rival = (c.alternatives ?? []).find((a) => a.project !== c.project && a.confidence >= c.confidence - AMBIGUITY_MARGIN);
  if (rival) return withC(human("ambiguous_project", `projects ${c.project} and ${rival.project} both plausible`));

  // Memory first: a known duplicate or answer needs no repo set. Only gate-eligible notes can decide.
  let snapshotId: string | undefined;
  if (deps.memory) {
    const m = await memoryDecision(deps.memory, project.id, text);
    snapshotId = m.snapshotId;
    if (m.decision) return withC({ ...m.decision, memorySnapshotId: snapshotId });
  }

  const known = new Set(project.repos.map((r) => r.name));
  const repos = [...new Set(c.repos)];
  if (repos.length === 0 || repos.some((r) => !known.has(r))) {
    return withC(human("repo_unclear", `repo set [${c.repos.join(", ")}] is empty or not part of project ${project.id}`));
  }

  return withC({ kind: "route", project: project.id, repos, humanGateBeforeExecute: input.trust !== "trusted", ...(snapshotId ? { memorySnapshotId: snapshotId } : {}) });
}

async function memoryDecision(memory: Memory, projectId: string, text: string): Promise<{ decision?: TriageOutcome; snapshotId?: string }> {
  let hits: Hit[];
  let snapshotId: string;
  try {
    const r = await memory.retrieve(projectId, text.slice(0, MEMORY_QUERY_CHARS), { stage: "triage", limit: 5 });
    hits = r.hits; snapshotId = r.snapshotId;
  } catch (e) {
    return { decision: human("memory_error", `memory retrieval failed: ${e instanceof Error ? e.message : String(e)}`) };
  }
  const notes = new Map(memory.list(projectId).map((n) => [n.id, n]));
  for (const h of hits) { // best score first
    if (h.score < MEMORY_MATCH_MIN_SCORE) break;
    const n = notes.get(h.noteId);
    if (!n || (n.source.kind !== SOURCE_OPEN_TASK && n.source.kind !== SOURCE_KNOWN_ANSWER)) continue;
    // Only gate-eligible notes (human-approved, trusted origin, unconflicted) may drive an automatic outcome.
    if (!h.eligibility.autoGate) {
      return { snapshotId, decision: human("unverified_memory_match", `possible match with note ${h.noteId} (${h.label}) is not gate-eligible; a person must confirm`) };
    }
    if (n.source.kind === SOURCE_OPEN_TASK) return { snapshotId, decision: { kind: "duplicate", of: n.source.ref, noteId: n.id } };
    return { snapshotId, decision: { kind: "known_answer", noteId: n.id, answer: n.summary || n.content.join(" ") } };
  }
  return { snapshotId };
}

/** The FlowKit action name the `triage_decision` rule returns for a decision (see flows/triage.flow.yaml). */
export function flowAction(d: TriageDecision): "route" | "duplicate" | "known_answer" | "drop_noise" | "escalate" {
  return d.kind === "needs_human" ? "escalate" : d.kind;
}
