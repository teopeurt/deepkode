// [helmsman] D3-4 knowledge-base plugin (internalized into the engine).
// Migration points:
//   - retrieveHybrid / makeNote / buildDistillPrompt / parseDistillJson: pure functions ported as-is
//   - distillWithAgent: ACP session (sessionNew+prompt+polling the JSONL) → driven directly by in-engine agents
//     (followup + whenIdle + reading session.events directly: zero polling, zero ACP, zero patches)
// Storage: in-memory Map during D3-4 (the SQLite move is left for the full D3-4 version).
// Interface:
//   GET  /api/kb/search?q=&project=   → [{id,title,summary,score}]
//   POST /api/kb/notes               → {note} (manual capture)
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { embedTexts, embedNotes, cosine } from './helmsman-embedding.js'

export const name = 'helmsman-kb'
export const inject = ['webServer', 'agents', 'sessions', 'helmsmanStorage', 'helmsmanBoard']

// ---------- Pure functions: ported as-is from server-ts/kb.ts + distill.ts (only the node:fs/ACP dependencies removed) ----------

/** Rule-based retrieval (keyword matching, fused ranking). */
function deriveQueries(taskText) {
  const t = String(taskText ?? '').toLowerCase()
  const tokens = t.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)
  const seen = new Set()
  const out = []
  for (const tok of tokens) {
    if (tok.length < 2 || seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
  }
  return out.slice(0, 8)
}

/** Retrieval hits (simple rule version: a hit if title/content/keywords contain any query). */
function retrieve(notes, queries, opts = {}) {
  const limit = opts.limit ?? 5
  const hits = []
  for (const n of notes) {
    if (!n) continue
    let score = 0
    const title = (n.title ?? '').toLowerCase()
    const content = (n.content ?? []).join(' ').toLowerCase()
    const keywords = (n.keywords ?? []).join(' ').toLowerCase()
    const tags = (n.tags ?? []).join(' ').toLowerCase()
    for (const q of queries) {
      if (title.includes(q)) score += 3
      else if (keywords.includes(q)) score += 2
      else if (tags.includes(q)) score += 1.5
      else if (content.includes(q)) score += 1
    }
    if (score > 0) hits.push({ note: n, score })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit).map((h) => ({ note: h.note, score: h.score }))
}

// ---------- Hybrid retrieval (D3-8: migrated from server-ts/kb.ts retrieveHybrid) ----------
// Rule channel (keyword hits always pass, with freshness/trust weighting) + semantic channel (vector similarity; can get in even without a keyword hit).
// Fused score: rule-hit entries = 0.7·rule score + 0.3·semantic score; semantic-only entries = 0.8·semantic score.
// embedding unavailable → pure rule results (degrades without breaking anything).

/** Candidate threshold for the semantic channel (bge Chinese similarity: unrelated ~0.3, related ~0.6+; 0.5 is a reasonable gate) */
const SEMANTIC_THRESHOLD = 0.5

