// Critique stage contract and deterministic pre-checks (Spec C §4.4, §6, §7, D4). Pure; no model calls.
// Rule: every failing path resolves to a human gate. Passing the pre-checks only permits the model critique to run.
import type { Plan } from "./plan";

export interface CritiqueRequest {
  /** Always a new thread, distinct from the planner's. */
  threadKey: string;
  plannerThreadKey: string;
  access: "read-only";
  plan: Plan;
  plannerModel: string;
  criticModel: string;
  /** Explicit opt-in to use the planner's model as critic (Spec §7: "ideally a different model"). */
  allowSameModel?: boolean;
}

export type FindingSeverity = "blocking" | "warning" | "info";
export interface CritiqueFinding { severity: FindingSeverity; message: string; taskId?: string }
export interface CritiqueResult { findings: CritiqueFinding[] }

export type GateOutcome =
  | { kind: "human_gate"; reasons: string[] }
  | { kind: "proceed"; note: string }   // pre-checks passed: the model critique may run
  | { kind: "auto_release" };           // model critique found nothing blocking

export interface ProjectScope { allowedRepos: readonly string[]; maxTasks: number }
export type Origin = "trusted" | "untrusted";

export type PrecheckCode = "scope_repo_missing" | "scope_repo_out_of_scope" | "too_many_tasks" | "dangerous_path" | "path_traversal" | "untrusted_origin" | "empty_plan";
export interface PrecheckFinding { code: PrecheckCode; taskId?: string; message: string }

const PATH_KEY = /(^|[_-])(path|paths|file|files|dir|dirs|directory|cwd|workspace|target|targets|glob|globs|scope|root)$/i;
const TRAVERSAL = /(^|[\s"'`=(:,\[])\.\.([\/\\]|$)/;
const ABSOLUTE = /^(\/|\\|~|[A-Za-z]:[\/\\]|file:)/;

function* strings(v: unknown, key = ""): Generator<[string, string]> {
  if (typeof v === "string") yield [key, v];
  else if (Array.isArray(v)) for (const x of v) yield* strings(x, key);
  else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) yield* strings(x, k);
}

/** Deterministic checks. Does not mutate the plan. Returns every finding, not just the first. */
export function precheckPlan(plan: Plan, scope: ProjectScope, origin: Origin): PrecheckFinding[] {
  const out: PrecheckFinding[] = [];
  if (plan.tasks.length === 0) out.push({ code: "empty_plan", message: "plan has no tasks" });
  if (plan.tasks.length > scope.maxTasks) out.push({ code: "too_many_tasks", message: `plan has ${plan.tasks.length} tasks, project limit is ${scope.maxTasks}` });
  const allowed = new Set(scope.allowedRepos);
  for (const t of plan.tasks) {
    const repo = t.input.repo;
    if (typeof repo !== "string" || repo === "") out.push({ code: "scope_repo_missing", taskId: t.id, message: `task ${t.id} has no input.repo` });
    else if (!allowed.has(repo)) out.push({ code: "scope_repo_out_of_scope", taskId: t.id, message: `task ${t.id} targets repo "${repo}", not in the project's allowed set` });
    for (const [key, s] of strings(t.input)) {
      if (s.includes("\0")) out.push({ code: "dangerous_path", taskId: t.id, message: `task ${t.id}: NUL byte in ${key || "input"}` });
      if (key !== "repo" && PATH_KEY.test(key)) {
        if (ABSOLUTE.test(s)) out.push({ code: "dangerous_path", taskId: t.id, message: `task ${t.id}: absolute or home path in ${key}: ${JSON.stringify(s)}` });
        if (s.split(/[\/\\]/).includes("..")) out.push({ code: "path_traversal", taskId: t.id, message: `task ${t.id}: '..' segment in ${key}: ${JSON.stringify(s)}` });
      } else if (TRAVERSAL.test(s)) {
        out.push({ code: "path_traversal", taskId: t.id, message: `task ${t.id}: '..' path segment in ${key || "input"}` });
      }
    }
  }
  if (origin === "untrusted") out.push({ code: "untrusted_origin", message: "plan derives from an untrusted channel; a human gate is required (D4)" });
  return out;
}

/** Pre-check outcome: any finding (including untrusted origin) is a human gate; none means the model critique may run. */
export function precheckOutcome(plan: Plan, scope: ProjectScope, origin: Origin): GateOutcome {
  const f = precheckPlan(plan, scope, origin);
  return f.length ? { kind: "human_gate", reasons: f.map((x) => x.message) } : { kind: "proceed", note: "deterministic pre-checks passed" };
}

/** Contract checks on the request itself. Violations are a human gate, not a silent downgrade. */
export function validateCritiqueRequest(r: CritiqueRequest): GateOutcome {
  const reasons: string[] = [];
  if (r.access !== "read-only") reasons.push(`critique must run read-only, got ${String(r.access)}`);
  if (!r.threadKey || r.threadKey === r.plannerThreadKey) reasons.push("critique must run in a separate thread from the planner");
  if (!r.criticModel) reasons.push("critic model is not set");
  else if (r.criticModel === r.plannerModel && r.allowSameModel !== true) reasons.push(`critic model equals planner model (${r.criticModel}) and allowSameModel is not set (Spec §7)`);
  return reasons.length ? { kind: "human_gate", reasons } : { kind: "proceed", note: "critique request valid" };
}

const isFinding = (f: unknown): f is CritiqueFinding => {
  const o = f as Record<string, unknown> | null;
  return typeof o === "object" && o !== null && ["blocking", "warning", "info"].includes(o.severity as string) && typeof o.message === "string";
};

/** Decision after the model critique. Only a well-formed result with no blocking finding releases; anything else gates. */
export function decideAfterCritique(result: unknown): GateOutcome {
  const findings = (result as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findings) || !findings.every(isFinding)) return { kind: "human_gate", reasons: ["critique result is malformed"] };
  const blocking = findings.filter((f) => f.severity === "blocking");
  return blocking.length ? { kind: "human_gate", reasons: blocking.map((f) => f.message) } : { kind: "auto_release" };
}
