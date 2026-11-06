import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorktreeManager, UnsafePathError, assessProject, cleanupProjectTask, collectDiff, collectDiffAgainst,
  commitWorktree, createProjectWorkspaces, decideOutcome, detectConflicts, enforceScope, git, gitOk,
  runCheck, runProjectChecks, type Project,
} from "./index";

let tmp: string;
beforeAll(async () => { tmp = await mkdtemp(join(tmpdir(), "dk-ws-")); });
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

let n = 0;
async function mkRepo(files: Record<string, string> = { "a.txt": "one\ntwo\nthree\n", "src/x.ts": "x\n" }): Promise<string> {
  const dir = join(tmp, `repo${n++}`);
  await mkdir(dir, { recursive: true });
  await gitOk(dir, ["init", "-q", "-b", "main"]);
  await gitOk(dir, ["config", "user.email", "t@t"]);
  await gitOk(dir, ["config", "user.name", "t"]);
  for (const [f, c] of Object.entries(files)) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), c);
  }
  await gitOk(dir, ["add", "-A"]);
  await gitOk(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}
const mgr = () => new WorktreeManager(join(tmp, `wt${n++}`));
const T = { workflowId: "wf1", epoch: 1, taskId: "t1" };

describe("worktrees: one repo", () => {
  test("creates, is idempotent, lists, removes", async () => {
    const repo = await mkRepo();
    const m = mgr();
    const a = await m.create(repo, { ...T, repo: "api" }, "main");
    expect(a.created).toBe(true);
    expect(a.branch).toBe("dk/wf1/1/api/t1");
    expect(a.path.endsWith("/wf1/1/api/t1")).toBe(true);
    expect(existsSync(join(a.path, "a.txt"))).toBe(true);
    const b = await m.create(repo, { ...T, repo: "api" }, "main");
    expect(b.created).toBe(false);
    expect(b.path).toBe(a.path);
    expect(b.baseSha).toBe(a.baseSha);
    expect((await m.list(repo)).map((w) => w.branch)).toEqual(["dk/wf1/1/api/t1"]);
    const r = await m.remove(repo, { ...T, repo: "api" });
    expect(r).toEqual({ removedWorktree: true, removedBranch: true });
    expect(existsSync(a.path)).toBe(false);
    expect(await m.list(repo)).toEqual([]);
    expect((await git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/dk/wf1/1/api/t1"])).code).not.toBe(0);
    expect(await m.remove(repo, { ...T, repo: "api" })).toEqual({ removedWorktree: false, removedBranch: false });
  });

  test("epochs never collide and idempotent create keeps the recorded base", async () => {
    const repo = await mkRepo();
    const m = mgr();
    const e1 = await m.create(repo, { ...T, repo: "api" }, "main");
    await writeFile(join(repo, "later.txt"), "x");
    await gitOk(repo, ["add", "-A"]);
    await gitOk(repo, ["commit", "-q", "-m", "later"]);
    const e2 = await m.create(repo, { ...T, epoch: 2, repo: "api" }, "main");
    expect(e2.branch).not.toBe(e1.branch);
    expect(e2.baseSha).not.toBe(e1.baseSha);
    const again = await m.create(repo, { ...T, repo: "api" }, "main");
    expect(again.baseSha).toBe(e1.baseSha); // not re-resolved to the moved main
  });

  test("traversal and separators are rejected, odd characters sanitised", async () => {
    const repo = await mkRepo();
    const m = mgr();
    for (const bad of ["../evil", "a/b", "..", "a..b", "", "a\\b"]) {
      await expect(m.create(repo, { ...T, taskId: bad, repo: "api" }, "main")).rejects.toBeInstanceOf(UnsafePathError);
      await expect(m.create(repo, { ...T, workflowId: bad, repo: "api" }, "main")).rejects.toBeInstanceOf(UnsafePathError);
      await expect(m.create(repo, { ...T, repo: bad }, "main")).rejects.toBeInstanceOf(UnsafePathError);
    }
    const h = await m.create(repo, { ...T, taskId: "we ird:id", repo: "api" }, "main");
    expect(h.path.endsWith("/we_ird_id")).toBe(true);
    const dotted = await m.create(repo, { ...T, taskId: ".hidden", repo: "api" }, "main");
    expect(dotted.path.endsWith("/_hidden")).toBe(true);
  });
});

describe("diff and scope", () => {
  test("untracked, modified, deleted and committed files appear; ignored do not", async () => {
    const repo = await mkRepo({ "a.txt": "1\n", "src/x.ts": "x\n", "gone.txt": "g\n", ".gitignore": "*.log\n" });
    const m = mgr();
    const h = await m.create(repo, { ...T, repo: "api" }, "main");
    expect(await collectDiff(h.path, h.baseSha)).toEqual([]);
    await writeFile(join(h.path, "a.txt"), "changed\n");
    await writeFile(join(h.path, "new file.txt"), "n");
    await mkdir(join(h.path, "src/deep"), { recursive: true });
    await writeFile(join(h.path, "src/deep/u.ts"), "u");
    await writeFile(join(h.path, "debug.log"), "ignored");
    await rm(join(h.path, "gone.txt"));
    const want = ["a.txt", "gone.txt", "new file.txt", "src/deep/u.ts"];
    expect(await collectDiff(h.path, h.baseSha)).toEqual(want);
    expect(await collectDiffAgainst("main")(h.path)).toEqual(want);
    await commitWorktree(h, "work"); // committed changes still show against the base
    expect(await collectDiff(h.path, h.baseSha)).toEqual(want);
  });

  test("scope enforcement follows evidence.judge", async () => {
    expect(enforceScope(["src/a.ts", "src/b/c.ts"], ["src"]).ok).toBe(true);
    expect(enforceScope(["srcx/a.ts"], ["src"])).toEqual({ ok: false, reason: "diff outside scope: srcx/a.ts" });
    expect(enforceScope([], ["src"], true)).toEqual({ ok: false, reason: "no diff in worktree" });
    expect(enforceScope([], ["src"]).ok).toBe(true);
  });
});

describe("checks runner", () => {
  test("exit code, trimmed output, timeout", async () => {
    const ok = await runCheck(tmp, "echo hi; echo err >&2");
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("hi");
    const bad = await runCheck(tmp, "echo nope; exit 3");
    expect(bad).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
    const long = await runCheck(tmp, "yes xxxxxxxxxx | head -c 100000", { maxOutput: 100 });
    expect(long.output.length).toBeLessThanOrEqual(104);
    const slow = await runCheck(tmp, "sleep 5", { timeoutMs: 200 });
    expect(slow).toMatchObject({ ok: false, timedOut: true, exitCode: null });
  });

  test("secrets are not passed to checks", async () => {
    process.env.DK_TEST_API_KEY = "sekrit";
    const r = await runCheck(tmp, 'echo "[$DK_TEST_API_KEY]"');
    delete process.env.DK_TEST_API_KEY;
    expect(r.output).toBe("[]");
  });
});

describe("conflict detection", () => {
  test("clean and conflicting branches reported without touching base", async () => {
    const repo = await mkRepo();
    const m = mgr();
    const a = await m.create(repo, { ...T, taskId: "ta", repo: "api" }, "main");
    const b = await m.create(repo, { ...T, taskId: "tb", repo: "api" }, "main");
    const c = await m.create(repo, { ...T, taskId: "tc", repo: "api" }, "main");
    await writeFile(join(a.path, "a.txt"), "one\nA\nthree\n");
    await writeFile(join(b.path, "a.txt"), "one\nB\nthree\n");
    await writeFile(join(c.path, "other.txt"), "fine\n");
    for (const h of [a, b, c]) await commitWorktree(h, "w");
    const headBefore = await gitOk(repo, ["rev-parse", "main"]);
    const statusBefore = await gitOk(repo, ["status", "--porcelain"]);
    const res = await detectConflicts(repo, "main", [a.branch, b.branch, c.branch]);
    expect(res).toEqual([
      { branch: a.branch, conflicted: false, files: [] },
      { branch: b.branch, conflicted: true, files: ["a.txt"] },
      { branch: c.branch, conflicted: false, files: [] },
    ]);
    expect(await gitOk(repo, ["rev-parse", "main"])).toBe(headBefore);
    expect(await gitOk(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(existsSync(join(repo, "other.txt"))).toBe(false);
  });
});

async function twoRepoProject() {
  const api = await mkRepo({ "a.txt": "one\ntwo\nthree\n", "src/x.ts": "x\n" });
  const web = await mkRepo({ "a.txt": "one\ntwo\nthree\n", "ui/y.ts": "y\n" });
  const project: Project = { id: "p1", repos: [{ name: "api", path: api, baseRef: "main" }, { name: "web", path: web, baseRef: "main" }] };
  return { api, web, project };
}

describe("multi-repo project", () => {
  test("one worktree per repo per task, per-repo checks, all ready, no merge", async () => {
    const { api, web, project } = await twoRepoProject();
    const m = mgr();
    const hs = await createProjectWorkspaces(m, project, T);
    expect(hs.map((h) => h.repo)).toEqual(["api", "web"]);
    expect(new Set(hs.map((h) => h.path)).size).toBe(2);
    expect((await createProjectWorkspaces(m, project, T)).map((h) => h.path)).toEqual(hs.map((h) => h.path));
    await writeFile(join(hs[0].path, "src/x.ts"), "x2\n");
    await writeFile(join(hs[1].path, "ui/new.ts"), "n\n");
    const checks = await runProjectChecks(hs, { api: ["test -f src/x.ts"], web: ["test -f ui/new.ts", "echo second"] });
    expect(checks.api.every((c) => c.ok)).toBe(true);
    expect(checks.web.map((c) => c.ok)).toEqual([true, true]);
    const out = await assessProject(project, [
      { handle: hs[0], taskSucceeded: true, allowedScope: ["src"], requireDiff: true, checks: checks.api },
      { handle: hs[1], taskSucceeded: true, allowedScope: ["ui"], requireDiff: true, checks: checks.web },
    ]);
    expect(out.kind).toBe("ready");
    expect(await gitOk(api, ["log", "--oneline", "main"])).not.toContain("deepkode task");
    expect(await gitOk(web, ["log", "--oneline", "main"])).not.toContain("deepkode task");
    const gone = await cleanupProjectTask(m, project, T);
    expect(gone.every((g) => g.removedWorktree && g.removedBranch)).toBe(true);
    expect(existsSync(hs[0].path)).toBe(false);
    expect((await m.list(api)).length + (await m.list(web)).length).toBe(0);
  });

  test("partial failure stops at a human gate listing per-repo state", async () => {
    const { api, web, project } = await twoRepoProject();
    const m = mgr();
    const hs = await createProjectWorkspaces(m, project, T);
    await writeFile(join(hs[0].path, "src/x.ts"), "x2\n");
    await writeFile(join(hs[1].path, "ui/y.ts"), "y2\n");
    const out = await assessProject(project, [
      { handle: hs[0], taskSucceeded: true, allowedScope: ["src"], requireDiff: true },
      { handle: hs[1], taskSucceeded: false, failReason: "turn failed", allowedScope: ["ui"], requireDiff: true },
    ]);
    expect(out.kind).toBe("human-gate");
    if (out.kind !== "human-gate") throw new Error();
    expect(out.repos.map((r) => [r.repo, r.state])).toEqual([["api", "ready"], ["web", "failed"]]);
    expect(out.repos[1].reason).toBe("turn failed");
    expect(out.reason).toContain("no cross-repo merge");
    expect(await gitOk(api, ["rev-parse", "main"])).toBe(hs[0].baseSha); // base untouched
    expect(await gitOk(web, ["rev-parse", "main"])).toBe(hs[1].baseSha);
  });

  test("a conflict in one repo with success in another is a human gate", async () => {
    const { api, web, project } = await twoRepoProject();
    const m = mgr();
    const hs = await createProjectWorkspaces(m, project, T);
    await writeFile(join(hs[0].path, "a.txt"), "one\nTASK\nthree\n");
    await writeFile(join(hs[1].path, "ui/z.ts"), "z\n");
    // base of api moves with a clashing edit after the task started
    await writeFile(join(api, "a.txt"), "one\nMAIN\nthree\n");
    await gitOk(api, ["commit", "-q", "-am", "main moves"]);
    const out = await assessProject(project, [
      { handle: hs[0], taskSucceeded: true, allowedScope: ["a.txt"], requireDiff: true },
      { handle: hs[1], taskSucceeded: true, allowedScope: ["ui"], requireDiff: true },
    ]);
    expect(out.kind).toBe("human-gate");
    expect(out.repos.map((r) => [r.repo, r.state])).toEqual([["api", "conflict"], ["web", "ready"]]);
    expect(out.repos[0].conflictFiles).toEqual(["a.txt"]);
    expect(await gitOk(web, ["rev-parse", "main"])).toBe(hs[1].baseSha);
  });

  test("scope violation and failed checks fail a repo; all failed is 'failed', not a gate", async () => {
    const { project } = await twoRepoProject();
    const m = mgr();
    const hs = await createProjectWorkspaces(m, project, T);
    await writeFile(join(hs[0].path, "outside.txt"), "o");
    await writeFile(join(hs[1].path, "ui/y.ts"), "y2\n");
    const checks = await runProjectChecks(hs, { web: ["exit 1"] });
    const out = await assessProject(project, [
      { handle: hs[0], taskSucceeded: true, allowedScope: ["src"], requireDiff: true },
      { handle: hs[1], taskSucceeded: true, allowedScope: ["ui"], requireDiff: true, checks: checks.web },
    ]);
    expect(out.kind).toBe("failed");
    expect(out.repos[0].reason).toContain("diff outside scope");
    expect(out.repos[1].reason).toContain("check failed");
  });

  test("decideOutcome and duplicate repo names", async () => {
    expect(decideOutcome([{ repo: "a", state: "failed", branch: "b" }]).kind).toBe("failed");
    expect(decideOutcome([{ repo: "a", state: "ready", branch: "b" }]).kind).toBe("ready");
    const { project } = await twoRepoProject();
    const dup: Project = { id: "d", repos: [project.repos[0], project.repos[0]] };
    await expect(createProjectWorkspaces(mgr(), dup, T)).rejects.toThrow("duplicate repo");
  });
});

describe("cleanup", () => {
  test("removeWorkflow removes all worktrees and branches of a workflow only", async () => {
    const repo = await mkRepo();
    const m = mgr();
    await m.create(repo, { workflowId: "wfA", epoch: 1, repo: "api", taskId: "t1" }, "main");
    await m.create(repo, { workflowId: "wfA", epoch: 2, repo: "api", taskId: "t2" }, "main");
    const keep = await m.create(repo, { workflowId: "wfB", epoch: 1, repo: "api", taskId: "t1" }, "main");
    expect(await m.removeWorkflow(repo, "wfA")).toBe(2);
    expect((await m.list(repo)).map((w) => w.path)).toEqual([keep.path]);
    const branches = await gitOk(repo, ["branch", "--list", "dk/*"]);
    expect(branches).toContain("dk/wfB/1/api/t1");
    expect(branches).not.toContain("wfA");
    expect(existsSync(join(keep.path, "a.txt"))).toBe(true);
  });
});
