// Plan validation (Spec C §4.4). Pure functions: no network, no model calls.
// The worker validates the planner's JSON itself because top-level turns have no schema-constrained output (U4).
import type { Role } from "./types";

/**
 * Roles a plan task may be assigned to. Spec §7 also names `adversary` and `copy`, which are not in the `Role`
 * type; `planner` and `adversary` are stage roles, not subagents, so they are rejected as task agents.
 */
export const TASK_AGENT_ROLES: readonly string[] = ["coder", "tester", "reviewer", "security", "copy"] satisfies (Role | "copy")[];

export interface PlanTask { id: string; agent: string; input: Record<string, unknown>; dependsOn?: string[] }
export interface Plan { tasks: PlanTask[] }

export interface PlanLimits { maxTasks: number; maxBytes: number; maxIdLength: number; agents: readonly string[] }
export const DEFAULT_PLAN_LIMITS: PlanLimits = { maxTasks: 20, maxBytes: 64 * 1024, maxIdLength: 64, agents: TASK_AGENT_ROLES };

export type PlanErrorCode =
  | "not_object" | "tasks_missing" | "tasks_empty" | "too_many_tasks" | "too_large"
  | "task_not_object" | "id_invalid" | "id_duplicate" | "agent_unknown"
  | "input_not_object" | "depends_on_invalid" | "depends_on_unknown" | "depends_on_self" | "dependency_cycle";

export interface PlanError { code: PlanErrorCode; path: string; message: string }
export type PlanValidation = { ok: true; plan: Plan } | { ok: false; errors: PlanError[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validatePlan(value: unknown, limits: PlanLimits = DEFAULT_PLAN_LIMITS): PlanValidation {
  const errors: PlanError[] = [];
  const err = (code: PlanErrorCode, path: string, message: string) => errors.push({ code, path, message });

  if (!isObj(value)) { err("not_object", "$", "plan must be a JSON object with a `tasks` array"); return { ok: false, errors }; }
  if (!Array.isArray(value.tasks)) { err("tasks_missing", "$.tasks", "`tasks` must be an array"); return { ok: false, errors }; }
  const rawTasks: unknown[] = value.tasks;
  if (rawTasks.length === 0) { err("tasks_empty", "$.tasks", "plan has no tasks"); return { ok: false, errors }; }

  let size = 0;
  try { size = new TextEncoder().encode(JSON.stringify(value)).length; } catch { size = Infinity; }
  if (size > limits.maxBytes) err("too_large", "$", `plan is ${size} bytes, limit is ${limits.maxBytes}`);
  if (rawTasks.length > limits.maxTasks) err("too_many_tasks", "$.tasks", `plan has ${rawTasks.length} tasks, limit is ${limits.maxTasks}`);
  // Do not walk an oversized plan any further: report the size problem only.
  if (errors.length > 0) return { ok: false, errors };

  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  rawTasks.forEach((t, i) => {
    const p = `$.tasks[${i}]`;
    if (!isObj(t)) { err("task_not_object", p, "task must be an object"); return; }
    const { id, agent, input, dependsOn } = t;
    let idOk = false;
    if (typeof id !== "string" || id.length === 0 || id.length > limits.maxIdLength || !ID_RE.test(id)) {
      err("id_invalid", `${p}.id`, `id must be a string matching ${ID_RE} and at most ${limits.maxIdLength} characters`);
    } else if (seen.has(id)) {
      err("id_duplicate", `${p}.id`, `duplicate task id "${id}"`);
    } else { seen.add(id); idOk = true; }
    if (typeof agent !== "string" || !limits.agents.includes(agent)) {
      err("agent_unknown", `${p}.agent`, `unknown agent ${JSON.stringify(agent)}; allowed: ${limits.agents.join(", ")}`);
    }
    if (!isObj(input)) err("input_not_object", `${p}.input`, "input must be a JSON object");
    let deps: string[] | undefined;
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== "string")) {
        err("depends_on_invalid", `${p}.dependsOn`, "dependsOn must be an array of task id strings");
      } else deps = dependsOn as string[];
    }
    if (idOk && typeof agent === "string" && isObj(input)) {
      tasks.push({ id: id as string, agent, input, ...(deps ? { dependsOn: deps } : {}) });
    }
  });

  // Dependency references use every declared id, so one bad task does not cascade into bogus "unknown dependency" errors.
  rawTasks.forEach((t, i) => {
    if (!isObj(t) || !Array.isArray(t.dependsOn)) return;
    (t.dependsOn as unknown[]).forEach((d, j) => {
      if (typeof d !== "string") return;
      const p = `$.tasks[${i}].dependsOn[${j}]`;
      if (d === t.id) err("depends_on_self", p, `task "${d}" depends on itself`);
      else if (!seen.has(d)) err("depends_on_unknown", p, `dependsOn references unknown task "${d}"`);
    });
  });
  if (errors.length === 0) {
    const cycle = findCycle(tasks);
    if (cycle) err("dependency_cycle", "$.tasks", `dependency cycle: ${cycle.join(" -> ")}`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, plan: { tasks } };
}

