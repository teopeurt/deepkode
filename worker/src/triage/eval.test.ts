// S5 exit evaluation over SYNTHETIC labelled data (see fixtures/README.md). This validates the machinery
// (classifier -> decision -> memory -> per-repo workspace requests). It says nothing about accuracy on real input.
import { describe, expect, test } from "bun:test";
import { formatMetrics, loadExamples, loadRegistry, runEval, type Judged } from "./eval-harness";
import { workspaceRequests } from "./workspace-requests";

const TYPES = ["email", "crash_report"] as const;

describe("fixtures", () => {
  for (const t of TYPES) {
    test(`${t}: at least 50 examples, marked synthetic, covering the hard-case kinds`, () => {
      const ex = loadExamples(t);
      expect(ex.length).toBeGreaterThanOrEqual(50);
      const kinds = new Set(ex.map((e) => e.hardKind));
      for (const k of ["ambiguous_project", "low_confidence", "adversarial", "out_of_scope", "untrusted_security"]) expect(kinds.has(k)).toBe(true);
      const routes = new Set(ex.map((e) => e.expected.route));
      for (const r of ["route", "duplicate", "drop_noise", "needs_human"]) expect(routes.has(r as never)).toBe(true);
      expect(ex.some((e) => (e.expected.repos?.length ?? 0) === 2)).toBe(true);
      expect(new Set(ex.map((e) => e.id)).size).toBe(ex.length);
    });
  }
});

describe("S5 evaluation with the rule baseline (synthetic data)", () => {
  for (const t of TYPES) {
    test(`${t}: clear cases route correctly and every hard case reaches a human`, async () => {
      const { judged, metrics } = await runEval(t);
      console.log(formatMetrics(metrics));
      for (const split of ["dev", "holdout"] as const) {
        const part = judged.filter((j) => j.example.split === split);
        const clear = part.filter((j) => j.example.difficulty === "clear");
        console.log(`  ${split}: clear ${clear.filter((j) => j.correct).length}/${clear.length}, human-expected sent ${part.filter((j) => j.example.expected.route === "needs_human" && j.decision.kind === "needs_human").length}/${part.filter((j) => j.example.expected.route === "needs_human").length}`);
      }

      // Safety: a wrong or doubtful case is never routed silently.
      expect(metrics.unsafe).toBe(0);
      expect(metrics.humanRecall).toBe(1);
      for (const j of judged.filter((j) => j.example.hardKind && ["low_confidence", "ambiguous_project", "adversarial", "out_of_scope", "untrusted_security", "unverified_memory_match", "non_english", "repo_unclear"].includes(j.example.hardKind))) {
        expect(j.decision.kind).toBe("needs_human");
      }
      // Quality on the clear cases (the baseline may escalate a clear case, which is safe but counted as a miss).
      expect(metrics.clearAccuracy).toBeGreaterThanOrEqual(0.9);
      const clearWrong = judged.filter((j) => j.example.difficulty === "clear" && !j.correct);
      expect(clearWrong.every((j) => j.decision.kind === "needs_human")).toBe(true);
    });

    test(`${t}: adversarial text never produces a route, drop or memory answer`, async () => {
      const { judged } = await runEval(t);
      const adv = judged.filter((j) => j.example.hardKind === "adversarial");
      expect(adv.length).toBeGreaterThanOrEqual(5);
      expect(adv.every((j) => j.decision.kind === "needs_human")).toBe(true);
    });

    test(`${t}: untrusted security reports are never routed`, async () => {
      const { judged } = await runEval(t);
      const sec = judged.filter((j) => j.example.expected.classification === "security" && j.example.trust === "untrusted");
      expect(sec.length).toBeGreaterThan(0);
      expect(sec.every((j) => j.decision.kind === "needs_human")).toBe(true);
    });

    test(`${t}: untrusted routes carry the pre-execute human gate`, async () => {
      const { judged } = await runEval(t);
      for (const j of judged) if (j.decision.kind === "route") expect(j.decision.humanGateBeforeExecute).toBe(j.example.trust !== "trusted");
    });
  }

  test("known duplicates and known answers are recognised from memory", async () => {
    const all: Judged[] = [];
    for (const t of TYPES) all.push(...(await runEval(t)).judged);
    const mem = all.filter((j) => ["duplicate", "known_answer"].includes(j.example.expected.route));
    expect(mem.length).toBeGreaterThanOrEqual(10);
    expect(mem.filter((j) => j.correct).length).toBe(mem.length);
  });

  test("two-repo tasks produce per-repo workspace requests", async () => {
    const registry = loadRegistry();
    let two = 0;
    for (const t of TYPES) {
      const { judged } = await runEval(t);
      for (const j of judged) {
        if (j.decision.kind !== "route" || j.decision.repos.length !== 2) continue;
        two++;
        const reqs = workspaceRequests(registry, j.decision, { workflowId: `intake:${j.example.source}:${j.example.id}`, epoch: 0, taskId: "t1" });
        expect(reqs).toHaveLength(2);
        expect(reqs.map((r) => r.ref.repo).sort()).toEqual(["shop-api", "shop-web"]);
        expect(new Set(reqs.map((r) => r.branch)).size).toBe(2);
      }
    }
    expect(two).toBeGreaterThanOrEqual(5);
  });
});
