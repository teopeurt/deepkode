// [helmsman] Persistence plugin: SQLite metadata (ported from v1 storage.ts) + projection rebuild at startup (ported from v1 recovery.ts).
// Responsibilities:
//   1. Own the Storage (better-sqlite3): persist projects/cards/execution snapshots/settings/KB/metrics/approvals/profiles/policies
//   2. At startup, replay the JSONL session logs (recoverStore) to rebuild the projection → inject it into helmsmanBoard
//   3. Provide the helmsmanStorage service: lets helmsman-api/kb/approval and other plugins read/write persisted data
// DB path: the HELMSMAN_DB env var or dsh/.helmsman.db (inside the engine process).
import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { Storage } from './helmsman-storage.js'
import {
  newProjection,
  newTaskState,
  ensureProject,
  ensureCard,
  registerSession,
  foldSession,
} from './helmsman-projection.js'

export const name = 'helmsman-persist'
export const inject = ['sessions', 'helmsmanBoard']

export function apply(ctx) {
  const dbPath = process.env.HELMSMAN_DB ?? resolve(process.cwd(), '.helmsman.db')
  const sessionsRoot = process.env.HELMSMAN_SESSIONS_ROOT ?? resolve(process.cwd(), '.sessions')
  const storage = new Storage(dbPath)
  const board = ctx.get('helmsmanBoard')
  console.log(`[helmsman-persist] SQLite ready: ${dbPath}`)

  // ---------- Rebuild the projection at startup (v1 recovery.ts semantics) ----------
  const proj = newProjection()

  // Load projects from SQLite → build the projection
  for (const p of storage.loadProjects()) {
    ensureProject(proj, p.id, p.name, p.path)
  }
  // Load cards from SQLite → create the cards
  for (const c of storage.loadAllCards()) {
    ensureCard(proj, c.project_id, {
      id: c.id,
      title: c.title,
      description: c.description,
      kind: c.kind,
      milestone: c.milestone,
      criteria: c.criteria,
      deps: c.deps ?? [],
      budget: c.budget ?? null,
      created_at: c.created_at,
    })
  }
  // Executions → session→card mapping (the authoritative mapping for restart recovery)
  const cardOfSession = new Map()
  for (const e of storage.loadAllExecutions()) {
    const card = storage.getCard(e.card_id)
    cardOfSession.set(e.id, {
      projectId: card?.project_id ?? 'default',
      meta: { id: e.card_id, title: '', description: '', kind: 'task', milestone: null, criteria: null, deps: [], created_at: e.created_at },
      executionCreatedAt: e.created_at,
    })
  }

  // Replay the JSONL session logs to rebuild the projection (semantics such as interrupted Running → Failed match v1)
  let restored = 0
  try {
    const result = recoverStore(sessionsRoot, proj, null, cardOfSession)
    restored = result.restored
  } catch (e) {
    console.warn(`[helmsman-persist] startup replay failed (ignored, continuing):`, e?.message ?? e)
  }

  // Restore simple chats (matches v1 index.ts 275-290): sessions flagged in chat_sessions
  // are moved from implicit cards into the project's chats (standalone chats stay off the board), and the projection mapping is fixed up.
  for (const pid of Object.keys(proj.projects)) {
    const p0 = proj.projects[pid]
    for (const sid of storage.listChats(pid)) {
      const cardId = proj.sessionCard[sid]
      const t = cardId ? p0.cards[cardId]?.executions[sid] : p0.chats[sid]
      if (!t) continue
      if (cardId) {
        const card = p0.cards[cardId]
        if (card) {
          delete card.executions[sid]
          card.exec_order = card.exec_order.filter((x) => x !== sid)
          // The implicit card of a chat session (empty execs = it only hosted this session) is removed unconditionally
          if (card.exec_order.length === 0) delete p0.cards[cardId]
        }
        p0.chats[sid] = t
        proj.sessionCard[sid] = ''
      }
    }
  }

  // Merge the recovered projection into the board (including folded execution state, so Done/Running etc. are not lost)
  for (const [id, p] of Object.entries(proj.projects)) {
    board.ensureProject(id, p.name, p.path)
    for (const [cid, c] of Object.entries(p.cards)) {
      board.ensureCard(id, {
        id: cid, title: c.title, description: c.description, kind: c.kind,
        milestone: c.milestone, criteria: c.criteria, deps: c.deps ?? [],
        budget: c.budget ?? null, created_at: c.created_at,
      })
    }
  }
  for (const [sid, pid] of Object.entries(proj.sessionProject)) {
    board.registerSession(sid, pid, proj.sessionCard[sid] ?? '')
  }
  // Copy the folded TaskState (the board's registerSession only creates an empty shell; overwrite it with the recovered values here)
  const boardProj = board.projection
  for (const [sid, pid] of Object.entries(proj.sessionProject)) {
    const cardId = proj.sessionCard[sid]
    const srcProj = proj.projects[pid]
    if (!srcProj) continue
    let srcTask
    if (cardId) srcTask = srcProj.cards[cardId]?.executions?.[sid]
    else srcTask = srcProj.chats?.[sid]
    if (!srcTask) continue
    const dstProj = boardProj.projects[pid]
    if (!dstProj) continue
    let dstTask
    if (cardId) {
      const dstCard = dstProj.cards[cardId]
      if (!dstCard) continue
      dstTask = dstCard.executions[sid] ?? (dstCard.executions[sid] = dstCard.executions[sid] || board.registerSession(sid, pid, cardId), dstCard.executions[sid])
    } else {
      dstTask = dstProj.chats[sid] ?? (dstProj.chats[sid] = newTaskState(sid))
    }
    if (dstTask) Object.assign(dstTask, srcTask)
  }
  console.log(`[helmsman-persist] projection rebuilt: ${Object.keys(proj.projects).length} projects, ${restored} sessions replayed`)

  // Provide the service: lets helmsman-api/kb/approval and other plugins read/write persisted data
  ctx.provide('helmsmanStorage', {
    get storage() { return storage },
  })

  // Note: persisting metadata for new sessions is each business plugin's job (api upserts when creating projects/cards; board upserts execution snapshots after folding)
  console.log('[helmsman-persist] persistence service provided: helmsmanStorage')
}

