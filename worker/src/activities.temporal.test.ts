// Workflow-level tests on Temporal's local test server. Skipped if the server binary cannot be obtained.
import { expect, test } from "bun:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createActivities, type RunSubagentInput } from "./activities";
import { FakePlane } from "./fake-plane";
import type { AgentEvent, Ref, StartRequest, TurnResult } from "./types";

const base: StartRequest = { key: "wf:0:1:task:t1", role: "coder", workspace: "/w", access: "ask", prompt: "p", connection: "c", model: "m", checks: ["t"] };
const input = { workflowId: "wf", idempotencyKey: base.key, entryEpoch: 0, stepIndex: 1, taskId: "t1", agent: "coder" } as RunSubagentInput;

let env: TestWorkflowEnvironment | undefined;
try { env = await TestWorkflowEnvironment.createLocal(); } catch (e) { console.log("temporal test server unavailable:", String(e).slice(0, 200)); }
const t = (name: string, fn: () => Promise<void>) => (env ? test : test.skip)(name, fn, 60_000);

let q = 0;
/** Bun can fail Worker-thread teardown after the body finished; keep the body's outcome and record the teardown error. */
export const teardownErrors: string[] = [];
async function run<T>(plane: FakePlane, body: (client: TestWorkflowEnvironment["client"], taskQueue: string) => Promise<T>): Promise<T> {
  const taskQueue = `q${++q}`;
  const worker = await Worker.create({
    connection: env!.nativeConnection, taskQueue, workflowsPath: require.resolve("./test-workflows"),
    activities: createActivities({
      plane, collectDiff: async () => ["src/a.ts"], keepaliveMs: 200,
      planRequest: () => base, taskSpec: () => ({ req: base, allowedScope: ["src/"], requireDiff: true }),
    }),
  });
  let outcome: { ok: true; v: T } | { ok: false; e: unknown } | undefined;
  try {
    await worker.runUntil((async () => {
      try { outcome = { ok: true, v: await body(env!.client, taskQueue) }; } catch (e) { outcome = { ok: false, e }; }
    })());
  } catch (e) { teardownErrors.push(String(e)); }
  if (!outcome) throw new Error("body did not complete");
  if (!outcome.ok) throw outcome.e;
  return outcome.v;
}

t("activity retried after a simulated worker kill makes no second turn", async () => {
  class Crashy extends FakePlane { n = 0; async watch(r: Ref, f: (e: AgentEvent) => void): Promise<TurnResult> { if (this.n++ === 0) throw new Error("worker killed"); return super.watch(r, f); } }
  const plane = new Crashy(); plane.script = { status: "completed", checksPassed: true, summary: "ok" };
  const out = await run(plane, (c, taskQueue) => c.workflow.execute("subagentWorkflow", { taskQueue, workflowId: "w1", args: [input] }));
  expect(out).toBe("ok");
  expect(plane.n).toBe(2); // two attempts ran
  expect(plane.modelCalls).toBe(1); // but only one model call / turn
  expect(plane.turns.size).toBe(1);
});

t("workflow cancellation ends with outcome cancelled and the turn interrupted", async () => {
  const plane = new FakePlane(); plane.script = { hang: true };
  const out = await run(plane, async (c, taskQueue) => {
    const h = await c.workflow.start("subagentWorkflow", { taskQueue, workflowId: "w2", args: [input] });
    while (plane.modelCalls === 0) await new Promise((r) => setTimeout(r, 20));
    await h.cancel();
    return h.result();
  });
  expect(out).toBe("cancelled");
  expect(await plane.read({ threadId: "th_1", turnId: "tu_1" })).toEqual({ status: "interrupted" });
});

t("failed evidence is not retried", async () => {
  class Counting extends FakePlane { watchCalls = 0; async watch(r: Ref, f: (e: AgentEvent) => void): Promise<TurnResult> { this.watchCalls++; return super.watch(r, f); } }
  const plane = new Counting(); plane.script = { status: "completed", checksPassed: false };
  await expect(run(plane, (c, taskQueue) => c.workflow.execute("subagentWorkflow", { taskQueue, workflowId: "w3", args: [input] }))).rejects.toThrow();
  expect(plane.modelCalls).toBe(1);
  expect(plane.watchCalls).toBe(1);
});

t("teardown errors, if any, are reported", async () => {
  if (teardownErrors.length) console.log("BUN TEARDOWN ERRORS (not assertion failures):", teardownErrors.length);
});
