import type { AgentEvent, ExecutionPlane, Ref, StartRequest, TurnResult } from "./types";

/** In-memory plane that mimics the S0-verified contract: title-keyed threads, messageId-idempotent turns. */
export class FakePlane implements ExecutionPlane {
  threads = new Map<string, string>(); // title -> threadId
  turns = new Map<string, { ref: Ref; result: TurnResult }>(); // messageId -> turn
  modelCalls = 0;
  script: Partial<TurnResult> & { hang?: boolean } = { status: "completed" };
  private interrupted = new Set<string>();

  async start(req: StartRequest): Promise<Ref> {
    let threadId = this.threads.get(req.key);
    if (!threadId) { threadId = `th_${this.threads.size + 1}`; this.threads.set(req.key, threadId); }
    const messageId = req.attempt ? `${req.key}#${req.attempt}` : req.key;
    const prior = this.turns.get(messageId);
    if (prior) return prior.ref;
    this.modelCalls++;
    const ref = { threadId, turnId: `tu_${this.turns.size + 1}` };
    this.turns.set(messageId, { ref, result: { status: "running" } });
    return ref;
  }
  async watch(ref: Ref, onEvent: (e: AgentEvent) => void): Promise<TurnResult> {
    onEvent({ type: "started" });
    while (this.script.hang && !this.interrupted.has(ref.turnId)) await new Promise((r) => setTimeout(r, 5));
    if (this.interrupted.has(ref.turnId)) return { status: "interrupted" };
    const { hang: _h, ...rest } = this.script;
    return { status: "completed", ...rest };
  }
  async interrupt(ref: Ref) { this.interrupted.add(ref.turnId); }
  async read(ref: Ref): Promise<TurnResult> {
    return this.interrupted.has(ref.turnId) ? { status: "interrupted" } : { status: "running" };
  }
}