// ---------- Migration of recoverStore from v1 recovery.ts (TS→JS) ----------

/** Replay .sessions/ to rebuild the projection. Returns the number of recovered sessions. */
function recoverStore(root, proj, defaultProject, cardOfSession) {
  const eventsBySid = new Map()
  const regs = []
  const implicitCards = new Map()
  let restored = 0

  for (const file of walk(root)) {
    const { headerCwd, headerId, headerCreated, events } = readLog(file)
    const sessionId = headerId ?? basename(dirname(file))
    if (!sessionId || events.length === 0) continue

    const cwd = (headerCwd ?? '').replace(/\/+$/, '')
    const rcHint = cardOfSession.get(sessionId)
    let projectId
    if (rcHint) {
      projectId = rcHint.projectId
    } else {
      projectId = projectIdForSessionCwd(cwd, sessionId, Object.values(proj.projects).map((p) => ({ id: p.id, path: p.path })), defaultProject)
    }
    const repoCwd = repoRootFromCwd(cwd)
    const name = basename(repoCwd) || projectId
    if (!proj.projects[projectId]) {
      ensureProject(proj, projectId, name, repoCwd || cwd)
    }

    let cardId
    let createdAt
    const rc = cardOfSession.get(sessionId)
    if (rc) {
      cardId = rc.meta.id
      createdAt = rc.executionCreatedAt
    } else {
      cardId = sessionId
      implicitCards.set(cardId, projectId)
      createdAt = headerCreated ?? 0
    }
    regs.push({ sid: sessionId, projectId, cardId, createdAt })
    eventsBySid.set(sessionId, events)
    restored += 1
  }

  // Sessions that have an execution record but no log this time: the card still goes on the board, with the execution as a Pending placeholder.
  for (const [sid, rc] of cardOfSession) {
    if (!eventsBySid.has(sid)) {
      regs.push({ sid, projectId: rc.projectId, cardId: rc.meta.id, createdAt: rc.executionCreatedAt })
    }
  }

  // Sort by (card, creation time) → registration order = execution generation order (deterministic).
  regs.sort((a, b) => (a.cardId === b.cardId ? a.createdAt - b.createdAt : a.cardId < b.cardId ? -1 : 1))
  for (const r of regs) {
    const rc = cardOfSession.get(r.sid)
    if (rc) {
      ensureCard(proj, rc.projectId, rc.meta)
      registerSession(proj, r.sid, rc.projectId, rc.meta.id)
    } else {
      ensureCard(proj, r.projectId, {
        id: r.cardId, title: '', description: '', kind: 'task',
        milestone: null, criteria: null, deps: [], created_at: r.createdAt,
      })
      registerSession(proj, r.sid, r.projectId, r.cardId)
    }
  }

  // Fold the events (foldSession matches the official behavior: text is only taken from assistant/message,
  // chunk/text-chunks are intermediate states and not accumulated; live and replay take the same path).
  for (const [sid, events] of eventsBySid) {
    for (const ev of events) foldSession(proj, sid, ev)
    const cardId = proj.sessionCard[sid]
    const pid = proj.sessionProject[sid]
    const card = pid ? proj.projects[pid]?.cards[cardId] : undefined
    const t = card?.executions[sid]
    if (t) {
      t.recovered = true
      if (implicitCards.has(cardId) && !card.title) {
        card.title = t.title ?? sid
      }
      // Interruption detection: still Running after recovery → the previous process was interrupted; mark as Failed
      if (t.status === 'Running') {
        const lastEvent = events[events.length - 1]
        const lastTime = lastEvent && typeof lastEvent.time === 'number'
          ? lastEvent.time
          : typeof lastEvent?.time0 === 'number' ? lastEvent.time0 : Date.now()
        t.status = 'Failed'
        t.finished_at = lastTime
      }
    }
  }

  return { restored, offsets: new Map() }
}

