// [helmsman] D3-4 task-level worktree plugin (internalized into the engine).
// Migration point: worktree.ts is plain Node git functions (no ACP dependency), ported as-is.
// Advantage of the engine form: when the tasks plugin creates a task, meta.cwd uses the worktree path directly,
// so the agent naturally runs in the isolation area (in v1 the server had to swap the cwd and pass it through ACP sessionNew).
// Interface:
//   POST /api/worktree/prepare  {repo, card_id, key} → {path, branch} | {ok:false,reason}
//   POST /api/worktree/merge    {repo, worktree, message} → MergeResult
//   POST /api/worktree/discard  {repo, worktree} → {ok:true}
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'helmsman-worktree'
export const inject = ['webServer']

// ---------- Pure functions: ported as-is from server-ts/worktree.ts ----------

function runGit(repo, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? 10000,
  }).trim()
}

function isGitRepo(cwd) {
  try {
    runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

function sanitize(key) {
  return String(key ?? 'task').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60)
}

function branchName(cardId, key) {
  const k = sanitize(key)
  return `helmsman/${cardId}-${k.slice(0, 20)}`
}

/** Keep the .helmsman directory from polluting the agent's git operations (local exclude). */
function ensureLocalExclude(repo) {
  const info = join(repo, '.git', 'info', 'exclude')
  const line = '\n.helmsman/worktrees/\n'
  try {
    if (existsSync(info)) {
      const cur = readFileSync(info, 'utf8')
      if (!cur.includes('.helmsman/worktrees/')) appendFileSync(info, line)
    }
  } catch { /* ignore */ }
}

/** Prepare the task isolation area: git worktree add -b <branch> <path>. Not a git repo → null (fall back to the shared directory). */
function prepareTaskWorktree(repo, cardId, key) {
  if (!isGitRepo(repo)) {
    console.warn(`[helmsman-worktree] not a git repo, isolation area unavailable (${repo}) —— falling back to the shared project directory`)
    return null
  }
  try {
    runGit(repo, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    console.warn(`[helmsman-worktree] repo has no HEAD (${repo}) —— falling back to the shared project directory`)
    return null
  }
  ensureLocalExclude(repo)
  const branch = branchName(cardId, key)
  const path = join(repo, '.helmsman', 'worktrees', sanitize(key))
  mkdirSync(join(repo, '.helmsman', 'worktrees'), { recursive: true })
  try {
    runGit(repo, ['worktree', 'add', '-b', branch, path], { timeout: 30000 })
  } catch {
    console.warn(`[helmsman-worktree] failed to create the isolation area (${repo}) —— falling back to the shared project directory`)
    return null
  }
  return { path, branch }
}

/** Merge back into the main workspace: add → commit → merge --no-ff. Returns {ok, message}. */
function mergeTaskWorktree(input) {
  const { repo, worktree, message } = input
  try {
    runGit(worktree.path, ['add', '-A'])
    const hasChanges = runGit(worktree.path, ['status', '--porcelain'])
    if (!hasChanges) return { ok: true, message: 'no changes to merge' }
    runGit(worktree.path, ['commit', '-m', message ?? 'helmsman: task worktree merge'], { timeout: 30000 })
    runGit(repo, ['merge', '--no-ff', worktree.branch, '-m', message ?? 'helmsman: merge task worktree'], { timeout: 30000 })
    return { ok: true, message: 'merged' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.split('\n')[0] : String(e) }
  }
}

/** Discard the isolation area: git worktree remove --force. */
function discardTaskWorktree(repo, worktree) {
  try {
    runGit(repo, ['worktree', 'remove', '--force', worktree.path], { timeout: 30000 })
    return true
  } catch {
    return false
  }
}

// ---------- Plugin body: routes ----------

export function apply(ctx) {
  const { webServer } = ctx
  // Internal service: lets helmsman-tasks isolate automatically when creating a task
  ctx.provide('helmsmanWorktree', {
    prepare: (repo, cardId, key) => prepareTaskWorktree(repo, cardId, key),
    discard: (repo, worktree) => discardTaskWorktree(repo, worktree),
    merge: (input) => mergeTaskWorktree(input),
  })
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) reject(new Error('body too large')) })
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })

  webServer.register({
    kind: 'prefix',
    path: '/api/worktree',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        if (pathname === '/api/worktree/prepare') {
          const wt = prepareTaskWorktree(body.repo, body.card_id ?? 'card', body.key ?? 'task')
          if (!wt) return json(res, 200, { ok: false, reason: 'worktree unavailable' })
          return json(res, 201, { ok: true, path: wt.path, branch: wt.branch })
        }
        if (pathname === '/api/worktree/merge') {
          const r = mergeTaskWorktree({ repo: body.repo, worktree: body.worktree, message: body.message })
          return json(res, 200, r)
        }
        if (pathname === '/api/worktree/discard') {
          const ok = discardTaskWorktree(body.repo, body.worktree)
          return json(res, 200, { ok })
        }
        return json(res, 404, { error: 'not found' })
      } catch (e) {
        return json(res, 500, { error: e?.message ?? String(e) })
      }
    },
  })

  console.log('[helmsman-worktree] worktree routes registered: /api/worktree/*')
}

export default { name, inject, apply }