/** Returns one cycle as a list of ids (first id repeated at the end), or undefined if the graph is acyclic. */
export function findCycle(tasks: PlanTask[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn ?? []] as const));
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1); stack.push(id);
    for (const d of deps.get(id) ?? []) { const c = deps.has(d) ? visit(d) : undefined; if (c) return c; }
    stack.pop(); state.set(id, 2);
    return undefined;
  };
  for (const id of deps.keys()) { const c = visit(id); if (c) return c; }
  return undefined;
}

/** Candidate JSON texts in raw model output: the whole text, fenced blocks, then balanced top-level objects. */
export function extractJsonCandidates(raw: string): string[] {
  const out: string[] = [];
  const add = (s: string) => { const t = s.trim(); if (t && !out.includes(t)) out.push(t); };
  add(raw);
  for (const m of raw.matchAll(/```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g)) add(m[1]);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    const end = balancedEnd(raw, i);
    if (end > i) { add(raw.slice(i, end + 1)); i = end; }
  }
  return out;
}

function balancedEnd(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

export type ParseResult = { ok: true; plan: Plan } | { ok: false; errors: PlanError[] };

/** Extract and validate. Picks the first candidate that validates, else reports the failure of the one that looks like the plan. */
export function parseAndValidateOnce(raw: string, limits: PlanLimits = DEFAULT_PLAN_LIMITS): ParseResult {
  let firstFailure: PlanError[] | undefined;
  let parsedAny = false;
  for (const c of extractJsonCandidates(raw)) {
    let v: unknown;
    try { v = JSON.parse(c); } catch { continue; }
    parsedAny = true;
    const r = validatePlan(v, limits);
    if (r.ok) return r;
    if (isObj(v) && "tasks" in v) return r; // looks like the plan: report its errors, not a stray object's
    firstFailure ??= r.errors;
  }
  if (firstFailure) return { ok: false, errors: firstFailure };
  return { ok: false, errors: [{ code: "not_object", path: "$", message: parsedAny ? "no JSON object with `tasks` found" : "no parsable JSON found in the reply" }] };
}

/** Attempt suffix for the one corrective message (new messageId, same thread; Spec §4.2/§4.4). */
export const CORRECTIVE_ATTEMPT = "corrective1";

export type PlanOutcome =
  | { kind: "ok"; plan: Plan }
  | { kind: "retry"; attempt: typeof CORRECTIVE_ATTEMPT; correctiveMessage: string; errors: PlanError[] }
  | { kind: "degrade_to_human"; reason: string; errors: PlanError[] };

export function correctiveMessage(errors: PlanError[], limits: PlanLimits = DEFAULT_PLAN_LIMITS): string {
  const shown = errors.slice(0, 10).map((e) => `- ${e.path}: ${e.message}`).join("\n");
  const more = errors.length > 10 ? `\n- ... and ${errors.length - 10} more` : "";
  return [
    "Your previous reply was not a valid plan. Problems found:",
    shown + more,
    "",
    "Reply again with ONLY one JSON object, no prose and no code fence, shaped as",
    '{"tasks":[{"id":"t1","agent":"coder","input":{},"dependsOn":["..."]}]}',
    `Rules: 1 to ${limits.maxTasks} tasks; unique ids; agent is one of ${limits.agents.join(", ")}; input is an object; dependsOn is optional, must name existing task ids, and must not form a cycle.`,
  ].join("\n");
}

/**
 * `attempt` 1 is the planner's first reply, 2 is the reply to the corrective message.
 * First failure -> retry with the corrective text; second failure -> degrade_to_human (never a silent pass).
 */
export function parseAndValidatePlan(raw: string, attempt: 1 | 2 = 1, limits: PlanLimits = DEFAULT_PLAN_LIMITS): PlanOutcome {
  const r = parseAndValidateOnce(typeof raw === "string" ? raw : "", limits);
  if (r.ok) return { kind: "ok", plan: r.plan };
  if (attempt === 1) return { kind: "retry", attempt: CORRECTIVE_ATTEMPT, correctiveMessage: correctiveMessage(r.errors, limits), errors: r.errors };
  return { kind: "degrade_to_human", reason: "plan invalid after one corrective retry", errors: r.errors };
}
