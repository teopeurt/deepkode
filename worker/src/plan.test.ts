import { expect, test } from "bun:test";
import { parseAndValidatePlan, validatePlan, DEFAULT_PLAN_LIMITS, type PlanOutcome } from "./plan";
import { precheckOutcome, precheckPlan, validateCritiqueRequest, decideAfterCritique, type CritiqueRequest, type ProjectScope } from "./critique";

const t = (id: string, extra: object = {}) => ({ id, agent: "coder", input: { repo: "app", prompt: "x" }, ...extra });
const good = { tasks: [t("a"), t("b", { dependsOn: ["a"] })] };
const codes = (v: unknown, l = DEFAULT_PLAN_LIMITS) => { const r = validatePlan(v, l); return r.ok ? [] : r.errors.map((e) => e.code); };
const scope: ProjectScope = { allowedRepos: ["app", "lib"], maxTasks: 5 };
const mkPlan = (input: Record<string, unknown>) => ({ tasks: [{ id: "a", agent: "coder", input }] });

test("valid plan passes", () => { expect(validatePlan(good).ok).toBe(true); });
test("empty and malformed shapes", () => {
  expect(codes({ tasks: [] })).toEqual(["tasks_empty"]);
  expect(codes({})).toEqual(["tasks_missing"]);
  expect(codes([])).toEqual(["not_object"]);
  expect(codes({ tasks: [{ id: "a", agent: "coder", input: [] }] })).toEqual(["input_not_object"]);
});
test("duplicate ids", () => { expect(codes({ tasks: [t("a"), t("a")] })).toEqual(["id_duplicate"]); });
test("unknown agent, including stage roles", () => {
  expect(codes({ tasks: [{ ...t("a"), agent: "wizard" }] })).toEqual(["agent_unknown"]);
  expect(codes({ tasks: [{ ...t("a"), agent: "planner" }] })).toEqual(["agent_unknown"]);
});
test("oversize plan by count and by bytes", () => {
  expect(codes({ tasks: Array.from({ length: 21 }, (_, i) => t("t" + i)) })).toEqual(["too_many_tasks"]);
  expect(codes({ tasks: [{ ...t("a"), input: { repo: "app", prompt: "x".repeat(70_000) } }] })).toEqual(["too_large"]);
});
test("dependencies: unknown, self, cyclic", () => {
  expect(codes({ tasks: [t("a", { dependsOn: ["zz"] })] })).toEqual(["depends_on_unknown"]);
  expect(codes({ tasks: [t("a", { dependsOn: ["a"] })] })).toEqual(["depends_on_self"]);
  const r = validatePlan({ tasks: [t("a", { dependsOn: ["c"] }), t("b", { dependsOn: ["a"] }), t("c", { dependsOn: ["b"] })] });
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.errors[0].code).toBe("dependency_cycle"); expect(r.errors[0].message).toContain("->"); }
});

test("invalid JSON gets a corrective retry", () => {
  const o = parseAndValidatePlan("sorry, here is a plan: {tasks: nope", 1);
  expect(o.kind).toBe("retry");
  if (o.kind === "retry") { expect(o.attempt).toBe("corrective1"); expect(o.correctiveMessage).toContain("ONLY one JSON object"); }
});
test("prose-wrapped JSON and fenced JSON are extracted", () => {
  const j = JSON.stringify(good);
  expect(parseAndValidatePlan(`Here you go:\n${j}\nHope that helps {braces}`).kind).toBe("ok");
  expect(parseAndValidatePlan("Plan:\n```json\n" + j + "\n```\nDone.").kind).toBe("ok");
  const withBrace = JSON.stringify({ tasks: [{ ...t("a"), input: { repo: "app", prompt: "use } and { in strings" } }] });
  expect(parseAndValidatePlan(`text ${withBrace} text`).kind).toBe("ok");
});
test("retry-then-degrade flow", () => {
  const first = parseAndValidatePlan(JSON.stringify({ tasks: [t("a"), t("a")] }), 1);
  expect(first.kind).toBe("retry");
  if (first.kind === "retry") expect(first.correctiveMessage).toContain("duplicate task id");
  const second: PlanOutcome = parseAndValidatePlan("still not json", 2);
  expect(second.kind).toBe("degrade_to_human");
  expect(parseAndValidatePlan(JSON.stringify(good), 2).kind).toBe("ok");
});
test("non-string raw input degrades safely", () => { expect(parseAndValidatePlan(undefined as unknown as string, 2).kind).toBe("degrade_to_human"); });

