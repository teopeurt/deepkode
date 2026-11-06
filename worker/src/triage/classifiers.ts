// Classifiers: a deterministic keyword baseline and a scripted test double. No model, no network.
import type { ProjectRecord } from "./registry";
import type { Classification, Classifier, Label, TriageInput } from "./types";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word match for plain words, substring match for anything with punctuation (paths, identifiers). */
export function hasTerm(textLower: string, term: string): boolean {
  const t = term.toLowerCase();
  if (/^[a-z0-9 ]+$/.test(t)) return new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`).test(textLower);
  return textLower.includes(t);
}

const count = (text: string, terms: readonly string[]) => terms.filter((t) => hasTerm(text, t)).length;

export const LABEL_TERMS: Record<Label, readonly string[]> = {
  security: ["vulnerability", "vulnerable", "exploit", "cve-", "sql injection", "xss", "csrf", "data breach", "privilege escalation", "path traversal", "credentials exposed", "password exposed", "unauthorized access", "security issue", "leaked", "remote code execution", "authentication bypass", "pentest"],
  noise: ["unsubscribe", "out of office", "auto-reply", "automatic reply", "newsletter", "you have won", "seo services", "limited time offer", "delivery status notification", "synthetic monitor", "test crash", "heartbeat ping", "marketing", "click here to claim", "no action needed"],
  crash: ["stack trace", "traceback", "exception", "segmentation fault", "sigsegv", "exc_bad_access", "fatal error", "panic:", "unhandled", "nullpointerexception", "typeerror", "referenceerror", "anr", "crashed", "crash report"],
  bug: ["bug", "broken", "not working", "doesn't work", "does not work", "error", "fails", "failed", "wrong", "incorrect", "can't", "cannot", "unable", "stuck", "missing", "stopped", "not delivered", "never arrive", "does not arrive", "duplicate charge", "charged twice"],
  feature: ["feature request", "would be great", "would be nice", "please add", "could you add", "support for", "wish", "it would help", "ability to", "add an option", "i'd like"],
  question: ["how do i", "how can i", "is it possible", "where can i", "can i", "do you support", "what is the", "how to", "does it"],
  feedback: ["love the", "great job", "thank you", "thanks for", "disappointed", "feedback", "overall experience", "happy with"],
};

/** Labels the classifier may propose, in tie-break order (earlier wins). Safer labels first. */
const ORDER: Label[] = ["security", "noise", "crash", "bug", "feature", "question", "feedback"];

export interface RuleClassifierOptions {
  /** Minimum share of the best repo's hits another repo needs to be included (multi-repo tasks). */
  repoShare?: number;
}

/**
 * Deterministic keyword baseline. It scores label terms and the registry's routing hints, and derives
 * a confidence from how far the best label and project lead their runners-up. It has no notion of
 * meaning: sarcasm, injected instructions and unregistered products all look like ordinary text, which is
 * why the decision function screens and gates independently of this class.
 */
export class RuleClassifier implements Classifier {
  constructor(private readonly opts: RuleClassifierOptions = {}) {}

  async classify(input: TriageInput, ctx: { projects: ProjectRecord[] }): Promise<Classification> {
    const text = `${input.subject ?? ""}\n${input.body}`.toLowerCase();

    // Label.
    const raw: Record<Label, number> = Object.fromEntries(ORDER.map((l) => [l, count(text, LABEL_TERMS[l])])) as Record<Label, number>;
    // Security terms are rare and costly to miss, so they count double; in a crash report the
    // pre-processor already says "crash", so generic bug words are evidence for it, not a rival label.
    raw.security *= 2;
    if (input.inputType === "crash_report") { raw.crash += raw.bug; raw.bug = 0; }
    const scores = ORDER.map((l) => [l, raw[l]] as const).sort((a, b) => b[1] - a[1] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
    const [top, second] = [scores[0]!, scores[1]!];
    let label: Label = top[1] > 0 ? top[0] : "feedback";
    let labelConf = top[1] > 0 ? top[1] / (top[1] + 0.5 * second[1] + 0.5) : 0;
    // A crash report with no label words at all is still a crash report, but only weakly.
    if (input.inputType === "crash_report" && top[1] === 0) { label = "crash"; labelConf = 0.5; }

    // Project.
    const projScores = ctx.projects.map((p) => {
      const kw = count(text, p.routingHints.keywords);
      const repoHits = p.repos.map((r) => count(text, r.hints));
      // A project must be named by its own keywords; repo hints alone (generic platform terms) are not enough.
      return { p, repoHits, kw, score: kw === 0 ? 0 : kw + repoHits.reduce((a, b) => a + b, 0) };
    }).sort((a, b) => b.score - a.score || (a.p.id < b.p.id ? -1 : 1));
    const best = projScores[0];
    const next = projScores[1];

    if (!best || best.score === 0) {
      return { label, project: null, repos: [], confidence: label === "noise" ? labelConf : 0, rationale: `no project hint matched; label ${label} (${top[1]} term hits)` };
    }
    const projConf = best.score / (best.score + 2 * (next?.score ?? 0) + 0.5);

    // Repos within the best project.
    const maxHit = Math.max(...best.repoHits);
    let repos: string[] = [];
    if (best.p.repos.length === 1) repos = [best.p.repos[0]!.name];
    else if (maxHit === 0) repos = []; // several repos and no cue: leave empty so the decision asks a person
    else {
      const share = this.opts.repoShare ?? 0.3;
      repos = best.p.repos.filter((_, i) => best.repoHits[i]! >= Math.max(1, share * maxHit)).map((r) => r.name);
    }

    const alternatives = projScores.slice(1).filter((s) => s.score > 0).map((s) => ({ project: s.p.id, confidence: s.score / (s.score + 2 * best.score + 0.5) }));
    const confidence = label === "noise" ? labelConf : Math.min(labelConf, projConf);
    return {
      label, project: best.p.id, repos, confidence, alternatives,
      rationale: `label ${label} (${top[1]} vs ${second[1]}), project ${best.p.id} (${best.score} vs ${next?.score ?? 0}), repos [${repos.join(", ")}]`,
    };
  }
}

export type ScriptedReply = Classification | Error | ((input: TriageInput) => Classification | Promise<Classification>);

/** Test double: returns a canned reply per input id (or a fallback), and records every call. */
export class ScriptedClassifier implements Classifier {
  readonly calls: TriageInput[] = [];
  constructor(private readonly script: Record<string, ScriptedReply> = {}, private readonly fallback?: ScriptedReply) {}

  async classify(input: TriageInput): Promise<Classification> {
    this.calls.push(input);
    const r = this.script[input.id] ?? this.fallback;
    if (r === undefined) throw new Error(`ScriptedClassifier: no reply scripted for ${input.id}`);
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(input) : r;
  }
}
