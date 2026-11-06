import { spawn } from "node:child_process";

export interface CheckResult {
  command: string;
  exitCode: number | null; // null when killed by timeout or signal
  timedOut: boolean;
  ok: boolean;
  /** Combined stdout and stderr, trimmed to the last `maxOutput` characters. */
  output: string;
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** Spec C §6: no credentials in the task environment. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) env[k] = v;
  return env;
}

/** Runs `command` through `sh -c` in `cwd` with a timeout. The whole process group is killed on timeout. */
export function runCheck(cwd: string, command: string, opts: { timeoutMs?: number; maxOutput?: number } = {}): Promise<CheckResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxOutput = opts.maxOutput ?? 4000;
  return new Promise((resolve) => {
    let buf = "";
    let timedOut = false;
    const child = spawn("sh", ["-c", command], { cwd, env: scrubbedEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > maxOutput * 4) buf = buf.slice(-maxOutput * 2);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      const output = buf.trim();
      resolve({
        command,
        exitCode,
        timedOut,
        ok: exitCode === 0 && !timedOut,
        output: output.length > maxOutput ? "..." + output.slice(-maxOutput) : output,
      });
    };
    child.on("error", (e) => { buf += String(e); finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/** Runs commands in order, stopping at the first failure. */
export async function runChecks(cwd: string, commands: string[], opts: { timeoutMs?: number; maxOutput?: number } = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of commands) {
    const r = await runCheck(cwd, c, opts);
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}
