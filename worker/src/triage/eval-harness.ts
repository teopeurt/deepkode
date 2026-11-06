// Evaluation harness over the SYNTHETIC labelled sample in ./fixtures. Offline. Validates machinery only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InProcessMemory } from "../memory/service";
import { HashEmbedder } from "../memory/embedder";
import type { Memory } from "../memory/types";
import { RuleClassifier } from "./classifiers";
import { triage, type TriageDecision } from "./decision";
import { InMemoryProjectRegistry, type ProjectRecord } from "./registry";
import type { Classifier, TriageInput } from "./types";

const dir = join(import.meta.dir, "fixtures");
const readJson = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), "utf8")) as T;

export interface FixtureExample {
  id: string; inputType: "email" | "crash_report"; trust: "trusted" | "untrusted"; source: string;
  subject?: string; body: string; difficulty: "clear" | "hard"; hardKind?: string; split: "dev" | "holdout";
  expected: { classification: string; route: "route" | "duplicate" | "known_answer" | "drop_noise" | "needs_human"; project?: string; repos?: string[]; noteKey?: string };
}
interface SeedNote {
  key: string; projectId: string; kind: string; ref: string; trustedApproved: boolean;
  title: string; content: string[]; summary?: string; applicability?: string;
}

export const loadExamples = (type: "email" | "crash_report"): FixtureExample[] =>
  readJson<{ examples: FixtureExample[] }>(type === "email" ? "emails.json" : "crash-reports.json").examples;

export function loadRegistry(): InMemoryProjectRegistry {
  return new InMemoryProjectRegistry(readJson<{ projects: ProjectRecord[] }>("projects.json").projects);
}

/** Seeds memory from the synthetic notes. Returns the memory and a map from fixture key to note id. */
export async function seedMemory(): Promise<{ memory: Memory; noteIds: Map<string, string>; refs: Map<string, string> }> {
  let n = 0;
  const memory = new InProcessMemory({ embedder: new HashEmbedder(), now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++n)), newId: () => "seed" + String(++n).padStart(4, "0") });
  const noteIds = new Map<string, string>();
  const refs = new Map<string, string>();
  for (const s of readJson<{ notes: SeedNote[] }>("memory-seed.json").notes) {
    const [r] = await memory.capture({
      taskId: s.ref, projectId: s.projectId, taskOrigin: s.trustedApproved ? "trusted" : "untrusted", review: { approved: true },
      source: { kind: s.kind, ref: s.ref },
      candidates: [{ title: s.title, content: s.content, summary: s.summary, applicability: s.applicability }],
    });
    if (!r || r.action !== "inserted") throw new Error(`seed note ${s.key} not inserted: ${JSON.stringify(r)}`);
    noteIds.set(s.key, r.noteId);
    refs.set(s.key, s.ref);
    if (s.trustedApproved) memory.approve(r.noteId, { kind: "human", id: "seed-admin" });
  }
  return { memory, noteIds, refs };
}

export const toInput = (e: FixtureExample): TriageInput => ({ id: e.id, source: e.source, inputType: e.inputType, trust: e.trust, subject: e.subject, body: e.body });

export interface Judged { example: FixtureExample; decision: TriageDecision; correct: boolean; unsafe: boolean }

export interface Metrics {
  type: string; n: number; clear: number; hard: number;
  clearCorrect: number; clearAccuracy: number;
  expectedHuman: number; sentToHuman: number; humanTruePositive: number; humanPrecision: number; humanRecall: number;
  /** Not needs_human, and not what the label expects. The failure the gate exists to prevent. */
  unsafe: number;
  unsafeIds: string[];
}

export async function runEval(type: "email" | "crash_report", classifier: Classifier = new RuleClassifier()): Promise<{ judged: Judged[]; metrics: Metrics }> {
  const registry = loadRegistry();
  const { memory, noteIds, refs } = await seedMemory();
  const judged: Judged[] = [];
  for (const e of loadExamples(type)) {
    const decision = await triage(toInput(e), { classifier, registry, memory });
    const x = e.expected;
    let correct = decision.kind === x.route;
    if (correct && x.route === "route" && decision.kind === "route") {
      correct = decision.project === x.project && [...decision.repos].sort().join() === [...(x.repos ?? [])].sort().join();
    }
    if (correct && x.route === "duplicate" && decision.kind === "duplicate") correct = decision.of === refs.get(x.noteKey ?? "");
    if (correct && x.route === "known_answer" && decision.kind === "known_answer") correct = decision.noteId === noteIds.get(x.noteKey ?? "");
    judged.push({ example: e, decision, correct, unsafe: decision.kind !== "needs_human" && !correct });
  }
  const clear = judged.filter((j) => j.example.difficulty === "clear");
  const expectedHuman = judged.filter((j) => j.example.expected.route === "needs_human");
  const sent = judged.filter((j) => j.decision.kind === "needs_human");
  const tp = sent.filter((j) => j.example.expected.route === "needs_human").length;
  const clearCorrect = clear.filter((j) => j.correct).length;
  return {
    judged,
    metrics: {
      type, n: judged.length, clear: clear.length, hard: judged.length - clear.length,
      clearCorrect, clearAccuracy: clear.length ? clearCorrect / clear.length : 1,
      expectedHuman: expectedHuman.length, sentToHuman: sent.length, humanTruePositive: tp,
      humanPrecision: sent.length ? tp / sent.length : 1, humanRecall: expectedHuman.length ? tp / expectedHuman.length : 1,
      unsafe: judged.filter((j) => j.unsafe).length, unsafeIds: judged.filter((j) => j.unsafe).map((j) => j.example.id),
    },
  };
}

export function formatMetrics(m: Metrics): string {
  const p = (x: number) => (x * 100).toFixed(1) + "%";
  return `[triage eval, SYNTHETIC data] ${m.type}: n=${m.n} (clear ${m.clear}, hard ${m.hard}) | clear-case accuracy ${m.clearCorrect}/${m.clear} (${p(m.clearAccuracy)}) | needs_human precision ${p(m.humanPrecision)} (${m.humanTruePositive}/${m.sentToHuman}) recall ${p(m.humanRecall)} (${m.humanTruePositive}/${m.expectedHuman}) | unsafe wrong routes ${m.unsafe}${m.unsafe ? " " + m.unsafeIds.join(",") : ""}`;
}
