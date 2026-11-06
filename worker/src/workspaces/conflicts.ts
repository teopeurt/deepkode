import { git, gitOk } from "./git";

export interface BranchConflict {
  branch: string;
  conflicted: boolean;
  files: string[];
}

/**
 * Dry-run merge of task branches against `target` using `git merge-tree --write-tree`.
 * Branches are folded in order; a clean branch is added to the accumulated result so a later
 * branch is checked against earlier ones too. A conflicting branch is reported and left out of
 * the accumulation. No ref, index, or working tree is modified (only unreferenced objects are
 * written to the object database, which git gc removes).
 */
export async function detectConflicts(repoPath: string, target: string, branches: string[]): Promise<BranchConflict[]> {
  let acc = await gitOk(repoPath, ["rev-parse", "--verify", `${target}^{commit}`]); // accumulated result, as a commit
  const out: BranchConflict[] = [];
  for (const branch of branches) {
    const base = await gitOk(repoPath, ["merge-base", target, branch]);
    const r = await git(repoPath, ["merge-tree", "--write-tree", "--name-only", `--merge-base=${base}`, acc, branch]);
    if (r.code === 0) {
      // merge-tree needs commits on both sides, so wrap the merged tree in an unreferenced commit.
      const tree = r.stdout.split("\n")[0].trim();
      acc = await gitOk(repoPath, ["-c", "user.name=deepkode", "-c", "user.email=worker@deepkode.invalid", "commit-tree", tree, "-p", acc, "-m", "dry-run"]);
      out.push({ branch, conflicted: false, files: [] });
    } else if (r.code === 1 && r.stdout.trim() !== "") {
      const lines = r.stdout.split("\n");
      const files: string[] = [];
      for (const l of lines.slice(1)) {
        if (l === "") break; // blank line ends the file list; messages follow
        files.push(l);
      }
      out.push({ branch, conflicted: true, files: [...new Set(files)] });
    } else {
      throw new Error(`git merge-tree failed (${r.code}): ${r.stderr.trim()}`);
    }
  }
  return out;
}
