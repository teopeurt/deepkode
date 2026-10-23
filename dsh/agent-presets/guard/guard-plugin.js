// [helmsman] Command-level allowlist guard (P1) —— a tools/pre-execute listener plugin.
// Mounted inside the guard preset (agent scope): every agent tool call passes through here before dispatch.
// Responsibilities: identify dangerous bash commands + let allowlisted ones through + send dangerous commands for human approval (ask).
// Approval seam: return { kind: 'ask', reason } → dsh-tools serviceAsk → ctx.approval.request
//   → dsh-acp bridge → ACP requestPermission → Helmsman approval queue (Waiting{permission}).
// Note: this plugin persists no memory (each agent session is independent); "idempotent rejection / remember" is handled by policy capture on the Helmsman side.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Only uses built-in node capabilities to avoid dependency-resolution issues: precompiled regexes, pure-function matching.

/** Dangerous-command detection (exact prefix/regex matching). Returns { risk, reason } or null (safe, allowed). */
const DANGER_PATTERNS = [
  // Most dangerous first: rm -rf on the root / home / current directory (must match first so the generic rm rule does not swallow it)
  { re: /(^|\s)rm\s+-[a-zA-Z]*rf[a-zA-Z]*\s+(\/|~)(\s|$)/, risk: 'rm-root', label: 'rm -rf on the root/home directory' },
  { re: /(^|\s)rm\s+-[a-zA-Z]*rf[a-zA-Z]*\s+(\.|\.\/)\s*$/, risk: 'rm-root', label: 'rm -rf on the current directory' },
  // sudo privilege escalation (takes priority over the wrapped dangerous command itself —— reporting "privilege escalation" for sudo rm is more accurate)
  { re: /(^|\s)sudo\s+/, risk: 'sudo', label: 'sudo privilege escalation' },
  // Destructive file deletion: rm -r/-rf combinations (rm -f on a single file is not dangerous)
  { re: /(^|\s)rm\s+-[a-zA-Z]*rf[a-zA-Z]*\s+/, risk: 'rm', label: 'rm recursive/forced delete' },
  { re: /(^|\s)rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/, risk: 'rm', label: 'rm recursive delete' },
  // Dangerous git operations
  { re: /(^|\s)git\s+push(\s|$)/, risk: 'git-push', label: 'git push (push to remote)' },
  { re: /(^|\s)git\s+reset\s+--hard\s+/, risk: 'git-reset-hard', label: 'git reset --hard (discards changes)' },
  { re: /(^|\s)git\s+clean\s+(-[a-zA-Z]*f[a-zA-Z]*\s*)+/, risk: 'git-clean', label: 'git clean -f (deletes untracked files)' },
  { re: /(^|\s)git\s+checkout\s+--\s+/, risk: 'git-checkout-dot', label: 'git checkout -- (discards working-tree changes)' },
  { re: /(^|\s)git\s+branch\s+-D\s+/, risk: 'git-branch-D', label: 'git branch -D (force-deletes a branch)' },
  // Dangerous redirection/overwrite
  { re: /(^|\s)>\s*\/dev\/sd[a-z]/, risk: 'disk-write', label: 'writing directly to a disk device' },
  { re: /(^|\s)mkfs\./, risk: 'mkfs', label: 'formatting a disk' },
  // Dangerous download-and-execute
  { re: /(^|\s)curl\s+.*\|\s*(sh|bash)\s*$/, risk: 'curl-pipe-sh', label: 'curl piped into a shell' },
  { re: /(^|\s)wget\s+.*\|\s*(sh|bash)\s*$/, risk: 'wget-pipe-sh', label: 'wget piped into a shell' },
  // System administration
  { re: /(^|\s)(shutdown|reboot|poweroff|halt)\s*$/, risk: 'sysctl', label: 'shutdown/reboot' },
  { re: /(^|\s)kill\s+-9\s+/, risk: 'kill-9', label: 'kill -9 (force kill)' },
  { re: /(^|\s)chmod\s+777\s+/, risk: 'chmod-777', label: 'chmod 777' },
  { re: /(^|\s)chown\s+-R\s+/, risk: 'chown-R', label: 'chown -R (recursive ownership change)' },
]

/** Safety allowlist: exact forms of otherwise-dangerous commands that are allowed (command-prefix match, so normal operations are not blocked). */
const ALLOW_PREFIXES = [
  'rm -rf /tmp/',      // clean our own temp area
  'rm -rf ./dist',     // clean build output
  'rm -rf dist',       // same as above (without ./)
  'rm -rf node_modules', // reinstall dependencies
  'rm -rf .pnpm-store',
]

/**
 * Match one bash command.
 * @param {string} command the full command (the bash tool's command argument)
 * @returns {{ risk: string, label: string } | null} a description if dangerous, null if safe
 */
export function matchDanger(command) {
  const trimmed = String(command ?? '').trim()
  if (!trimmed) return null
  // Exact allowlist prefixes: let them through first so allowed build cleanups / reinstalls are not flagged as dangerous
  for (const p of ALLOW_PREFIXES) {
    if (trimmed.startsWith(p)) return null
  }
  for (const d of DANGER_PATTERNS) {
    if (d.re.test(trimmed)) {
      return { risk: d.risk, label: d.label }
    }
  }
  return null
}

/** Cordis plugin name. */
export const name = 'helmsman-command-guard'
/** No services to inject: pre-execute is a scoped waterfall event, ctx.on is enough to listen. */
export const inject = []

/** Plugin body: listen to tools/pre-execute; dangerous bash command → ask (human approval). */
export function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => {
    // Only review bash tool calls (other tools such as fs are governed by the sandbox)
    if (exec?.name !== 'bash') return next()
    const command = exec.arguments?.command
    const hit = matchDanger(command)
    if (hit === null) return next()
    // Dangerous command → send for human approval. reason is delivered verbatim to the answerer (shown on the Helmsman approval card).
    return {
      kind: 'ask',
      reason: `Command-level allowlist: detected "${hit.label}" (risk ${hit.risk}). Command: ${String(command).slice(0, 200)}`,
    }
  })
}

export default { name, inject, apply }
