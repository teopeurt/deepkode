// [helmsman] D3-6 acceptance gate (migration of the engine evidence/verify modules).
// Task Done and the card has acceptance criteria → run the acceptance command + take a git snapshot of the workspace,
// producing AcceptanceEvidence so a human can see "what changed" before deciding to merge or send it back.
//   - Project default profile.setting === 'delivery' and approval !== 'yolo' → suspend with an acceptance approval
//   - Otherwise → merge the worktree directly (v1 behavior)
// Migrated from: server-ts/src/evidence.ts + verify.ts (plain Node functions, no ACP dependency).
import { exec, execFileSync } from 'node:child_process'

export const name = 'helmsman-acceptance'
export const inject = ['agents', 'sessions', 'helmsmanBoard', 'helmsmanStorage', 'helmsmanWorktree', 'webServer']

// ---------- Pure functions: ported as-is from server-ts/evidence.ts + verify.ts ----------

const GIT_OPTS = { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, ...GIT_OPTS }).trim()
}
function tryGit(cwd, args) {
  try { return runGit(cwd, args) } catch { return '' }
}

/** Workspace diff snapshot (git status --porcelain + diff --stat HEAD). */
function collectWorkspaceDiff(cwd) {
  try {
    runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch (e) {
    return { dirty: false, files: [], stat: '', error: (e?.message ?? String(e)).split('\n')[0] }
  }
  const porcelain = tryGit(cwd, ['status', '--porcelain'])
  const files = porcelain.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40)
  const stat = tryGit(cwd, ['diff', '--stat', 'HEAD']) || tryGit(cwd, ['diff', '--stat'])
  return { dirty: files.length > 0, files, stat: stat.slice(0, 800) }
}

/** Acceptance evidence: setting + criteria + verify result + workspace diff + worktree. */
function buildAcceptanceEvidence({ cwd, criteria, verify, worktree }) {
  return {
    setting: 'delivery',
    criteria: criteria ?? null,
    verify: verify ?? null,
    diff: collectWorkspaceDiff(cwd),
    worktree: worktree ?? null,
  }
}

/** The one-line summary shown on the approval bar. */
function acceptanceReason(ev) {
  if (ev.verify?.verified === true) return 'Delivery setting: the acceptance command passed; review the changes and merge'
  if (ev.verify?.verified === false) return 'Delivery setting: the acceptance command failed; decide whether to send it back or merge anyway'
  if (ev.verify?.error) return `Delivery setting: the acceptance command could not run (${ev.verify.error}); review the changes and accept manually`
  return 'Delivery setting: task complete; review the changes for acceptance (merge the knowledge if it passes)'
}

/** Run the acceptance command: exit code 0 = passed; timeout / could not run = null (undecidable). */
function runAcceptance(cwd, command, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const started = Date.now()
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started
      const tail = (stdout + stderr).trim().slice(-400)
      if (error) {
        const code = error.code
        if (typeof code === 'number') {
          resolve({ verified: false, exitCode: code, durationMs, outputTail: tail })
        } else if (error.killed) {
          resolve({ verified: null, exitCode: null, durationMs, outputTail: tail, error: `timeout after ${timeoutMs}ms` })
        } else {
          resolve({ verified: null, exitCode: null, durationMs, outputTail: tail, error: error.message })
        }
        return
      }
      resolve({ verified: true, exitCode: 0, durationMs, outputTail: tail })
    })
  })
}

// ---------- Plugin body ----------

