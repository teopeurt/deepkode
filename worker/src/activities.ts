// Temporal activities for the orchestrate step (Spec C §4.3, §4.4). The plane is injected, so tests use FakePlane.
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { Context } from "@temporalio/activity";
import { runSubagent as runSubagentCore } from "./run-subagent";
import type { AgentEvent, ExecutionPlane, StartRequest } from "./types";

/** Structural copies of FlowKit's orchestration activity contracts (kept local so the worker does not import FlowKit). */
export interface StepInput { workflowId: string; idempotencyKey: string; entryEpoch: number; stepIndex: number; [k: string]: unknown }
export interface PlanTask { id: string; agent: string; input?: unknown }
export interface RunSubagentInput extends StepInput { taskId: string; agent: string; input?: unknown }
export interface TaskResult { id: string; agent: string; status: "completed" | "failed" | "cancelled"; output?: unknown; outputRef?: string; error?: string }
export interface SynthesizeInput extends StepInput { results: TaskResult[] }

export const ERR_TURN_FAILED = "SubagentTurnFailed"; // non-retryable: turn finished and the evidence says no
export const ERR_INTERRUPTED = "SubagentInterrupted"; // retryable: service crash, continue in the same thread
export const ERR_BAD_PLAN = "PlanInvalid"; // non-retryable; WP-F replaces the parser with the full validator

/** The slice of Temporal's activity Context that the activities use; injectable for unit tests. */
export interface ActivityCtx { heartbeat(details?: unknown): void; cancellationSignal: AbortSignal; attempt: number }
export const temporalCtx = (): ActivityCtx => {
  const c = Context.current();
  return { heartbeat: (d) => c.heartbeat(d), cancellationSignal: c.cancellationSignal, attempt: c.info.attempt };
};

export interface TaskSpec { req: StartRequest; allowedScope: string[]; requireDiff: boolean }

export interface ActivityDeps {
  plane: ExecutionPlane;
  collectDiff: (workspace: string) => Promise<string[]>;
  /** Builds the planner turn (read-only). `key` must be derived from input.idempotencyKey. */
  planRequest: (input: StepInput) => StartRequest;
  /** Builds the subagent turn from the plan task; `req.key` must be derived from input.idempotencyKey. */
  taskSpec: (input: RunSubagentInput) => TaskSpec;
  /** Deterministic synthesis by default; replace with a model turn if judgement is needed. */
  synthesize?: (results: TaskResult[]) => unknown;
  ctx?: () => ActivityCtx;
  /** Heartbeat even with no events, so a cancel is delivered while the agent is quiet. */
  keepaliveMs?: number;
}

async function withHeartbeats<T>(d: ActivityDeps, fn: (ctx: ActivityCtx, beat: (e: AgentEvent) => void) => Promise<T>): Promise<T> {
  const ctx = (d.ctx ?? temporalCtx)();
  const beat = (e: AgentEvent) => ctx.heartbeat(e);
  const timer = setInterval(() => ctx.heartbeat({ type: "keepalive" }), d.keepaliveMs ?? 3000);
  try { return await fn(ctx, beat); } finally { clearInterval(timer); }
}

/** A continuation message only when the previous turn read "interrupted" (service crash); a worker-kill retry just re-attaches. */
async function attemptSuffix(plane: ExecutionPlane, req: StartRequest, attempt: number): Promise<StartRequest> {
  if (attempt <= 1 || req.attempt) return req;
  const ref = await plane.start(req); // idempotent: returns the existing turn, no new model call
  return (await plane.read(ref)).status === "interrupted" ? { ...req, attempt: `a${attempt}` } : req;
}

export function createActivities(d: ActivityDeps) {
  return {
    async planOrchestration(input: StepInput): Promise<{ tasks: PlanTask[] }> {
      return withHeartbeats(d, async (ctx, beat) => {
        const req = await attemptSuffix(d.plane, d.planRequest(input), ctx.attempt);
        const ref = await d.plane.start(req);
        const onAbort = () => { void d.plane.interrupt(ref); };
        ctx.cancellationSignal.addEventListener("abort", onAbort, { once: true });
        let result;
        try { result = await d.plane.watch(ref, beat); } finally { ctx.cancellationSignal.removeEventListener("abort", onAbort); }
        if (ctx.cancellationSignal.aborted) { await d.plane.interrupt(ref); throw new CancelledFailure("cancelled"); }
        if (result.status === "interrupted") throw ApplicationFailure.retryable("plan turn interrupted", ERR_INTERRUPTED);
        if (result.status === "failed") throw ApplicationFailure.nonRetryable("plan turn failed", ERR_TURN_FAILED);
        const tasks = parsePlan(result.summary ?? "");
        if (!tasks) throw ApplicationFailure.nonRetryable("plan is not valid JSON { tasks: [{ id, agent, input }] }", ERR_BAD_PLAN);
        return { tasks };
      });
    },

    async runSubagent(input: RunSubagentInput): Promise<{ output: string; outputRef?: string }> {
      return withHeartbeats(d, async (ctx, beat) => {
        const spec = d.taskSpec(input);
        const req = await attemptSuffix(d.plane, spec.req, ctx.attempt);
        const o = await runSubagentCore(req, {
          plane: d.plane, heartbeat: beat, cancelled: ctx.cancellationSignal, collectDiff: d.collectDiff,
          allowedScope: spec.allowedScope, requireDiff: spec.requireDiff,
        });
        switch (o.kind) {
          case "succeeded": return { output: o.summary };
          case "cancelled": throw new CancelledFailure("cancelled");
          case "interrupted": throw ApplicationFailure.retryable("turn interrupted", ERR_INTERRUPTED);
          case "failed": throw ApplicationFailure.nonRetryable(o.reason, ERR_TURN_FAILED);
        }
      });
    },

    async synthesizeOrchestration(input: SynthesizeInput): Promise<{ output: unknown }> {
      return { output: (d.synthesize ?? defaultSynthesize)(input.results) };
    },
  };
}

export type OrchestrationActivities = ReturnType<typeof createActivities>;

/** Minimal parse; WP-F owns the full validator and the corrective retry. */
export function parsePlan(text: string): PlanTask[] | undefined {
  try {
    const j = JSON.parse(text);
    if (!j || !Array.isArray(j.tasks)) return undefined;
    if (!j.tasks.every((t: any) => t && typeof t.id === "string" && typeof t.agent === "string")) return undefined;
    return j.tasks;
  } catch { return undefined; }
}

const defaultSynthesize = (results: TaskResult[]) => ({
  summary: results.map((r) => `${r.id} (${r.agent}): ${r.status}${r.output ? ` - ${String(r.output)}` : ""}${r.error ? ` - ${r.error}` : ""}`).join("\n"),
  failed: results.filter((r) => r.status !== "completed").map((r) => r.id),
});