/** Session cwd → project id (an isolation area is mapped back to the repo root, then matched against known projects / the seed project). */
function projectIdForSessionCwd(cwd, sessionId, known, defaultProject) {
  const root = repoRootFromCwd(cwd)
  if (defaultProject && root && root === defaultProject[1].replace(/\/+$/, '')) return defaultProject[0]
  let best = null
  for (const p of known) {
    const pp = repoRootFromCwd(p.path).replace(/\/+$/, '')
    if (!pp) continue
    if (root === pp || root.startsWith(`${pp}/`)) {
      if (!best || pp.length > best.pathLen) best = { id: p.id, pathLen: pp.length }
    }
  }
  if (best) return best.id
  if (!cwd || isTaskWorktreePath(cwd)) return sessionId
  return basename(root) || sessionId
}

/** Read one session.jsonl: header + event list. */
function readLog(file) {
  const events = []
  let headerCwd, headerId, headerCreated
  let first = true
  try {
    const size = statSync(file).size
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, 4 << 20))
      const n = readSync(fd, buf, 0, buf.length, 0)
      const text = buf.subarray(0, n).toString('utf8')
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try {
          const v = JSON.parse(line)
          if (first) {
            first = false
            headerCwd = typeof v.cwd === 'string' ? v.cwd : undefined
            headerId = typeof v.id === 'string' ? v.id : undefined
            headerCreated = typeof v.createdAt === 'number' ? v.createdAt : undefined
            continue
          }
          if (v.seq === undefined && v.seq0 === undefined) continue
          events.push(v)
        } catch { /* skip bad lines */ }
      }
    } finally { closeSync(fd) }
  } catch { /* unreadable file → empty */ }
  return { headerCwd, headerId, headerCreated, events }
}

function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    } catch { continue }
    for (const e of entries) {
      const p = resolve(d, e.name)
      if (e.isDir) stack.push(p)
      else if (e.name === 'session.jsonl') out.push(p)
    }
  }
  return out
}

/** Map a worktree path back to the git repository root. */
function repoRootFromCwd(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return cwd
  }
}

/** Worktree path detection (under .helmsman/worktrees/). */
function isTaskWorktreePath(p) {
  return typeof p === 'string' && p.includes('.helmsman') && p.includes('worktrees')
}

export default { name, inject, apply }
