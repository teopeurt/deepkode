import { expect, test } from "bun:test";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { createActivities, ERR_INTERRUPTED, ERR_TURN_FAILED, type ActivityCtx, type RunSubagentInput } from "./activities";
import { FakePlane } from "./fake-plane";
import type { AgentEvent, Ref, StartRequest, TurnResult } from "./types";

const base: StartRequest = { key: "k1", role: "coder", workspace: "/w", access: "ask", prompt: "p", connection: "c", model: "m", checks: ["t"] };
const input = { workflowId: "wf", idempotencyKey: "k1", entryEpoch: 0, stepIndex: 1, taskId: "t1", agent: "coder" } as RunSubagentInput;

function setup(plane: FakePlane, attempt = 1, signal = new AbortController().signal, diff = ["src/a.ts"]) {
  const beats: unknown[] = [];
  const ctx: ActivityCtx = { heartbeat: (d) => beats.push(d), cancellationSignal: signal, attempt };
  const acts = createActivities({
    plane, collectDiff: async () => diff, ctx: () => ctx, keepaliveMs: 10_000,
    planRequest: () => ({ ...base, role: "planner", access: "read-only", key: "plan1", checks: undefined }),
    taskSpec: () => ({ req: base, allowedScope: ["src/"], requireDiff: true }),
  });
  return { acts, beats };
}

test("heartbeats on every plane event", async () => {
  const plane = new FakePlane(); plane.script = { status: "completed", checksPassed: true, summary: "ok" };
  const { acts, beats } = setup(plane);
  expect(await acts.runSubagent(input)).toEqual({ output: "ok" });
  expect(beats).toContainEqual({ type: "started" });
});

test("retry after a worker kill re-attaches: one turn, one model call", async () => {
  class Crashy extends FakePlane { n = 0; async watch(r: Ref, f: (e: AgentEvent) => void): Promise<TurnResult> { if (this.n++ === 0) throw new Error("worker killed"); return super.watch(r, f); } }
  const plane = new Crashy(); plane.script = { status: "completed", checksPassed: true, summary: "ok" };
  await expect(setup(plane, 1).acts.runSubagent(input)).rejects.toThrow("worker killed");
  expect(await setup(plane, 2).acts.runSubagent(input)).toEqual({ output: "ok" });
  expect(plane.modelCalls).toBe(1); expect(plane.turns.size).toBe(1); expect(plane.threads.size).toBe(1);
});

test("cancellation signal interrupts the turn and surfaces CancelledFailure", async () => {
  const plane = new FakePlane(); plane.script = { hang: true };
  const ac = new AbortController();
  const p = setup(plane, 1, ac.signal).acts.runSubagent(input);
  setTimeout(() => ac.abort(), 20);
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(CancelledFailure);
  expect(await plane.read({ threadId: "th_1", turnId: "tu_1" })).toEqual({ status: "interrupted" });
});

test("turn finished and failed is non-retryable", async () => {
  const plane = new FakePlane(); plane.script = { status: "completed", checksPassed: false };
  const e = await setup(plane).acts.runSubagent(input).catch((x) => x);
  expect(e).toBeInstanceOf(ApplicationFailure);
  expect(e.type).toBe(ERR_TURN_FAILED); expect(e.nonRetryable).toBe(true);
});

test("interrupted is retryable, and the retry sends a continuation turn", async () => {
  class Int extends FakePlane { async read(r: Ref): Promise<TurnResult> { return { status: "interrupted" }; } }
  const plane = new Int(); plane.script = { status: "interrupted" };
  const e = await setup(plane, 1).acts.runSubagent(input).catch((x) => x);
  expect(e.type).toBe(ERR_INTERRUPTED); expect(e.nonRetryable).toBe(false);
  plane.script = { status: "completed", checksPassed: true, summary: "resumed" };
  expect(await setup(plane, 2).acts.runSubagent(input)).toEqual({ output: "resumed" });
  expect(plane.threads.size).toBe(1); expect(plane.turns.size).toBe(2); // same thread, new turn
});

test("planOrchestration parses plan JSON and fails non-retryably on bad JSON", async () => {
  const plane = new FakePlane(); plane.script = { status: "completed", summary: JSON.stringify({ tasks: [{ id: "a", agent: "coder" }] }) };
  expect(await setup(plane).acts.planOrchestration(input)).toEqual({ tasks: [{ id: "a", agent: "coder" }] });
  const bad = new FakePlane(); bad.script = { status: "completed", summary: "nope" };
  const e = await setup(bad).acts.planOrchestration(input).catch((x) => x);
  expect(e.nonRetryable).toBe(true);
});

test("synthesizeOrchestration is deterministic by default", async () => {
  const r = await setup(new FakePlane()).acts.synthesizeOrchestration({ ...input, results: [{ id: "a", agent: "coder", status: "failed", error: "x" }] });
  expect((r.output as any).failed).toEqual(["a"]);
});
