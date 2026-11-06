import { StdioRpc } from "./stdio-rpc";
import type { AgentEvent, ExecutionPlane, Ref, StartRequest, TurnResult, TurnStatus } from "./types";

/**
 * Real plane over DeepCode's app-server. NOT YET RUN: S0 used a mock model through a Python client.
 * Method names marked S1-CONFIRM were not exercised in S0; S1 must confirm or correct them.
 * Verified in S0: project/add, thread/start, turn/start (messageId), turn/read, turn/interrupt, event/replay, thread/read.
 */
export class DeepCodePlane implements ExecutionPlane {
  private cache = new Map<string, Ref>(); // optimisation only; thread title is the source of truth (§4.2)
  constructor(private rpc: StdioRpc, private pollMs = 1000) {}

  private async findThreadByTitle(projectId: string, title: string): Promise<string | undefined> {
    const r = await this.rpc.call("thread/list", { projectId }); // S1-CONFIRM: method name, paging, title filter
    return (r.threads ?? []).find((t: any) => t.title === title)?.id;
  }

  async start(req: StartRequest): Promise<Ref> {
    const hit = this.cache.get(req.key);
    const messageId = req.attempt ? `${req.key}#${req.attempt}` : req.key;
    if (hit && !req.attempt) return hit;
    const project = await this.rpc.call("project/add", { path: req.workspace, trustState: "trusted" });
    const projectId = project.project.id;
    let threadId = await this.findThreadByTitle(projectId, req.key);
    if (!threadId) {
      const t = await this.rpc.call("thread/start", { projectId, title: req.key, workspacePath: req.workspace, connectionId: req.connection, model: req.model });
      threadId = t.thread.id;
    }
    if (req.checks?.length) {
      // S1-CONFIRM: goal/* RPC shape (objective, checks, reviewer, token budget). Falls back to a plain turn until confirmed.
      await this.rpc.call("goal/start", { threadId, objective: req.prompt, checks: req.checks, tokenBudget: req.tokenBudget });
    }
    const turn = await this.rpc.call("turn/start", { threadId, prompt: req.prompt, messageId, skills: [], connectionId: req.connection, model: req.model });
    const ref = { threadId: threadId!, turnId: turn.turn?.id ?? turn.turnId };
    this.cache.set(req.key, ref);
    return ref;
  }

  async read(ref: Ref): Promise<TurnResult> {
    const r = await this.rpc.call("turn/read", { turnId: ref.turnId });
    const t = r.turn ?? r;
    return { status: normalise(t.status), summary: t.summary };
  }

  async watch(ref: Ref, onEvent: (e: AgentEvent) => void): Promise<TurnResult> {
    for (;;) {
      const res = await this.read(ref);
      onEvent({ type: "poll", data: res.status }); // heartbeat; S1 may switch to event/replay for finer events
      if (res.status !== "running") return res; // S1-CONFIRM: fill goalComplete/checksPassed from goal state
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  async interrupt(ref: Ref): Promise<void> {
    await this.rpc.call("turn/interrupt", { threadId: ref.threadId, turnId: ref.turnId });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if ((await this.read(ref)).status === "interrupted") return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("interrupt not confirmed within 30s"); // caller records an alert (§4.3)
  }
}

function normalise(s: string): TurnStatus {
  return s === "completed" || s === "failed" || s === "interrupted" ? s : "running";
}
