// [helmsman] B1 business API plugin: projects/cards/chats routes (reads the helmsmanBoard projection).
// Compatible with the v1 server-ts frontend contract (web/src/api/client.ts + store/projection.ts).
// Data source: helmsmanBoard projection (folded live from session/event); no separate persistence (in-memory during B1).
// Endpoints:
//   GET  /api/projects                 → [{id,name,path,card_count,counts}]
//   POST /api/projects                 {name,path} → {id}
//   GET  /api/projects/:pid            → {id,name,path,cards:{<cardId>:CardState}}
//   GET  /api/projects/:pid/cards      → CardSummary[]
//   POST /api/projects/:pid/cards      {title,...} → {card_id}
//   GET  /api/cards/:cardId            → CardDetail (includes all executions)
//   GET  /api/tasks/:sid               → TaskState (execution/session state)
//   GET  /api/chats/:sid               → TaskState (simple chat)
//   GET  /api/projects/:pid/chats      → ChatSummary[]
import { execSync, execFileSync } from 'node:child_process'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'

// ---------- Execution-economics pricing (D3-7: server-ts/pricing.ts ported as-is + weekday fix) ----------
// DeepSeek V4 peak/off-peak pricing: peak = Beijing time Mon–Fri 9:00–12:00 ∪ 14:00–18:00,
// everything else (including all of the weekend) is off-peak; off-peak = half the peak price.
// CNY per million tokens; reasoning is not priced separately → approximated with the output price.
const PRICE_PEAK = {
  flash: { input: 3.0, output: 9.0, cacheRead: 0.1, reasoning: 9.0 },
  pro: { input: 9.0, output: 27.0, cacheRead: 0.3, reasoning: 27.0 },
}
const PRICE_OFFPEAK = {
  flash: { input: 1.5, output: 4.5, cacheRead: 0.05, reasoning: 4.5 },
  pro: { input: 4.5, output: 13.5, cacheRead: 0.15, reasoning: 13.5 },
}
/** Peak check: Mon–Fri (getUTCDay 1–5) and 9:00–12:00 ∪ 14:00–18:00 (Beijing time) */
function isPeakHour(now = new Date()) {
  // Beijing time = UTC+8: shift the instant by 8 hours, then read weekday/hour in UTC
  const bj = new Date(now.getTime() + 8 * 3600 * 1000)
  const day = bj.getUTCDay() // 0=Sunday … 6=Saturday
  if (day === 0 || day === 6) return false // weekends are off-peak all day
  const h = bj.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}
function priceOf(model, now = new Date()) {
  const tier = model && String(model).toLowerCase().includes('pro') ? 'pro' : 'flash'
  return isPeakHour(now) ? PRICE_PEAK[tier] : PRICE_OFFPEAK[tier]
}
function estCostFrom(usage, price) {
  return (
    ((usage?.inputTokens ?? 0) / 1e6) * price.input +
    ((usage?.outputTokens ?? 0) / 1e6) * price.output +
    ((usage?.cacheReadTokens ?? 0) / 1e6) * price.cacheRead +
    ((usage?.reasoningTokens ?? 0) / 1e6) * price.reasoning
  )
}

export const name = 'helmsman-api'
export const inject = ['webServer', 'helmsmanBoard', 'helmsmanTasks', 'helmsmanStorage', 'sessionTitle', 'sessions', 'agents']