export function apply(ctx) {
  const board = ctx.get('helmsmanBoard')
  const storage = ctx.get('helmsmanStorage')?.storage
  const worktree = ctx.get('helmsmanWorktree')
  const gated = new Set() // (sid, turn) pairs that already went through the acceptance gate, to prevent duplicates

  /** Get the task's execution state from the projection. */
  const getExecution = (sid) => {
    const pid = board?.projection?.sessionProject?.[sid]
    if (!pid) return null
    const cardId = board?.projection?.sessionCard?.[sid]
    const proj = board?.projection?.projects?.[pid]
    if (!proj) return null
    const t = cardId ? proj.cards?.[cardId]?.executions?.[sid] : proj.chats?.[sid]
    if (!t) return null
    return { pid, cardId, proj, t, card: cardId ? proj.cards?.[cardId] : undefined }
  }

  /** Acceptance gate: task Done + card has criteria → run acceptance + collect evidence → suspend for acceptance or merge directly. */
  async function runGate(sid) {
    const found = getExecution(sid)
    if (!found) return null
    const { pid, cardId, proj, t, card } = found
    if (!cardId || !card) return null // card executions only (chats have no acceptance gate)
    // Run directory: the worktree isolation area if present, otherwise the project directory
    const runCwd = t.worktree?.path ?? proj.path
    const criteria = card.criteria ?? null
    // The project's default profile decides whether to suspend for acceptance (v1: preset.setting === 'delivery' && approval !== 'yolo')
    const prof = storage?.defaultProfile(pid)
    const hang = prof?.setting === 'delivery' && prof?.approval !== 'yolo'
    // Only run the acceptance command if there are acceptance criteria; no criteria → a human reviews the changes directly
    const verify = criteria ? await runAcceptance(runCwd, criteria) : null
    const evidence = buildAcceptanceEvidence({ cwd: runCwd, criteria, verify, worktree: t.worktree })
    if (hang) {
      const reason = acceptanceReason(evidence)
      // Suspend: the task pauses awaiting a decision (the projection's waiting keeps the post-Done waiting state)
      t.waiting = { kind: 'acceptance', reason, payload: evidence }
      if (storage) {
        storage.insertApproval({
          project_id: pid, execution_id: sid, kind: 'acceptance',
          payload: evidence, reason, outcome: null, comment: null, created_at: Date.now(),
        })
      }
      console.log(`[helmsman-acceptance] acceptance suspended ${sid} criteria=${criteria ? 'yes' : 'no'} verify=${verify?.verified ?? 'n/a'} files=${evidence.diff.files.length}`)
      return { gated: true, reason }
    }
    // Not delivery / yolo: merge straight back into the main workspace
    if (t.worktree && worktree) {
      const mr = worktree.merge({ repo: proj.path, worktree: t.worktree, message: `helmsman: ${card.title}` })
      if (mr.ok) {
        t.worktree = null
        console.log(`[helmsman-acceptance] auto-merged ${sid} (not a delivery setting)`)
      } else {
        console.warn(`[helmsman-acceptance] merge failed ${sid}: ${mr.message}`)
      }
    }
    return { gated: false }
  }

  // Listen for task Done (same event source as the KB auto-capture)
  ctx.on('session/event', (session, event) => {
    if (!session?.id || event?.type !== 'turn/end') return
    const sid = session.id
    const key = `${sid}:${event.data?.turn}`
    if (gated.has(key)) return
    const found = getExecution(sid)
    if (!found || !found.cardId) return
    if (found.t.status !== 'Done') return
    // Only trigger the acceptance gate if the task actually did something (has Text output)
    const texts = (found.t.activities ?? []).filter((a) => 'Text' in a)
    if (texts.length === 0) return
    gated.add(key)
    void runGate(sid).catch((e) => console.error('[helmsman-acceptance] acceptance gate failed:', e?.message ?? e))
  })

  // Decision: POST /api/approvals/:id is handled by helmsman-approval; this provides the merge service it calls
  ctx.provide('helmsmanAcceptance', {
    /** Approve → merge the worktree (called by the approval plugin when deciding). */
    approveMerge(sid) {
      const found = getExecution(sid)
      if (!found?.t?.worktree || !worktree) return { ok: false, message: 'no worktree' }
      const mr = worktree.merge({
        repo: found.proj.path,
        worktree: found.t.worktree,
        message: `helmsman: ${found.card?.title ?? sid}`,
      })
      if (mr.ok) {
        found.t.worktree = null
        found.t.waiting = null
      }
      return mr.ok ? { ok: true } : { ok: false, message: mr.message }
    },
    /** Reject → clear the waiting state (no merge; the worktree is kept for manual handling). */
    rejectClear(sid) {
      const found = getExecution(sid)
      if (found?.t) found.t.waiting = null
      return { ok: true }
    },
    /** Test hook: trigger the acceptance gate manually (for API probing). */
    runGate,
  })

  console.log('[helmsman-acceptance] acceptance gate mounted (Done → verify + evidence → suspend/merge)')
}

export default { name, inject, apply }
