// Types for the execution plane (Spec C §4). Unverified RPC shapes are marked S1-CONFIRM.
export type Role = "planner" | "adversary" | "coder" | "tester" | "reviewer" | "security" | "copy";
export type Access = "read-only" | "ask" | "full-access";

export interface StartRequest {
  /** FlowKit idempotency key: [workflowId, entryEpoch, stepIndex, phase, taskId] joined. Used as thread title. */
  key: string;
  /** Appended to the messageId only for a deliberate corrective or continuation message (§4.2). */
  attempt?: string;
  role: Role;
  workspace: string;
  access: Access;
  prompt: string;
  connection: string;
  model: string;
  checks?: string[];
  tokenBudget?: number;
}

export interface Ref { threadId: string; turnId: string }
export type TurnStatus = "running" | "completed" | "failed" | "interrupted";
export interface TurnResult { status: TurnStatus; summary?: string; goalComplete?: boolean; checksPassed?: boolean }
export interface AgentEvent { type: string; data?: unknown }

export interface ExecutionPlane {
  start(req: StartRequest): Promise<Ref>;
  watch(ref: Ref, onEvent: (e: AgentEvent) => void): Promise<TurnResult>;
  interrupt(ref: Ref): Promise<void>; // resolves only once the turn reads "interrupted"
  read(ref: Ref): Promise<TurnResult>;
}

export interface Evidence {
  diffFiles: string[];
  allowedScope: string[]; // path prefixes the task may touch
  checksPassed?: boolean;
  goalComplete?: boolean;
  requireDiff: boolean;
  requireChecks: boolean;
}
