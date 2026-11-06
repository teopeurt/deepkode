import { mkdir, realpath, rmdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { git, gitOk } from "./git";

/** Identifies one task in one repo. Spec C §5: `{workflowId}/{epoch}/{repo}/{taskId}`. */
export interface TaskRef {
  workflowId: string;
  epoch: string | number;
  repo: string;
  taskId: string;
}

export interface WorktreeHandle extends TaskRef {
  path: string;
  branch: string;
  repoPath: string;
  baseRef: string;
  /** Commit the worktree was created from (recorded, so later base movement is visible). */
  baseSha: string;
}

export class UnsafePathError extends Error {}

/**
 * Sanitises one path segment. Traversal and separators are rejected (not rewritten);
 * other unsafe characters become "_". Distinct ids that differ only in unsafe characters
 * map to the same segment ("a b" and "a_b"), so ids should be generated, not free text.
 */
export function sanitiseSegment(label: string, raw: string | number): string {
  const s = String(raw);
  if (s.length === 0) throw new UnsafePathError(`${label} is empty`);
  if (s.length > 100) throw new UnsafePathError(`${label} is too long`);
  if (s.includes("/") || s.includes("\\") || s.includes("\0")) throw new UnsafePathError(`${label} contains a path separator`);
  if (s.includes("..")) throw new UnsafePathError(`${label} contains traversal`);
  let out = s.replace(/[^A-Za-z0-9._-]/g, "_");
  if (out.startsWith(".") || out.startsWith("-")) out = "_" + out.slice(1);
  if (out.endsWith(".lock")) out = out.slice(0, -5) + "_lock";
  return out;
}

function segments(t: TaskRef): string[] {
  return [
    sanitiseSegment("workflowId", t.workflowId),
    sanitiseSegment("epoch", t.epoch),
    sanitiseSegment("repo", t.repo),
    sanitiseSegment("taskId", t.taskId),
  ];
}

/** Branch names embed the epoch, so a retry in a later epoch can never collide with an earlier branch. */
export function branchName(t: TaskRef): string {
  return "dk/" + segments(t).join("/");
}

interface RawWorktree { path: string; branch: string; head: string }

export class WorktreeManager {
  constructor(private readonly root: string) {}

  private async realRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return realpath(this.root);
  }

  /** Absolute path of the worktree for a task, verified to stay inside the root. */
  async pathFor(t: TaskRef): Promise<string> {
    const root = await this.realRoot();
    const p = resolve(root, ...segments(t));
    if (!p.startsWith(root + sep)) throw new UnsafePathError("resolved path escapes the worktree root");
    return p;
  }

  /** Creates (or returns the existing) worktree. Calling twice returns the same worktree. */
  async create(repoPath: string, t: TaskRef, baseRef: string): Promise<WorktreeHandle & { created: boolean }> {
    const path = await this.pathFor(t);
    const branch = branchName(t);
    const repo = await realpath(resolve(repoPath));
    const existing = (await listRaw(repo)).find((w) => w.path === path);
    const recordedBase = async () => (await git(repo, ["config", "--get", `branch.${branch}.deepkodeBase`])).stdout.trim();
    if (existing) {
      if (existing.branch !== branch) throw new Error(`worktree path ${path} is registered with a different branch (${existing.branch})`);
      const baseSha = (await recordedBase()) || (await gitOk(repo, ["rev-parse", `${baseRef}^{commit}`]));
      return { ...t, path, branch, repoPath: repo, baseRef, baseSha, created: false };
    }
    const baseSha = await gitOk(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    await mkdir(dirname(path), { recursive: true });
    const branchExists = (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    if (branchExists) {
      await gitOk(repo, ["worktree", "add", path, branch]);
    } else {
      await gitOk(repo, ["worktree", "add", "-b", branch, path, baseSha]);
      await gitOk(repo, ["config", `branch.${branch}.deepkodeBase`, baseSha]);
    }
    return { ...t, path, branch, repoPath: repo, baseRef, baseSha: (await recordedBase()) || baseSha, created: true };
  }

  /** Removes the worktree directory and its branch. Safe to call when already gone. */
  async remove(repoPath: string, t: TaskRef): Promise<{ removedWorktree: boolean; removedBranch: boolean }> {
    const path = await this.pathFor(t);
    const branch = branchName(t);
    const repo = await realpath(resolve(repoPath));
    let removedWorktree = false;
    if ((await listRaw(repo)).some((w) => w.path === path)) {
      await gitOk(repo, ["worktree", "remove", "--force", path]);
      removedWorktree = true;
    }
    await git(repo, ["worktree", "prune"]);
    const del = await git(repo, ["branch", "-D", branch]);
    await git(repo, ["config", "--unset", `branch.${branch}.deepkodeBase`]);
    await this.pruneEmptyParents(path);
    return { removedWorktree, removedBranch: del.code === 0 };
  }

  /** Lists worktrees of this repo that live under the manager root on a `dk/` branch. */
  async list(repoPath: string): Promise<RawWorktree[]> {
    const root = await this.realRoot();
    const repo = await realpath(resolve(repoPath));
    return (await listRaw(repo)).filter((w) => w.path.startsWith(root + sep) && w.branch.startsWith("dk/"));
  }

  /** Removes every worktree and branch of one workflow (optionally one epoch) in this repo. */
  async removeWorkflow(repoPath: string, workflowId: string, epoch?: string | number): Promise<number> {
    const prefix = `dk/${sanitiseSegment("workflowId", workflowId)}/${epoch === undefined ? "" : sanitiseSegment("epoch", epoch) + "/"}`;
    const repo = await realpath(resolve(repoPath));
    let n = 0;
    for (const w of await this.list(repo)) {
      if (!w.branch.startsWith(prefix)) continue;
      await git(repo, ["worktree", "remove", "--force", w.path]);
      await this.pruneEmptyParents(w.path);
      n++;
    }
    await git(repo, ["worktree", "prune"]);
    const refs = (await gitOk(repo, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`])).split("\n").filter(Boolean);
    for (const b of refs) {
      await git(repo, ["branch", "-D", b]);
      await git(repo, ["config", "--unset", `branch.${b}.deepkodeBase`]);
    }
    return n;
  }

  private async pruneEmptyParents(p: string): Promise<void> {
    const root = await this.realRoot();
    let dir = dirname(p);
    while (dir.startsWith(root + sep)) {
      try { await rmdir(dir); } catch { return; } // not empty or already gone
      dir = dirname(dir);
    }
  }
}

async function listRaw(realRepo: string): Promise<RawWorktree[]> {
  const out = await gitOk(realRepo, ["worktree", "list", "--porcelain"]);
  const items: RawWorktree[] = [];
  for (const block of out.split("\n\n")) {
    let path = "", branch = "", head = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) head = line.slice(5);
      else if (line.startsWith("branch ")) branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    if (path) items.push({ path, branch, head });
  }
  return items;
}
