import type { Evidence } from "./types";

/** Spec C §4.4: success comes from evidence, never from turn status or exit code. */
export function judge(e: Evidence): { ok: boolean; reason: string } {
  if (e.requireDiff && e.diffFiles.length === 0) return { ok: false, reason: "no diff in worktree" };
  const out = e.diffFiles.filter((f) => !e.allowedScope.some((p) => f === p || f.startsWith(p.endsWith("/") ? p : p + "/")));
  if (out.length) return { ok: false, reason: `diff outside scope: ${out.join(", ")}` };
  if (e.requireChecks && e.checksPassed !== true) return { ok: false, reason: "confirmed checks did not pass" };
  if (e.goalComplete === false) return { ok: false, reason: "goal not recorded complete" };
  return { ok: true, reason: "evidence satisfied" };
}