async function retrieveHybrid(notes, queries, queryText, opts = {}) {
  const limit = opts.limit ?? 5
  const threshold = opts.threshold ?? 0.15
  const ruleHits = retrieve(notes, queries, opts)
  const ruleById = new Map(ruleHits.map((h) => [h.note.id, h.score]))

  const vecs = opts.embedNotes ? await opts.embedNotes(notes) : await embedNotes(notes)
  if (!vecs || vecs.length !== notes.length) return ruleHits // note vectors unavailable → rules only
  const qv = opts.embedQuery ? await opts.embedQuery(queryText) : await embedTexts([queryText], { query: true })
  if (!qv) return ruleHits

  const q = qv[0]
  const scored = []
  notes.forEach((note, i) => {
    const sim = cosine(q, vecs[i])
    const rule = ruleById.get(note.id)
    if (rule != null) {
      scored.push({ note, score: 0.7 * rule + 0.3 * sim })
    } else if (sim >= SEMANTIC_THRESHOLD) {
      scored.push({ note, score: 0.8 * sim })
    }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.filter((s) => s.score >= threshold).slice(0, limit)
}

// ---------- Context assembly (D3-9: migrated from server-ts/assembly.ts) ----------
// Task start: task definition + knowledge-base retrieval hits → first prompt (rule-based version of the five steps in spec §4.2).
// Prefix partitioning (§6D cache lever): [stable project knowledge block (fixed across tasks → KV cache)][task definition + relevant hits (varies)].

const STABLE_TAG = 'stable'
const TRUST_RANK_ASSEMBLY = { 'human-approved': 3, 'agent-generated': 2, unverified: 1 }

/** The stable prefix only includes notes the user pinned with the `stable` tag; it does not auto-stuff old notes by trust level. */
function selectStableNotes(notes, limit = 5) {
  return (notes ?? [])
    .filter((n) => (n.tags ?? []).some((t) => String(t).toLowerCase() === STABLE_TAG))
    .sort((a, b) => {
      const tr = (TRUST_RANK_ASSEMBLY[b.trust] ?? 0) - (TRUST_RANK_ASSEMBLY[a.trust] ?? 0)
      if (tr !== 0) return tr
      return String(a.id).localeCompare(String(b.id))
    })
    .slice(0, limit)
    .map((n) => ({ title: n.title, content: n.content }))
}

/** A note's debt relative to past executions: injected but unused / used but still failed. */
function scoreNoteDebt(noteId, metrics) {
  let injected = 0
  let cited = 0
  let failedWhenCited = 0
  for (const m of metrics ?? []) {
    if ((m.brief_snapshot ?? []).some((h) => h && h.id === noteId)) injected += 1
    if ((m.cited_entries ?? []).includes(noteId)) {
      cited += 1
      if (m.outcome !== 'Done' || m.verified === false) failedWhenCited += 1
    }
  }
  let status = 'idle'
  if (cited >= 1 && failedWhenCited * 2 >= cited) status = 'toxic'
  else if (cited >= 1) status = 'useful'
  else if (injected >= 2) status = 'unused'
  return { injected, cited, failedWhenCited, status }
}

/** Task-relevant retrieval: unused / toxic are no longer assembled. The stable prefix only takes user-pinned `stable` notes and does not go through this. */
function debtDemoteWeight(status) {
  if (status === 'toxic' || status === 'unused') return 0
  return 1
}

/** Assemble the brief: hybrid retrieval of task-relevant hits + debt demotion. */
async function assembleBrief({ taskTitle, taskDescription, notes, threshold = 0.15, maxKbEntries = 5, demote = {} }) {
  const taskText = `${taskTitle ?? ''}\n${taskDescription ?? ''}`.trim()
  const queries = deriveQueries(taskText)
  const hits = await retrieveHybrid(notes, queries, taskText, {
    limit: maxKbEntries,
    threshold,
    demote,
  })
  return {
    taskTitle: taskTitle ?? '',
    taskDescription: taskDescription ?? '',
    kbHits: hits.map((h) => ({
      id: h.note.id,
      title: h.note.title,
      score: Math.round(h.score * 100) / 100,
      trust: h.note.trust,
      content: h.note.content ?? [],
      antiPatterns: h.note.antiPatterns ?? [],
      applicability: h.note.applicability ?? '',
    })),
  }
}

/** Render into the prompt text sent to the engine (brief → first message). */
function renderBriefPrompt(brief, projectStableNotes = []) {
  const lines = []
  if (projectStableNotes.length > 0) {
    lines.push('-- Project stable knowledge (established conclusions for this project, consistent across tasks) --')
    for (const n of projectStableNotes) {
      lines.push(`• ${n.title}: ${(n.content ?? []).join(' ').slice(0, 200)}`)
    }
    lines.push('')
  }
  lines.push(`Task: ${brief.taskTitle}`)
  if (String(brief.taskDescription ?? '').trim()) lines.push(brief.taskDescription.trim())
  if (brief.kbHits.length > 0) {
    lines.push('', '-- Knowledge-base entries relevant to this task (sorted by relevance) --')
    for (const h of brief.kbHits) {
      lines.push(`[${h.score}] ${h.title}`)
      if (h.applicability) lines.push(`    Applies when: ${h.applicability.slice(0, 160)}`)
      if (h.antiPatterns?.length > 0) {
        lines.push(`    Avoid: ${h.antiPatterns.slice(0, 3).join('; ').slice(0, 200)}`)
      }
    }
  }
  return lines.join('\n')
}

/** Internalized mode (WikiSkill comparison experiment, group B): hit entries are compiled into a "project skill handbook" and embedded directly.
 * Difference from renderBriefPrompt: this gives the full procedure (full content) rather than just title + score,
 * and explicitly says "follow this procedure", simulating "the skill is internalized" (no per-task retrieval). */
/** Internalized mode (WikiSkill comparison experiment, group B): hit entries are compiled into a "project skill handbook" and embedded directly.
 * Difference from renderBriefPrompt: this gives the full procedure (full content) rather than just title + score,
 * and explicitly says "follow this procedure", simulating "the skill is internalized" (no per-task retrieval).
 * v2 (revised after enlarging the sample): adds a focus instruction to prevent "over-execution" —— the handbook is reference only and does not expand the task scope. */
function renderInternalizedSkill(taskTitle, kbHits, opts = {}) {
  const lines = []
  lines.push(`Task: ${taskTitle}`)
  lines.push('')
  if (kbHits.length === 0) {
    lines.push('(The project knowledge base has no relevant entries yet; complete the task according to its description.)')
    return lines.join('\n')
  }
  // Trim by relevance: only inject the top-N highest-scoring hits (prevents the whole handbook from causing over-execution)
  const maxEntries = opts.maxEntries ?? 3
  const top = [...kbHits].sort((a, b) => b.score - a.score).slice(0, maxEntries)
  lines.push('-- Project skill handbook (distilled from the knowledge base) --')
  lines.push('Usage rule: only follow an entry\'s procedure when it is directly relevant to the current task; do not expand the task scope because of the handbook — just complete what the task asks.')
  for (const h of top) {
    lines.push(`## ${h.title} (relevance ${h.score})`)
    for (const c of h.content ?? []) lines.push(`- ${c}`)
    if (h.applicability) lines.push(`Applies when: ${h.applicability}`)
    if (h.antiPatterns?.length > 0) {
      lines.push('Avoid:')
      for (const a of h.antiPatterns) lines.push(`  ✗ ${a}`)
    }
  }
  return lines.join('\n')
}

function makeNote(input) {
  const t = Date.now()
  return {
    id: `kb-${t}-${Math.floor(Math.random() * 1e6)}`,
    project_id: input.projectId,
    title: input.title,
    content: input.content ?? [],
    tags: input.tags ?? [],
    keywords: input.keywords ?? [],
    summary: input.summary ?? '',
    antiPatterns: input.antiPatterns ?? [],
    applicability: input.applicability ?? '',
    links: input.links ?? [],
    source: { kind: input.sourceKind, ref: input.sourceRef },
    validFrom: t,
    validUntil: null,
    version: 1,
    trust: input.trust,
    createdAt: t,
    updatedAt: t,
  }
}

/** Distillation prompt (bounded: last 2000 characters + at most 3 related note summaries). */
function buildDistillPrompt(input) {
  const lines = []
  lines.push('Task title: ' + (input.title ?? '').slice(0, 200))
  lines.push('')
  lines.push('Task output (tail):')
  lines.push((input.tail ?? '').slice(0, 2000))
  if (input.related?.length > 0) {
    lines.push('')
    lines.push('Related notes (summaries):')
    for (const r of input.related.slice(0, 3)) {
      lines.push(`- ${r.title ?? ''}: ${(r.summary ?? '').slice(0, 200)}`)
    }
  }
  lines.push('')
  lines.push('Distill one structured knowledge entry from the task output. Output strictly JSON:')
  lines.push('{"title":"short title","content":["point 1","point 2"],"keywords":["k1","k2"],"summary":"one-sentence summary","anti_patterns":["pitfalls/things to avoid (empty array if none)"],"applicability":"in what situations this knowledge applies (empty string if none)"}')
  lines.push('If the task output contains "don\'t do this" lessons (pitfalls, causes of failure, things to avoid), distill them into anti_patterns; applicability states the boundaries of use, to prevent misuse.')
  lines.push('If there is no knowledge worth keeping, output {"title":""}. Output only JSON, no other text.')
  return lines.join('\n')
}

/** Parse the distillation JSON (tolerant: strips code fences / surrounding prose). */
function parseDistillJson(text) {
  const t = String(text ?? '').trim()
  if (!t) return null
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : t
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    const title = typeof obj.title === 'string' ? obj.title : ''
    return {
      title,
      content: Array.isArray(obj.content) ? obj.content.filter((x) => typeof x === 'string').slice(0, 20) : [],
      keywords: Array.isArray(obj.keywords) ? obj.keywords.filter((x) => typeof x === 'string').slice(0, 10) : [],
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      antiPatterns: Array.isArray(obj.anti_patterns) ? obj.anti_patterns.filter((x) => typeof x === 'string').slice(0, 6) : [],
      applicability: typeof obj.applicability === 'string' ? obj.applicability : '',
    }
  } catch {
    return null
  }
}

// ---------- Engine hook point: distill driven directly by agents (replaces ACP) ----------

/**
 * Distill: create a distill session inside the engine → followup → whenIdle → read session.events directly.
 * Replaces v1's acp.sessionNew + sessionPrompt + polling the JSONL.
 */
async function distillWithEngine(ctx, input, timeoutMs = 120000) {
  const sid = SessionId(`distill-${randomUUID().slice(0, 12)}`)
  let dispose
  try {
    const prompt = buildDistillPrompt(input)
    const { agent, dispose: d } = await ctx.agents.create({
      sessionId: sid,
      // distill only consumes the prompt text (task output is inlined) and never touches project files:
      // cwd points at a separate temp directory so the agent cannot get the main workspace path and modify project files
      meta: { cwd: '/tmp' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: (agentCtx) => {
        // distill preset: pure text distillation, no file/command tools mounted (D3-6 fix: previously it got all tools and modified project files)
        try {
          // view() needs an explicit scope: passing agentCtx inside the agent's setup gives the current agent scope
          const v = agentCtx.tools?.view?.(agentCtx)
          const deny = v?.restrictableNames?.size ? [...v.restrictableNames] : ['bash', 'read', 'write', 'edit', 'subagent', 'workflow', 'todo_write', 'skill', 'send_message']
          agentCtx.tools.restrict({ deny })
        } catch (e) {
          console.warn('[helmsman-kb] failed to restrict distill tools (non-blocking):', e?.message ?? e)
        }
      },
    })
    dispose = d
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('distill timeout')), timeoutMs)),
    ])
    await ctx.sessions.flush(agent.session)
    const text = extractLastAssistantText(agent.session.events)
    if (!text) return null
    const parsed = parseDistillJson(text)
    if (parsed == null || parsed.title === '') return null
    return parsed
  } catch (e) {
    console.error('[helmsman-kb] distill failed (falling back to rule version):', e?.message ?? e)
    return null
  } finally {
    if (dispose) await dispose().catch(() => undefined)
  }
}

