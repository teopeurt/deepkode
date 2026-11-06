import { execFile } from "node:child_process";

export interface GitResult { code: number; stdout: string; stderr: string }

/** Runs git without a shell. Never throws on non-zero exit; throws only if git cannot start. */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } },
      (err, stdout, stderr) => {
        const c = (err as { code?: unknown } | null)?.code;
        if (err && typeof c !== "number") return reject(err);
        resolve({ code: err ? (c as number) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Like git() but throws with stderr on failure. Returns trimmed stdout. */
export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout.trim();
}