test("pre-checks pass a clean trusted plan", () => {
  expect(precheckPlan(good as never, scope, "trusted")).toEqual([]);
  expect(precheckOutcome(good as never, scope, "trusted").kind).toBe("proceed");
});
test("out-of-scope and missing repo gate to a human", () => {
  expect(precheckPlan(mkPlan({ repo: "evil" }) as never, scope, "trusted")[0].code).toBe("scope_repo_out_of_scope");
  expect(precheckPlan(mkPlan({}) as never, scope, "trusted")[0].code).toBe("scope_repo_missing");
  expect(precheckOutcome(mkPlan({ repo: "evil" }) as never, scope, "trusted").kind).toBe("human_gate");
});
test("task count over the project limit", () => {
  const p = { tasks: Array.from({ length: 6 }, (_, i) => t("t" + i)) };
  expect(precheckPlan(p as never, scope, "trusted").map((f) => f.code)).toContain("too_many_tasks");
});
test("path traversal and absolute paths", () => {
  const c = (input: Record<string, unknown>) => precheckPlan(mkPlan({ repo: "app", ...input }) as never, scope, "trusted").map((f) => f.code);
  expect(c({ paths: ["src/../../etc/passwd"] })).toContain("path_traversal");
  expect(c({ file: "/etc/passwd" })).toContain("dangerous_path");
  expect(c({ cwd: "~/secrets" })).toContain("dangerous_path");
  expect(c({ path: "C:\\Windows" })).toContain("dangerous_path");
  expect(c({ prompt: "read ../../.ssh/id_rsa" })).toContain("path_traversal");
  expect(c({ prompt: "fix the bug in src/a.ts", paths: ["src/a.ts"] })).toEqual([]);
});
test("untrusted origin always requires a human gate", () => {
  const o = precheckOutcome(good as never, scope, "untrusted");
  expect(o.kind).toBe("human_gate");
  if (o.kind === "human_gate") expect(o.reasons.join()).toContain("D4");
});

const req = (o: Partial<CritiqueRequest> = {}): CritiqueRequest => ({ threadKey: "c", plannerThreadKey: "p", access: "read-only", plan: good as never, plannerModel: "opus", criticModel: "sonnet", ...o });
test("critic model equal to planner model gates unless explicitly allowed", () => {
  expect(validateCritiqueRequest(req()).kind).toBe("proceed");
  expect(validateCritiqueRequest(req({ criticModel: "opus" })).kind).toBe("human_gate");
  expect(validateCritiqueRequest(req({ criticModel: "opus", allowSameModel: true })).kind).toBe("proceed");
  expect(validateCritiqueRequest(req({ threadKey: "p" })).kind).toBe("human_gate");
  expect(validateCritiqueRequest(req({ access: "ask" as never })).kind).toBe("human_gate");
});
test("critique result: blocking or malformed gates, clean releases", () => {
  expect(decideAfterCritique({ findings: [] }).kind).toBe("auto_release");
  expect(decideAfterCritique({ findings: [{ severity: "warning", message: "m" }] }).kind).toBe("auto_release");
  expect(decideAfterCritique({ findings: [{ severity: "blocking", message: "m" }] }).kind).toBe("human_gate");
  expect(decideAfterCritique(null).kind).toBe("human_gate");
  expect(decideAfterCritique({ findings: [{ severity: "nope" }] }).kind).toBe("human_gate");
});