function extractLastAssistantText(events) {
  let text = ''
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const msg = ev.message ?? ev.data?.message ?? {}
    text = (msg.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('')
  }
  return text.trim()
}

// ---------- Plugin body: routes + storage ----------

export function apply(ctx) {
  const { webServer } = ctx
  const storage = ctx.get('helmsmanStorage')?.storage
  // Notes all go through SQLite (loaded via listNotes; with no project, fall back to the fixed default)
  const loadNotes = (project) => {
    if (!storage) return []
    if (project) return storage.listNotes(project)
    return storage.listNotes('default') // no project filter: default library (the frontend always passes project)
  }
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

  // ---------- Automatic capture (migrated from v1 distillOrFallback) ----------
  // Task turn/end and Done → take the task output from the projection → distill → store the note (rule version as fallback on failure)
  const board = ctx.get('helmsmanBoard')
  const autoSedimented = new Set() // (sid, turn) pairs already captured, to prevent duplicates
  if (board) {
    ctx.on('session/event', (session, event) => {
      if (!session?.id || event?.type !== 'turn/end') return
      const sid = session.id
      const turn = event.data?.turn
      const key = `${sid}:${turn}`
      if (autoSedimented.has(key)) return
      // Find the task state in the projection (card execution or chat)
      const pid = board.projection?.sessionProject?.[sid]
      if (!pid) return
      const cardId = board.projection?.sessionCard?.[sid]
      const proj = board.projection?.projects?.[pid]
      const t = cardId ? proj?.cards?.[cardId]?.executions?.[sid] : proj?.chats?.[sid]
      if (!t || t.status !== 'Done') return
      // Only capture if there is actual output (Text activities)
      const texts = (t.activities ?? []).filter((a) => 'Text' in a).map((a) => a.Text.text)
      const tail = texts.join('\n').slice(-2000)
      if (!tail.trim()) return
      autoSedimented.add(key)
      void (async () => {
        try {
          const title = t.title ?? 'Task capture'
          const related = []
          const result = await distillWithEngine(ctx, {
            cwd: proj.path,
            title,
            tail,
            related,
          })
          let note
          if (result && result.title) {
            note = makeNote({
              projectId: pid, title: result.title, content: result.content,
              tags: [], keywords: result.keywords, summary: result.summary,
              antiPatterns: result.antiPatterns ?? [], applicability: result.applicability ?? '',
              sourceKind: 'task', sourceRef: sid, trust: 'agent-generated',
            })
            console.log(`[helmsman-kb] auto-captured "${result.title}" (task ${title.slice(0, 24)})`)
          } else {
            // Rule-version fallback: title + tail summary
            note = makeNote({
              projectId: pid, title: title.slice(0, 60), content: texts.slice(0, 10),
              tags: [], keywords: [], summary: tail.slice(0, 120),
              sourceKind: 'task', sourceRef: sid, trust: 'agent-generated',
            })
            console.log(`[helmsman-kb] rule-version capture "${title.slice(0, 24)}"`)
          }
          // The same task session already has a note → upgrade it (version+1, keep id/createdAt/validFrom) instead of creating a new one
          const prev = storage
            ? storage.listNotes(pid).find((n) => n.source?.kind === 'task' && n.source?.ref === sid)
            : undefined
          if (prev) {
            note.id = prev.id
            note.version = (prev.version ?? 1) + 1
            note.createdAt = prev.createdAt
            note.validFrom = prev.validFrom
            console.log(`[helmsman-kb] same-task update "${note.title}" → v${note.version}`)
          }
          if (storage) storage.upsertNote(note)
        } catch (e) {
          console.error('[helmsman-kb] automatic capture failed:', e?.message ?? e)
        }
      })()
    })
    console.log('[helmsman-kb] automatic capture enabled (task Done → distill → store)')
  }

  // GET /api/kb/search?q=&project= —— hybrid retrieval (rules + semantic; falls back to rules automatically if embedding is unavailable)
  webServer.register({
    kind: 'exact',
    path: '/api/kb/search',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const q = url.searchParams.get('q') ?? ''
      const project = url.searchParams.get('project')
      const pool = loadNotes(project)
      if (!q.trim()) return json(res, 200, [])
      try {
        const hits = await retrieveHybrid(pool, deriveQueries(q), q, { limit: 8 })
        // Return full notes + score (frontend table columns depend on tags/source/trust/validUntil)
        json(res, 200, hits.map((h) => ({ ...h.note, score: h.score })))
      } catch (e) {
        console.warn('[helmsman-kb] hybrid retrieval failed (falling back to rules):', e?.message ?? e)
        const hits = retrieve(pool, deriveQueries(q), { limit: 8 })
        json(res, 200, hits.map((h) => ({ ...h.note, score: h.score })))
      }
    },
  })

  // /api/kb/notes —— GET list (frontend contract) + POST manual capture
  webServer.register({
    kind: 'exact',
    path: '/api/kb/notes',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        const url = new URL(req.url ?? '', 'http://localhost')
        const project = url.searchParams.get('project')
        const list = loadNotes(project)
        // Valid notes first (not invalidated), sorted by creation time descending
        list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        return json(res, 200, list)
      }
      if (req.method === 'POST') {
        try {
          const body = await readBody(req)
          const note = makeNote({
            projectId: body.project_id ?? 'default',
            title: body.title ?? '(untitled)',
            content: body.content ?? [],
            tags: body.tags ?? [],
            keywords: body.keywords ?? [],
            summary: body.summary ?? '',
            sourceKind: body.source_kind ?? 'human',
            sourceRef: body.source_ref ?? '',
            trust: body.trust ?? 'human-approved',
          })
          if (storage) storage.upsertNote(note)
          return json(res, 201, { note })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      return json(res, 405, { error: 'method not allowed' })
    },
  })

  // POST /api/kb/notes/:id/invalidate —— invalidate a note
  webServer.register({
    kind: 'prefix',
    path: '/api/kb/notes',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const inv = pathname.match(/^\/api\/kb\/notes\/([^/]+)\/invalidate$/)
      if (inv && req.method === 'POST') {
        const n = storage ? storage.getNote(inv[1]) : undefined
        if (!n) return json(res, 404, { error: 'note not found' })
        if (storage) storage.invalidateNote(n.id, 'manual', Date.now())
        return json(res, 200, { ok: true })
      }
      // POST /api/kb/notes/:id/stable —— pin into / unpin from the stable prefix
      const stable = pathname.match(/^\/api\/kb\/notes\/([^/]+)\/stable$/)
      if (stable && req.method === 'POST') {
        return (async () => {
          try {
            const body = await readBody(req)
            const n = storage ? storage.getNote(stable[1]) : undefined
            if (!n) return json(res, 404, { error: 'note not found' })
            const pinned = body.pinned === true
            n.tags = n.tags ?? []
            if (pinned && !n.tags.includes('stable')) n.tags.push('stable')
            if (!pinned) n.tags = n.tags.filter((t) => t !== 'stable')
            if (storage) storage.upsertNote(n)
            return json(res, 200, n)
          } catch (e) {
            return json(res, 500, { error: e?.message ?? String(e) })
          }
        })()
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // POST /api/kb/distill —— task Done → distill → capture (full closed-loop demo)
  webServer.register({
    kind: 'exact',
    path: '/api/kb/distill',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        const result = await distillWithEngine(ctx, {
          cwd: body.cwd ?? process.cwd(),
          title: body.title ?? '',
          tail: body.tail ?? '',
          related: body.related ?? [],
        })
        if (result == null) return json(res, 200, { skipped: true })
        const note = makeNote({
          projectId: body.project_id ?? 'default',
          title: result.title,
          content: result.content,
          tags: [],
          keywords: result.keywords,
          summary: result.summary,
          sourceKind: 'task',
          sourceRef: body.source_ref ?? '',
          trust: 'agent-generated',
        })
        if (storage) storage.upsertNote(note)
        json(res, 201, { note })
      } catch (e) {
        json(res, 500, { error: e?.message ?? String(e) })
      }
    },
  })

  // ---------- Internal service: helmsmanKb (for helmsman-tasks task-start assembly) ----------
  ctx.provide('helmsmanKb', {
    /** Task-start assembly: project notes + historical metrics → {prompt, kbHits}. */
    async assembleTaskPromptFull({ taskTitle, taskDescription, projectId, brief = true, internalize = false }) {
      const pool = loadNotes(projectId)
      const metrics = storage ? storage.listMetrics(projectId) : []
      if (brief === false) return { prompt: `${taskTitle ?? ''}\n\n${taskDescription ?? ''}`.trim(), kbHits: [] }
      const stableNotes = selectStableNotes(pool)
      const demote = {}
      for (const n of pool) {
        const w = debtDemoteWeight(scoreNoteDebt(n.id, metrics).status)
        if (w !== 1) demote[n.id] = w
      }
      const brief2 = await assembleBrief({
        taskTitle: taskTitle ?? '',
        taskDescription: taskDescription ?? '',
        notes: pool,
        threshold: 0.15,
        maxKbEntries: 5,
        demote,
      })
      if (internalize) {
        // Internalized mode (WikiSkill comparison experiment, group B): compile the hit entries into a "project skill handbook"
        // embedded directly (full procedure + anti-patterns + applicability), so the task follows the handbook rather than retrieving per task.
        return { prompt: renderInternalizedSkill(taskTitle ?? '', brief2.kbHits, { maxEntries: 3 }), kbHits: brief2.kbHits, internalized: true }
      }
      return { prompt: renderBriefPrompt(brief2, stableNotes), kbHits: brief2.kbHits }
    },
    /** Prompt only (compatible with the old signature). */
    async assembleTaskPrompt({ taskTitle, taskDescription, projectId, brief = true }) {
      const r = await this.assembleTaskPromptFull({ taskTitle, taskDescription, projectId, brief })
      return r.prompt
    },
    /** Stable-prefix notes (for frontend display). */
    selectStableNotes,
  })

  console.log('[helmsman-kb] knowledge-base routes registered: /api/kb/search /api/kb/notes /api/kb/distill; assembly service helmsmanKb provided')
}

export default { name, inject, apply }
