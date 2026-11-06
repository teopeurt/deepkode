import { judge } from "./evidence";
import type { AgentEvent, Evidence, ExecutionPlane, Ref, StartRequest, TurnResult } from "./types";

export interface RunDeps {
  plane: ExecutionPlane;
  heartbeat: (e: AgentEvent) => void;
  cancelled: AbortSignal;
  /** Reads the worktree diff (git diff --name-only against the base). */
  collectDiff: (workspace: string) => Promise<string[]>;
  allowedScope: string[];
  requireDiff: boolean;
}

export type Outcome =
  | { kind: "succeeded"; ref: Ref; summary: string }
  | { kind: "failed"; ref: Ref; reason: string } // non-retryable: turn finished and the evidence says no
  | { kind: "cancelled"; ref: Ref }
  | { kind: "interrupted"; ref: Ref }; // retryable: service crash; caller starts a continuation (§4.3)

/** Core of the runSubagent activity (Spec C §4.2 to §4.4). */
export async function runSubagent(req: StartRequest, d: RunDeps): Promise<Outcome> {
  const ref = await d.plane.start(req); // idempotent: same key returns the same thread and turn
  let cancelling: Promise<void> | undefined;
  const onAbort = () => { cancelling = d.plane.interrupt(ref); };
  if (d.cancelled.aborted) onAbort(); else d.cancelled.addEventListener("abort", onAbort, { once: true });
  let result: TurnResult;
  try {
    result = await d.plane.watch(ref, d.heartbeat);
  } finally {
    d.cancelled.removeEventListener("abort", onAbort);
  }
  if (cancelling) { await cancelling; return { kind: "cancelled", ref }; }
  if (result.status === "interrupted") return { kind: "interrupted", ref };
  if (result.status === "failed") return { kind: "failed", ref, reason: "turn failed" };
  const evidence: Evidence = {
    diffFiles: await d.collectDiff(req.workspace),
    allowedScope: d.allowedScope,
    checksPassed: result.checksPassed,
    goalComplete: result.goalComplete,
    requireDiff: d.requireDiff,
    requireChecks: (req.checks?.length ?? 0) > 0,
  };
  const v = judge(evidence);
  return v.ok ? { kind: "succeeded", ref, summary: result.summary ?? "" } : { kind: "failed", ref, reason: v.reason };
}