export function apply(ctx) {
  const { webServer } = ctx
  const board = ctx.get('helmsmanBoard')
  const tasks = ctx.get('helmsmanTasks')
  const storage = ctx.get('helmsmanStorage')?.storage
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
  // Project profiles (P0 §2.6 three-axis combination; persisted in SQLite)
  const ensureBuiltins = (pid) => {
    if (storage) storage.seedProfiles(pid)
    return storage ? storage.listProfiles(pid) : []
  }
  const getProject = (pid) => board.projection.projects[pid]
  const getTask = (sid) => {
    const pid = board.projection.sessionProject[sid]
    if (!pid) return undefined
    const cardId = board.projection.sessionCard[sid]
    const proj = board.projection.projects[pid]
    if (!proj) return undefined
    if (cardId) return proj.cards[cardId]?.executions[sid]
    return proj.chats[sid]
  }
  /** Status counts [Pending, Running, Done, Failed, Cancelled] (by each card's latest execution status) */
  const countStatus = (p) => {
    const counts = [0, 0, 0, 0, 0]
    const idx = { Pending: 0, Running: 1, Done: 2, Failed: 3, Cancelled: 4 }
    for (const card of Object.values(p.cards)) {
      const order = card.exec_order.length ? card.exec_order : Object.keys(card.executions)
      const sid = order[order.length - 1]
      const exec = sid ? card.executions[sid] : undefined
      if (exec && idx[exec.status] !== undefined) counts[idx[exec.status]] += 1
    }
    return counts
  }

  // GET /api/projects —— project list
  webServer.register({
    kind: 'exact',
    path: '/api/projects',
    handler: (req, res) => {
      if (req.method === 'GET') {
        const list = Object.values(board.projection.projects).map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          card_count: Object.keys(p.cards).length,
          counts: countStatus(p),
        }))
        return json(res, 200, list)
      }
      if (req.method === 'POST') {
        return (async () => {
          try {
            const body = await readBody(req)
            if (!body.name || !body.path) return json(res, 400, { error: 'name and path required' })
            const pathNorm = String(body.path).trim().replace(/\/+$/, '')
            const name = String(body.name).trim()
            // Removal is recoverable: re-importing the same directory → unarchive + reuse the original id (v1 semantics)
            const archived = storage ? storage.findArchivedProject(pathNorm) : undefined
            let isRestored = false
            if (archived) {
              if (storage) storage.unarchiveProject(archived.id)
              isRestored = true
            }
            const pid = archived?.id ?? body.id ?? `p-${Date.now().toString(36)}`
            board.ensureProject(pid, name, pathNorm)
            if (storage) storage.upsertProject(pid, name, pathNorm, '{}')
            console.log(`[helmsman-api] project ${pid} ${isRestored ? 'restored (archive)' : 'created'} name=${name} path=${pathNorm}`)
            json(res, 201, { id: pid, name, path: pathNorm, restored: isRestored })
          } catch (e) {
            json(res, 500, { error: e?.message ?? String(e) })
          }
        })()
      }
      return json(res, 405, { error: 'method not allowed' })
    },
  })

  // /api/projects/:pid —— project detail/delete
  webServer.register({
    kind: 'prefix',
    path: '/api/projects',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const detail = pathname.match(/^\/api\/projects\/([^/]+)$/)
      if (detail && req.method === 'GET') {
        const p = getProject(decodeURIComponent(detail[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        return json(res, 200, { id: p.id, name: p.name, path: p.path, cards: p.cards })
      }
      if (detail && req.method === 'DELETE') {
        const pid = decodeURIComponent(detail[1])
        const p = getProject(pid)
        if (!p) return json(res, 404, { error: 'project not found' })
        try {
          const body = await readBody(req)
          const mode = body.mode === 'purge' ? 'purge' : 'archive'
          board.removeProject(pid)
          if (storage) {
            if (mode === 'purge') {
              storage.purgeProject(pid)
              storage.markDeleted(pid)
            } else {
              storage.archiveProject(pid)
            }
          }
          console.log(`[helmsman-api] project ${pid} removed (${mode}) path=${p.path}`)
          return json(res, 200, { ok: true, mode, sessions: 0 })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // GET /api/projects/:pid/cards —— card list (lightweight)
      const cards = pathname.match(/^\/api\/projects\/([^/]+)\/cards$/)
      if (cards && req.method === 'GET') {
        const p = getProject(decodeURIComponent(cards[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        const list = Object.values(p.cards).map((c) => {
          const order = c.exec_order.length ? c.exec_order : Object.keys(c.executions)
          const sid = order[order.length - 1]
          const exec = sid ? c.executions[sid] : undefined
          return {
            id: c.id,
            title: c.title,
            description: c.description ?? '',
            kind: c.kind ?? 'task',
            milestone: c.milestone,
            execution_count: order.length,
            created_at: c.created_at,
            latest: exec ? {
              session_id: sid,
              status: exec.status,
              title: exec.title ?? null,
              started_at: exec.started_at ?? null,
              finished_at: exec.finished_at ?? null,
            } : null,
          }
        })
        return json(res, 200, list)
      }
      // POST /api/projects/:pid/cards —— create card (asset) + first-generation execution (a new card runs automatically)
      if (cards && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const p = getProject(decodeURIComponent(cards[1]))
          if (!p) return json(res, 404, { error: 'project not found' })
          const cardId = body.id ?? `c-${Date.now().toString(36)}`
          const created = Date.now()
          board.ensureCard(p.id, {
            id: cardId,
            title: body.title ?? '(untitled)',
            description: body.description ?? '',
            kind: body.kind ?? 'task',
            milestone: body.milestone ?? null,
            criteria: body.criteria ?? null,
            deps: body.deps ?? [],
            created_at: created,
          })
          if (storage) storage.upsertCard({
            id: cardId, project_id: p.id, title: body.title ?? '(untitled)',
            description: body.description ?? '', kind: body.kind ?? 'task',
            milestone: body.milestone ?? null, criteria: body.criteria ?? null,
            deps: body.deps ?? [], budget: body.budget ?? null, created_at: created,
          })
          return json(res, 201, { card_id: cardId })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // GET /api/projects/:pid/chats/archived —— archived chat list (includes data for the restore entry point)
      const chatsArch = pathname.match(/^\/api\/projects\/([^/]+)\/chats\/archived$/)
      if (chatsArch && req.method === 'GET') {
        const p = getProject(decodeURIComponent(chatsArch[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        const list = Object.values(p.chats)
          .filter((t) => t.archived)
          .map((t) => ({
            session_id: t.id,
            title: t.title ?? null,
            status: t.status,
            started_at: t.started_at ?? null,
            finished_at: t.finished_at ?? null,
          }))
        return json(res, 200, list)
      }
      // GET/POST /api/projects/:pid/chats —— simple chat list/create
      const chats = pathname.match(/^\/api\/projects\/([^/]+)\/chats$/)
      if (chats && req.method === 'GET') {
        const p = getProject(decodeURIComponent(chats[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        // The list only shows unarchived chats (the archived flag is set by the archive endpoint)
        const list = Object.values(p.chats)
          .filter((t) => !t.archived)
          .map((t) => ({
            session_id: t.id,
            title: t.title ?? null,
            status: t.status,
            started_at: t.started_at ?? null,
            finished_at: t.finished_at ?? null,
          }))
        return json(res, 200, list)
      }
      if (chats && req.method === 'POST') {
        const p = getProject(decodeURIComponent(chats[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        try {
          // Simple chat: create an agent with no initial instruction (sendBrief=false, wait for the user's first input)
          const { sid } = await tasks.createTask({
            cwd: p.path,
            brief: undefined,
            sendBrief: false,
            project_id: p.id,
            card_id: undefined,
          })
          return json(res, 201, { session_id: sid })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/projects/:pid/approvals/resume-all —— bulk resume (B1 simplification: ok)
      const resumeAll = pathname.match(/^\/api\/projects\/([^/]+)\/approvals\/resume-all$/)
      if (resumeAll && req.method === 'POST') {
        return json(res, 200, { ok: true })
      }
      // GET /api/projects/:pid/files —— workspace file tree (migrated from v1 listFileTree)
      const filesM = pathname.match(/^\/api\/projects\/([^/]+)\/files$/)
      if (filesM && req.method === 'GET') {
        const p = getProject(decodeURIComponent(filesM[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        return json(res, 200, listFileTree(p.path))
      }
      // GET /api/projects/:pid/files/read?path= —— file preview (migrated from v1 readProjectFile)
      const fileReadM = pathname.match(/^\/api\/projects\/([^/]+)\/files\/read$/)
      if (fileReadM && req.method === 'GET') {
        const p = getProject(decodeURIComponent(fileReadM[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        const url = new URL(req.url ?? '', 'http://localhost')
        const rel = url.searchParams.get('path') ?? ''
        try {
          return json(res, 200, readProjectFile(p.path, rel))
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'read failed'
          return json(res, msg === 'not found' ? 404 : 403, { error: msg })
        }
      }
      // GET /api/projects/:pid/repo-status —— git repository status (migrated from v1 repoStatus)
      const repoM = pathname.match(/^\/api\/projects\/([^/]+)\/repo-status$/)
      if (repoM && req.method === 'GET') {
        const p = getProject(decodeURIComponent(repoM[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        return json(res, 200, repoStatus(p.path))
      }
      // GET/PUT /api/projects/:pid/settings —— project settings (retrieval threshold / brief entry count; migrated from v1, persisted in SQLite)
      const settingsM = pathname.match(/^\/api\/projects\/([^/]+)\/settings$/)
      if (settingsM) {
        const pid3 = decodeURIComponent(settingsM[1])
        if (!getProject(pid3)) return json(res, 404, { error: 'project not found' })
        const readSettings = () => ({
          retrieval_threshold: Number(storage?.getConfig?.(pid3, 'retrieval_threshold') ?? '0.15'),
          brief_entries: Number(storage?.getConfig?.(pid3, 'brief_entries') ?? '5'),
        })
        if (req.method === 'GET') return json(res, 200, readSettings())
        if (req.method === 'PUT') {
          try {
            const body = await readBody(req)
            const threshold = typeof body.retrieval_threshold === 'number' ? body.retrieval_threshold : null
            const entries = typeof body.brief_entries === 'number' ? body.brief_entries : null
            if (threshold != null && (threshold < 0.05 || threshold > 0.9)) return json(res, 400, { error: 'retrieval_threshold must be 0.05-0.9' })
            if (entries != null && (entries < 1 || entries > 10)) return json(res, 400, { error: 'brief_entries must be 1-10' })
            if (threshold != null && storage) storage.setConfig(pid3, 'retrieval_threshold', String(threshold))
            if (entries != null && storage) storage.setConfig(pid3, 'brief_entries', String(entries))
            return json(res, 200, readSettings())
          } catch (e) {
            return json(res, 500, { error: e?.message ?? String(e) })
          }
        }
        return json(res, 405, { error: 'method not allowed' })
      }
      // /api/projects/:pid/presets* —— project profile management (P0 §2.6 three-axis combination; in-memory store in B1)
      const presetsM = pathname.match(/^\/api\/projects\/([^/]+)\/presets(?:\/([^/]+))?(?:\/(default))?$/)
      if (presetsM) {
        const pid2 = decodeURIComponent(presetsM[1])
        const id2 = presetsM[2] ? decodeURIComponent(presetsM[2]) : undefined
        const isDefault = presetsM[3] === 'default'
        const p2 = getProject(pid2)
        if (!p2) return json(res, 404, { error: 'project not found' })
        const profiles = ensureBuiltins(pid2)
        if (!id2 && req.method === 'GET') return json(res, 200, profiles)
        if (!id2 && req.method === 'POST') {
          try {
            const body = await readBody(req)
            const valid = (v, arr) => arr.includes(v)
            if (!valid(body.mode, ['normal', 'plan', 'goal']) || !valid(body.setting, ['light', 'balanced', 'delivery'])
              || !valid(body.approval, ['ask', 'auto', 'yolo']) || !valid(body.sandbox, ['read-only', 'workspace-write', 'danger-full-access'])) {
              return json(res, 400, { error: 'invalid profile axes' })
            }
            const prof = {
              id: `pf-${Date.now().toString(36)}`,
              project_id: pid2,
              name: typeof body.name === 'string' ? body.name : '(unnamed)',
              is_builtin: false,
              mode: body.mode, setting: body.setting, approval: body.approval, sandbox: body.sandbox,
              is_default: false,
            }
            if (storage) storage.upsertProfile(pid2, prof)
            return json(res, 201, prof)
          } catch (e) {
            return json(res, 500, { error: e?.message ?? String(e) })
          }
        }
        if (id2 && isDefault && req.method === 'POST') {
          const target = profiles.find((p) => p.id === id2)
          if (!target) return json(res, 404, { error: 'profile not found' })
          if (storage) storage.setDefaultProfile(pid2, id2)
          return json(res, 200, { ok: true })
        }
        if (id2 && !isDefault && req.method === 'DELETE') {
          const target = profiles.find((p) => p.id === id2)
          if (!target) return json(res, 404, { error: 'profile not found' })
          if (target.is_builtin) return json(res, 400, { error: 'cannot delete builtin' })
          if (storage) storage.removeProfile(pid2, id2)
          return json(res, 200, { ok: true })
        }
        return json(res, 404, { error: 'not found' })
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // /api/cards/* —— card operations (detail / status marking / new execution generation / calibration)
  webServer.register({
    kind: 'prefix',
    path: '/api/cards',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const findCard = (cardId) => {
        for (const p of Object.values(board.projection.projects)) {
          if (p.cards[cardId]) return { project: p, card: p.cards[cardId] }
        }
        return null
      }
      // GET /api/cards/:cardId —— card detail (all execution generations)
      const detail = pathname.match(/^\/api\/cards\/([^/]+)$/)
      if (detail && req.method === 'GET') {
        const found = findCard(decodeURIComponent(detail[1]))
        if (!found) return json(res, 404, { error: 'card not found' })
        const { project, card } = found
        return json(res, 200, { ...card, project_id: project.id, execution_count: card.exec_order.length })
      }
      // POST /api/cards/:cardId/status —— mark status manually
      const status = pathname.match(/^\/api\/cards\/([^/]+)\/status$/)
      if (status && req.method === 'POST') {
        const found = findCard(decodeURIComponent(status[1]))
        if (!found) return json(res, 404, { error: 'card not found' })
        try {
          const body = await readBody(req)
          const s = body.status
          if (s !== 'Done' && s !== 'Failed' && s !== 'Pending' && s !== 'Running' && s !== 'Cancelled') {
            return json(res, 400, { error: 'status must be one of Done|Failed|Pending|Running|Cancelled' })
          }
          const order = found.card.exec_order.length ? found.card.exec_order : Object.keys(found.card.executions)
          const sid = order[order.length - 1]
          const t = sid ? found.card.executions[sid] : undefined
          if (!t) return json(res, 400, { error: 'card has no execution to mark' })
          t.status = s
          if (s === 'Done') t.finished_at = t.finished_at ?? Date.now()
          else if (s === 'Pending') t.finished_at = undefined
          return json(res, 200, { ok: true, status: s })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/cards/:cardId/executions —— start a new execution generation (fork)
      const exec = pathname.match(/^\/api\/cards\/([^/]+)\/executions$/)
      if (exec && req.method === 'POST') {
        const found = findCard(decodeURIComponent(exec[1]))
        if (!found) return json(res, 404, { error: 'card not found' })
        try {
          const body = await readBody(req)
          const { sid } = await tasks.createTask({
            cwd: found.project.path,
            brief: body.brief ?? `Continue: ${found.card.title}`,
            preset: body.preset,
            project_id: found.project.id,
            card_id: found.card.id,
          })
          return json(res, 201, { card_id: found.card.id, session_id: sid, forked_from: body.from_execution_id ?? null })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/cards/:cardId/calibrate —— requirement calibration (new execution generation + calib flag)
      const calib = pathname.match(/^\/api\/cards\/([^/]+)\/calibrate$/)
      if (calib && req.method === 'POST') {
        const found = findCard(decodeURIComponent(calib[1]))
        if (!found) return json(res, 404, { error: 'card not found' })
        try {
          const { sid } = await tasks.createTask({
            cwd: found.project.path,
            brief: `Propose acceptance criteria for the card "${found.card.title}". When finished, output [ACCEPTANCE CRITERIA DONE]`,
            preset: found.card.criteria ? undefined : undefined,
            project_id: found.project.id,
            card_id: found.card.id,
          })
          // Mark as a calibration session (does not count as a normal execution generation)
          const t = found.card.executions[sid]
          if (t) t.calib = true
          return json(res, 201, { card_id: found.card.id, session_id: sid, kind: 'calibrate' })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // /api/tasks* —— unified routes (call the helmsmanTasks service)
  webServer.register({
    kind: 'prefix',
    path: '/api/tasks',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      // POST /api/tasks —— create task
      if (pathname === '/api/tasks' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          if (!body.cwd || !body.brief) return json(res, 400, { error: 'cwd and brief required' })
          const { sid } = await tasks.createTask({
            cwd: body.cwd,
            brief: body.brief,
            preset: body.preset,
            project_id: body.project_id,
            card_id: body.card_id,
          })
          return json(res, 201, { session_id: sid })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/tasks/:sid/comments —— comments = control channel
      const comment = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/)
      if (comment && req.method === 'POST') {
        try {
          const body = await readBody(req)
          if (!body.text) return json(res, 400, { error: 'text required' })
          await tasks.sendComment(decodeURIComponent(comment[1]), body.text)
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // GET /api/tasks/:sid —— task state (frontend contract: TaskState projection shape)
      const detail = pathname.match(/^\/api\/tasks\/([^/]+)$/)
      if (detail && req.method === 'GET') {
        const t = getTask(decodeURIComponent(detail[1]))
        if (t) return json(res, 200, t)
        // Session not in the projection (unregistered / after restart) → fall back to querying the live agent
        const live = tasks.getTaskStatus(decodeURIComponent(detail[1]))
        if (live.status !== 'unknown') return json(res, 200, live)
        return json(res, 404, { error: 'task not found' })
      }
      // POST /api/tasks/:sid/cancel —— stop (in-engine agent.cancel)
      const cancel = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)
      if (cancel && req.method === 'POST') {
        try {
          const ok = tasks.cancelTask(decodeURIComponent(cancel[1]))
          return json(res, 200, { ok })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/tasks/:sid/waiting —— trigger Waiting{kind} (task pauses awaiting a reply)
      const waiting = pathname.match(/^\/api\/tasks\/([^/]+)\/waiting$/)
      if (waiting && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const t = getTask(decodeURIComponent(waiting[1]))
          if (!t) return json(res, 404, { error: 'task not found' })
          const kind = body.kind === 'plan' || body.kind === 'permission' || body.kind === 'acceptance'
            || body.kind === 'cost' || body.kind === 'calibrate' || body.kind === 'checkpoint' ? body.kind : 'permission'
          t.waiting = {
            kind,
            reason: typeof body.reason === 'string' ? body.reason : '',
            payload: typeof body.payload === 'object' && body.payload !== null ? body.payload : {},
          }
          return json(res, 200, { ok: true, kind })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // /api/chats/* —— simple chats (status / send message / promote / save to KB)
  webServer.register({
    kind: 'prefix',
    path: '/api/chats',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      // GET /api/chats/:sid —— chat state (TaskState shape)
      const m = pathname.match(/^\/api\/chats\/([^/]+)$/)
      if (m && req.method === 'GET') {
        const t = getTask(decodeURIComponent(m[1]))
        if (!t) return json(res, 404, { error: 'chat not live' })
        return json(res, 200, t)
      }
      // POST /api/chats/:sid —— send message (sendChat)
      if (m && req.method === 'POST') {
        try {
          const body = await readBody(req)
          if (!body.text) return json(res, 400, { error: 'text required' })
          await tasks.sendComment(decodeURIComponent(m[1]), body.text)
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/chats/:sid/fork —— fork the chat (copy history into a new session)
      const forkM = pathname.match(/^\/api\/chats\/([^/]+)\/fork$/)
      if (forkM && req.method === 'POST') {
        try {
          const srcSid = decodeURIComponent(forkM[1])
          const { sid: newSid } = await tasks.forkTask({
            sid: srcSid,
            project_id: board.projection.sessionProject?.[srcSid],
            card_id: board.projection.sessionCard?.[srcSid] || undefined,
          })
          return json(res, 201, { session_id: newSid, forked_from: srcSid })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/chats/:sid/archive —— archive the chat (remove from list; projection marks archived)
      const archM = pathname.match(/^\/api\/chats\/([^/]+)\/archive$/)
      if (archM && req.method === 'POST') {
        const sid = decodeURIComponent(archM[1])
        const t = getTask(sid)
        if (!t) return json(res, 404, { error: 'chat not found' })
        t.archived = true
        return json(res, 200, { ok: true })
      }
      // POST /api/chats/:sid/restore —— restore an archived chat (clear the archived flag)
      const restM = pathname.match(/^\/api\/chats\/([^/]+)\/restore$/)
      if (restM && req.method === 'POST') {
        const sid = decodeURIComponent(restM[1])
        const t = getTask(sid)
        if (!t) return json(res, 404, { error: 'chat not found' })
        t.archived = false
        return json(res, 200, { ok: true })
      }
      // POST /api/chats/:sid/title —— user renames the title (engine sessionTitle.rename; once pinned, auto-generation stops)
      const titleM = pathname.match(/^\/api\/chats\/([^/]+)\/title$/)
      if (titleM && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const title = typeof body.title === 'string' ? body.title.trim() : ''
          if (!title) return json(res, 400, { error: 'title required' })
          // Uses sessionTitle.rename (needs a live session; renaming pins the title and stops auto-generation)
          // Live chat: agent.session is the authoritative live instance; historical chat (not resumed after a restart): resume first, then rename
          const sid = decodeURIComponent(titleM[1])
          const session = ctx.get('sessionTitle')
          let agent = ctx.get('agents')?.get?.(sid)
          if (!agent?.session) {
            // Historical chat: resume to get a live session (after resume the title is written to JSONL and survives restart replay)
            try {
              const resumed = await ctx.get('agents')?.resume?.({
                resumeSessionId: SessionId(sid),
                agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
              })
              agent = resumed?.agent
            } catch (e) {
              return json(res, 404, { error: `session not resumeable: ${e?.message ?? e}` })
            }
          }
          if (!agent?.session) return json(res, 404, { error: 'session not live' })
          const renamed = session.rename(agent.session, title)
          return json(res, 200, { ok: true, title: renamed.title })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/chats/:sid/promote —— promote to a card (chat context goes into the card; the new card runs automatically)
      const promote = pathname.match(/^\/api\/chats\/([^/]+)\/promote$/)
      if (promote && req.method === 'POST') {
        try {
          const sid = decodeURIComponent(promote[1])
          const t = getTask(sid)
          const pid = board.projection.sessionProject?.[sid]
          if (!t || !pid) return json(res, 404, { error: 'chat not found' })
          const project = getProject(pid)
          if (!project) return json(res, 404, { error: 'project not found' })
          const firstUser = t.comments.find((c) => c.who === 'user')?.text ?? ''
          const cardId = `c-${Date.now().toString(36)}`
          board.ensureCard(pid, {
            id: cardId,
            title: t.title ?? firstUser.slice(0, 40) ?? 'Promoted from chat',
            description: firstUser,
            kind: 'task',
            milestone: null,
            criteria: null,
            deps: [],
            created_at: Date.now(),
          })
          return json(res, 201, { card_id: cardId, session_id: sid })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/chats/:sid/kb —— save to knowledge base (saveChatToKb)
      const toKb = pathname.match(/^\/api\/chats\/([^/]+)\/kb$/)
      if (toKb && req.method === 'POST') {
        try {
          const sid = decodeURIComponent(toKb[1])
          const t = getTask(sid)
          if (!t) return json(res, 404, { error: 'chat not found' })
          const text = (t.activities ?? []).filter((a) => 'Text' in a).map((a) => a.Text.text).join('\n').slice(-2000)
          return json(res, 200, { ok: true, note_chars: text.length, note: null })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // ---------- /api/presets —— available agent presets (reads the engine agentPresets service) ----------
  webServer.register({
    kind: 'exact',
    path: '/api/presets',
    handler: async (_req, res) => {
      try {
        const presets = ctx.get('agentPresets')
        const list = presets ? await presets.list() : []
        json(res, 200, list.map((p) => ({ id: p.id, name: p.id, description: p.id })))
      } catch (e) {
        json(res, 500, { error: e?.message ?? String(e) })
      }
    },
  })

  // ---------- /api/metrics —— execution metrics (derived from the projection; cost is estimated from time-of-day pricing) ----------
  webServer.register({
    kind: 'exact',
    path: '/api/metrics',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const pid = url.searchParams.get('project')
      const rows = []
      for (const [projectId, p] of Object.entries(board.projection.projects)) {
        if (pid && projectId !== pid) continue
        for (const card of Object.values(p.cards)) {
          for (const [sid, t] of Object.entries(card.executions)) {
            const price = priceOf(t.model, t.finished_at ? new Date(t.finished_at) : undefined)
            rows.push({
              id: rows.length + 1,
              project_id: projectId,
              task_id: sid,
              brief_snapshot: t.brief_snapshot ?? [],
              outcome: t.status,
              cited_entries: [],
              turns: t.turns,
              steps: t.steps,
              group_tag: undefined,
              verified: false,
              cost: estCostFrom(t.usage, price),
              cache_hit: t.usage?.cacheReadTokens ?? 0,
              in_tokens: t.usage?.inputTokens ?? 0,
              cache_tokens: t.usage?.cacheReadTokens ?? 0,
              out_tokens: t.usage?.outputTokens ?? 0,
              reasoning_tokens: t.usage?.reasoningTokens ?? 0,
              model: t.model ?? null,
            })
          }
        }
      }
      return json(res, 200, rows)
    },
  })

  // GET /api/pricing —— price table for the current period (frontend display / cost explanation)
  webServer.register({
    kind: 'exact',
    path: '/api/pricing',
    handler: (_req, res) => {
      const now = new Date()
      const peak = isPeakHour(now)
      return json(res, 200, {
        peak,
        bjHour: (new Date(now.getTime() + 8 * 3600 * 1000)).getUTCHours(),
        note: 'DeepSeek V4 peak/off-peak pricing: peak = Beijing time Mon–Fri 9:00–12:00 ∪ 14:00–18:00; everything else (including all of the weekend) is off-peak; off-peak = half the peak price; CNY per million tokens',
        flash: peak ? PRICE_PEAK.flash : PRICE_OFFPEAK.flash,
        pro: peak ? PRICE_PEAK.pro : PRICE_OFFPEAK.pro,
      })
    },
  })
  // ---------- /api/experiments/* —— controlled experiments (B1 simplification: create A/B control cards, comparisons are not persisted) ----------
  webServer.register({
    kind: 'prefix',
    path: '/api/experiments',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      // POST /api/experiments/run —— run a batch of tasks (new cards execute automatically)
      if (pathname === '/api/experiments/run' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const projectId = typeof body.project_id === 'string' ? body.project_id : undefined
          const p = projectId ? getProject(projectId) : undefined
          if (!p) return json(res, 404, { error: 'project not found' })
          if (!Array.isArray(body.tasks) || body.tasks.length === 0) return json(res, 400, { error: 'tasks required' })
          const brief = body.brief !== false
          // internalize: true = internalized mode (group B control, WikiSkill comparison experiment) ——
          // hits are compiled into a project skill handbook and embedded directly; false = assemble by querying the Wiki (group A)
          const internalize = body.internalize === true
          const group = internalize ? 'B' : brief ? 'A' : 'C'
          const name = typeof body.name === 'string' && body.name ? body.name
            : internalize ? 'B Internalized skill' : brief ? 'A Query knowledge base' : 'C Bare run'
          const created = []
          for (const t of body.tasks) {
            const title = typeof t?.title === 'string' ? t.title.trim() : ''
            if (!title) continue
            const cardId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            board.ensureCard(p.id, {
              id: cardId,
              title,
              description: typeof t?.description === 'string' ? t.description : '',
              kind: 'task',
              milestone: null,
              criteria: typeof t?.acceptance === 'string' && t.acceptance.trim() ? t.acceptance.trim() : null,
              deps: [],
              created_at: Date.now(),
            })
            // Persist the card in SQLite (createTask's execution FK depends on the cards table)
            if (storage) storage.upsertCard({
              id: cardId, project_id: p.id, title,
              description: typeof t?.description === 'string' ? t.description : '',
              kind: 'task', milestone: null,
              criteria: typeof t?.acceptance === 'string' && t.acceptance.trim() ? t.acceptance.trim() : null,
              deps: [], budget: null, created_at: Date.now(),
            })
            const { sid } = await tasks.createTask({
              cwd: p.path,
              brief: title,
              project_id: p.id,
              card_id: cardId,
              internalize,
            })
            created.push({ card_id: cardId, session_id: sid, title })
          }
          return json(res, 201, { group, name, created })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // GET /api/experiments/compare?project= —— comparison (B1: derive an A/B overview from the projection)
      if (pathname === '/api/experiments/compare' && req.method === 'GET') {
        const url = new URL(req.url ?? '', 'http://localhost')
        const projectId = url.searchParams.get('project')
        const p = projectId ? getProject(projectId) : undefined
        if (!p) return json(res, 404, { error: 'project not found' })
        const all = []
        for (const card of Object.values(p.cards)) {
          for (const [sid, t] of Object.entries(card.executions)) {
            const price = priceOf(t.model, t.finished_at ? new Date(t.finished_at) : undefined)
            all.push({ task_id: sid, outcome: t.status, turns: t.turns, steps: t.steps, cost: estCostFrom(t.usage, price) })
          }
        }
        return json(res, 200, { project_id: p.id, a: all, b: [] })
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // ---------- /api/fs/* —— local file browsing (pick a directory for a new project) ----------
  webServer.register({
    kind: 'prefix',
    path: '/api/fs',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const url = new URL(req.url ?? '', 'http://localhost')
      // POST /api/fs/pick —— native folder-picker dialog (macOS)
      if (pathname === '/api/fs/pick' && req.method === 'POST') {
        try {
          const out = execSync('osascript -e \'POSIX path of (choose folder with prompt "Choose project directory")\'', {
            encoding: 'utf8',
            timeout: 60000,
          }).trim()
          return json(res, 200, out ? { cancelled: false, path: out } : { cancelled: true })
        } catch {
          return json(res, 200, { cancelled: true })
        }
      }
      // GET /api/fs/list?path= —— directory browsing
      if (pathname === '/api/fs/list' && req.method === 'GET') {
        const home = homedir()
        const canon = resolve(url.searchParams.get('path') || home)
        const entries = []
        let dirEntries = []
        try {
          dirEntries = readdirSync(canon, { withFileTypes: true }).map((e) => ({
            name: e.name,
            isDir: e.isDirectory(),
            isSymlink: e.isSymbolicLink(),
          }))
        } catch { /* ignore */ }
        for (const e of dirEntries) {
          if (e.name.startsWith('.')) continue
          entries.push({ name: e.name, path: join(canon, e.name), is_dir: e.isDir, is_symlink: e.isSymlink })
        }
        entries.sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || (a.name < b.name ? -1 : 1))
        return json(res, 200, { path: canon, parent: dirname(canon), entries })
      }
      // GET /api/fs/find?name=&max= —— search by name (breadth-first, depth- and count-limited)
      if (pathname === '/api/fs/find' && req.method === 'GET') {
        const name = url.searchParams.get('name') ?? ''
        if (!name) return json(res, 400, { error: 'empty name' })
        const max = Math.min(Math.max(Number(url.searchParams.get('max') ?? 5), 1), 20)
        const home = homedir()
        const found = []
        let visited = 0
        const queue = [[home, 0]]
        while (queue.length > 0 && found.length < max && visited < 30000) {
          const [dir, depth] = queue.shift()
          visited += 1
          let children = []
          try {
            children = readdirSync(dir, { withFileTypes: true }).map((e) => ({
              name: e.name, isDir: e.isDirectory(), isSymlink: e.isSymbolicLink(),
            }))
          } catch { continue }
          for (const c of children) {
            if (c.name.startsWith('.') || c.name === 'node_modules') continue
            if (c.name.includes(name)) {
              found.push({ name: c.name, path: join(dir, c.name) })
              if (found.length >= max) break
            }
            if (c.isDir && depth < 4) queue.push([join(dir, c.name), depth + 1])
          }
        }
        return json(res, 200, { found })
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  console.log('[helmsman-api] business API registered: /api/projects* /api/cards* /api/tasks* /api/chats* /api/fs* /api/files*')
}

// ---------- Workspace file tree (migrated from v1 listFileTree) ----------
// Filtered: node_modules/.git/.sessions/.npm-cache/dist/*.db/.DS_Store; max depth 5, 100 entries per directory.
function listFileTree(dir, depth = 0) {
  const SKIP = new Set(['node_modules', '.git', '.sessions', '.npm-cache', 'dist', 'research', 'docs-archive', 'design-mockups', '.DS_Store'])
  const name = basename(dir)
  const out = { name, type: 'dir', children: [] }
  if (depth > 5) return { ...out, children: undefined }
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !SKIP.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
      .slice(0, 100)
      .map((e) => e.name)
  } catch { return { ...out, children: undefined } }
  for (const n of entries) {
    const full = join(dir, n)
    try {
      const st = statSync(full)
      if (st.isDirectory()) out.children.push(listFileTree(full, depth + 1))
      else out.children.push({ name: n, type: 'file' })
    } catch { /* skip unreadable entries */ }
  }
  return out
}

// ---------- File preview read (migrated from v1 readProjectFile) ----------
// Safety: path must resolve inside the workspace (no traversal); a path segment matching SKIP/hidden → rejected; size ≤ 256KB (larger is flagged truncated); binary (contains NUL) → content not returned.
const SKIP_SET = new Set(['node_modules', '.git', '.sessions', '.npm-cache', 'dist', 'research', 'docs-archive', 'design-mockups', '.DS_Store'])
function readProjectFile(workspace, rel) {
  if (!rel || rel.includes('\0')) throw new Error('bad path')
  const full = resolve(workspace, rel)
  if (!full.startsWith(resolve(workspace) + '/') && full !== resolve(workspace)) throw new Error('path escapes workspace')
  const segs = rel.split('/')
  if (segs.some((s) => SKIP_SET.has(s) || s.startsWith('.'))) throw new Error('path not allowed')
  let st
  try { st = statSync(full) } catch { throw new Error('not found') }
  if (!st.isFile()) throw new Error('not a file')
  const size = st.size
  if (size > 262144) {
    return { path: rel, name: basename(full), size, content: '', truncated: true, binary: false }
  }
  const buf = readFileSync(full)
  // Binary detection: NUL within the first 8KB
  const head = buf.subarray(0, 8192)
  const binary = head.includes(0)
  if (binary) return { path: rel, name: basename(full), size, content: '', truncated: false, binary: true }
  return { path: rel, name: basename(full), size, content: buf.toString('utf8'), truncated: false, binary: false }
}

// ---------- git repository status (migrated from v1 repoStatus) ----------
// execFileSync bypasses the shell: avoids arguments like %(refname:short) being parsed by sh.
function repoStatus(workspace) {
  const git = (args, opts = {}) => {
    try {
      const out = execFileSync('git', args, { cwd: workspace, encoding: 'utf8', timeout: opts.timeoutMs ?? 5000 })
      return opts.trim === false ? out : out.trim()
    } catch { return '' }
  }
  if (!git(['rev-parse', '--is-inside-work-tree'])) {
    return { branch: '', dirty: 0, staged: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0, lastCommit: '', changes: [], branches: [], history: [], error: 'not a git repo' }
  }
  const branch = git(['branch', '--show-current'])
  const status = git(['status', '--porcelain'], { trim: false }).split('\n').filter(Boolean).map((l) => l.replace(/\r$/, ''))
  const staged = status.filter((l) => /^[MADRCU]/.test(l)).length
  const untracked = status.filter((l) => /^\?\?/.test(l)).length
  const conflicted = status.filter((l) => l.length >= 2 && (l[0] === 'U' || l[1] === 'U')).length
  const changes = status.map((l) => {
    const x = l[0] ?? ' '
    const y = l[1] ?? ' '
    const path = l.slice(3).replace(/^"|"$/g, '')
    if (x === '?' && y === '?') return { code: '?', staged: false, path }
    const conflictedFlag = x === 'U' || y === 'U'
    if (conflictedFlag) return { code: 'U', staged: false, path }
    const code = y !== ' ' ? y : x
    return { code, staged: x !== ' ' && x !== '?', path }
  })
  // Branch list (filter out task-isolation worktree branches —— helmsman/card-… internal noise)
  const branches = git(['branch', '--format=%(refname:short)'])
    .split('\n').filter(Boolean)
    .filter((name) => !name.startsWith('helmsman/card-'))
    .map((name) => ({ name, current: name === branch }))
  // Commit history (latest 6: hash / relative time / subject)
  const history = git(['log', '-6', '--format=%h%x09%ar%x09%s'])
    .split('\n').filter(Boolean)
    .map((line) => {
      const [hash, when, ...rest] = line.split('\t')
      return { hash, when: when ?? '', subject: rest.join('\t') }
    })
  const ahead = Number(git(['rev-list', '--count', 'origin/' + branch + '..HEAD']) || 0)
  const behind = Number(git(['rev-list', '--count', 'HEAD..origin/' + branch]) || 0)
  const lastCommit = git(['log', '-1', '--format=%s'])
  return { branch, dirty: status.length, staged, untracked, conflicted, ahead, behind, lastCommit, changes, branches, history }
}

export default { name, inject, apply }
