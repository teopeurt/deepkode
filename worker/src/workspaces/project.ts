import { collectDiff, enforceScope } from "./diff";
import { runChecks, type CheckResult } from "./checks";
import { detectConflicts } from "./conflicts";
import { git, gitOk } from "./git";
import { WorktreeManager, type WorktreeHandle } from "./worktrees";

export interface ProjectRepo {
  name: string;
  path: string;
  /** Branch or ref tasks start from and would merge into. */
  baseRef: string;
}

export interface Project {
  id: string;
  repos: ProjectRepo[];
}

export interface ProjectTask {
  workflowId: string;
  epoch: string | number;
  taskId: string;
}

/** One worktree per repo per task. Idempotent: a second call returns the same worktrees. */
export async function createProjectWorkspaces(mgr: WorktreeManager, project: Project, task: ProjectTask): Promise<WorktreeHandle[]> {
  const names = project.repos.map((r) => r.name);
  if (new Set(names).size !== names.length) throw new Error("duplicate repo name in project");
  const out: WorktreeHandle[] = [];
  for (const r of project.repos) out.push(await mgr.create(r.path, { ...task, repo: r.name }, r.baseRef));
  return out;
}

/** Runs each repo's check commands in that repo's worktree. */
export async function runProjectChecks(
  handles: WorktreeHandle[],
  commands: Record<string, string[]>,
  opts: { timeoutMs?: number; maxOutput?: number } = {},
): Promise<Record<string, CheckResult[]>> {
  const out: Record<string, CheckResult[]> = {};
  for (const h of handles) out[h.repo] = await runChecks(h.path, commands[h.repo] ?? [], opts);
  return out;
}

/** Commits all changes in the worktree (if any). Returns true when a commit was made. */
export async function commitWorktree(h: WorktreeHandle, message: string): Promise<boolean> {
  await gitOk(h.path, ["add", "-A"]);
  const dirty = (await git(h.path, ["diff", "--cached", "--quiet"])).code !== 0;
  if (!dirty) return false;
  await gitOk(h.path, ["-c", "user.name=deepkode-worker", "-c", "user.email=worker@deepkode.invalid", "commit", "--no-verify", "-m", message]);
  return true;
}

export type RepoState = "ready" | "failed" | "conflict";

export interface RepoReport {
  repo: string;
  state: RepoState;
  branch: string;
  reason?: string;
  conflictFiles?: string[];
  diffFiles?: string[];
}

export type ProjectOutcome =
  /** Every repo is ready. Still nothing is merged: the caller integrates each repo separately. */
  | { kind: "ready"; repos: RepoReport[] }
  /** No repo is usable (includes the single-repo failure case). Nothing to merge. */
  | { kind: "failed"; repos: RepoReport[] }
  /** D8: some repos are ready, others failed or conflict. Stop at a human gate; do not merge anything. */
  | { kind: "human-gate"; reason: string; repos: RepoReport[] };

export interface RepoTaskInput {
  handle: WorktreeHandle;
  /** Whether the subagent run for this repo succeeded on evidence (Spec C §3). */
  taskSucceeded: boolean;
  failReason?: string;
  allowedScope: string[];
  requireDiff: boolean;
  checks?: CheckResult[];
}

/** Pure: applies the D8 partial-failure policy to per-repo reports. */
export function decideOutcome(repos: RepoReport[]): ProjectOutcome {
  const ready = repos.filter((r) => r.state === "ready").length;
  if (ready === repos.length) return { kind: "ready", repos };
  if (ready === 0) return { kind: "failed", repos };
  const bad = repos.filter((r) => r.state !== "ready").map((r) => `${r.repo}: ${r.state}`).join("; ");
  return { kind: "human-gate", reason: `partial failure (${bad}); no cross-repo merge performed`, repos };
}

/**
 * Evidence + conflict assessment for each repo of a project task, then the D8 outcome.
 * Commits successful worktrees (so conflict detection sees the work), dry-run merges each
 * against its repo's current base ref, and never modifies the base or merges anything.
 */
export async function assessProject(project: Project, inputs: RepoTaskInput[]): Promise<ProjectOutcome> {
  const reports: RepoReport[] = [];
  for (const inp of inputs) {
    const h = inp.handle;
    const base = project.repos.find((r) => r.name === h.repo);
    if (!base) throw new Error(`repo ${h.repo} is not part of project ${project.id}`);
    const rep: RepoReport = { repo: h.repo, state: "ready", branch: h.branch };
    if (!inp.taskSucceeded) {
      reports.push({ ...rep, state: "failed", reason: inp.failReason ?? "task did not succeed" });
      continue;
    }
    const diffFiles = await collectDiff(h.path, h.baseSha);
    rep.diffFiles = diffFiles;
    const scope = enforceScope(diffFiles, inp.allowedScope, inp.requireDiff);
    if (!scope.ok) { reports.push({ ...rep, state: "failed", reason: scope.reason }); continue; }
    const badCheck = inp.checks?.find((c) => !c.ok);
    if (badCheck) {
      reports.push({ ...rep, state: "failed", reason: `check failed: ${badCheck.command} (exit ${badCheck.exitCode}${badCheck.timedOut ? ", timed out" : ""})` });
      continue;
    }
    await commitWorktree(h, `deepkode task ${h.taskId}`);
    const [c] = await detectConflicts(h.repoPath, base.baseRef, [h.branch]);
    if (c.conflicted) reports.push({ ...rep, state: "conflict", reason: "conflict", conflictFiles: c.files });
    else reports.push(rep);
  }
  return decideOutcome(reports);
}

/**
 * Removes the project task's worktrees and branches in every repo.
 * TODO(S1 finding): also clean up the DeepCode project record / thread for these workspaces.
 * Spec C §5 puts thread deletion in the same cleanup path, but how DeepCode project records
 * accumulate across many worktrees is an open S1 question, so it is intentionally not done here.
 */
export async function cleanupProjectTask(mgr: WorktreeManager, project: Project, task: ProjectTask): Promise<Array<{ repo: string; removedWorktree: boolean; removedBranch: boolean }>> {
  const out = [];
  for (const r of project.repos) out.push({ repo: r.name, ...(await mgr.remove(r.path, { ...task, repo: r.name })) });
  return out;
}
