import { expect, test } from "bun:test";
import { FakePlane } from "./fake-plane";
import { runSubagent, type RunDeps } from "./run-subagent";
import type { StartRequest } from "./types";

const req: StartRequest = { key: "wf1:0:2:run:t1", role: "coder", workspace: "/w", access: "ask", prompt: "p", connection: "c", model: "m", checks: ["bun test"] };
const deps = (plane: FakePlane, diff: string[], signal = new AbortController().signal): RunDeps => ({
  plane, heartbeat: () => {}, cancelled: signal, collectDiff: async () => diff, allowedScope: ["src/"], requireDiff: true,
});

test("retried start after a crash reuses the thread and makes no second model call", async () => {
  const plane = new FakePlane();
  const a = await plane.start(req); const b = await plane.start(req);
  expect(b).toEqual(a); expect(plane.threads.size).toBe(1); expect(plane.modelCalls).toBe(1);
});

test("a continuation attempt reuses the thread but makes a new turn", async () => {
  const plane = new FakePlane();
  const a = await plane.start(req); const b = await plane.start({ ...req, attempt: "cont1" });
  expect(b.threadId).toBe(a.threadId); expect(b.turnId).not.toBe(a.turnId);
});

test("completed turn with no diff is a failure (denied writes)", async () => {
  const o = await runSubagent(req, deps(new FakePlane(), []));
  expect(o).toMatchObject({ kind: "failed", reason: "no diff in worktree" });
});

test("failed checks fail the task even when the turn completed", async () => {
  const plane = new FakePlane(); plane.script = { status: "completed", checksPassed: false };
  expect(await runSubagent(req, deps(plane, ["src/a.ts"]))).toMatchObject({ kind: "failed" });
});

test("diff outside scope fails", async () => {
  const plane = new FakePlane(); plane.script = { status: "completed", checksPassed: true };
  expect(await runSubagent(req, deps(plane, ["etc/passwd"]))).toMatchObject({ kind: "failed" });
});

test("passing checks with in-scope diff succeed", async () => {
  const plane = new FakePlane(); plane.script = { status: "completed", checksPassed: true, goalComplete: true, summary: "done" };
  expect(await runSubagent(req, deps(plane, ["src/a.ts"]))).toMatchObject({ kind: "succeeded", summary: "done" });
});

test("abort interrupts the turn and reports cancelled", async () => {
  const plane = new FakePlane(); plane.script = { hang: true };
  const ac = new AbortController();
  const p = runSubagent(req, deps(plane, [], ac.signal));
  setTimeout(() => ac.abort(), 20);
  expect(await p).toMatchObject({ kind: "cancelled" });
});

test("service-crash interrupted turn is retryable, not failed", async () => {
  const plane = new FakePlane(); plane.script = { status: "interrupted" };
  expect(await runSubagent(req, deps(plane, ["src/a.ts"]))).toMatchObject({ kind: "interrupted" });
});
