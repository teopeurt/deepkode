import { judge } from "../evidence";
import { git } from "./git";

/**
 * Changed paths in `workspace` relative to `baseRef`: committed and uncommitted changes to tracked
 * files, plus untracked files (not ignored). Renames are listed as delete plus add. Sorted, unique.
 */
export async function collectDiff(workspace: string, baseRef: string): Promise<string[]> {
  const t = await git(workspace, ["diff", "--name-only", "--no-renames", "-z", baseRef, "--"]);
  if (t.code !== 0) throw new Error(`collectDiff failed: ${t.stderr.trim()}`);
  const u = await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (u.code !== 0) throw new Error(`collectDiff failed: ${u.stderr.trim()}`);
  const all = [...t.stdout.split("\0"), ...u.stdout.split("\0")].filter((s) => s.length > 0);
  return [...new Set(all)].sort();
}

/** Adapter matching RunDeps.collectDiff: `(workspace) => Promise<string[]>`. */
export function collectDiffAgainst(baseRef: string): (workspace: string) => Promise<string[]> {
  return (workspace) => collectDiff(workspace, baseRef);
}

/** Scope enforcement with the same semantics as evidence.judge (prefix match on path segments). */
export function enforceScope(diffFiles: string[], allowedScope: string[], requireDiff = false): { ok: boolean; reason: string } {
  return judge({ diffFiles, allowedScope, requireDiff, requireChecks: false });
}
