// [helmsman] Event stream → board-state projection (ported as-is from server-ts/src/projection.ts, TS→JS).
// fold is a pure incremental function: the board plugin calls it once per session/event, updating state in place.
// Replayable: replaying the same log twice yields the same result (determinism, crash recovery, tests).
// M2.3 (O1=B): two layers, card/executions —— card = asset (requirement/defect/task + milestone),
// with 0..n executions attached; execution = session (1:1). Board status = status of the latest execution.

export const MAX_ACTIVITIES = 200
export const MAX_COMMENTS = 200

export function newTaskState(sid) {
  return {
    id: sid,
    status: 'Pending',
    turns: 0,
    steps: 0,
    tool_calls: [],
    activities: [],
    comments: [],
    last_seq: 0,
    recovered: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
    waiting: null,
    preset: null,
    current_turn: 0,
  }
}

/** Dependency contract validation (target contract: taskgraph): array + exists in the same project + no self-dependency + no cycles; returns the deduplicated canonical id list.
 *  Invalid input throws (caller turns it into HTTP 400); undefined → empty array (no dependencies). */
export function validateDeps(deps, knownIds, selfId, getDeps) {
  if (deps === undefined) return []
  if (!Array.isArray(deps) || !deps.every((d) => typeof d === 'string' && d.length > 0)) {
    throw new Error('deps must be an array of card ids')
  }
  const known = new Set(knownIds)
  const out = []
  for (const d of new Set(deps)) {
    if (d === selfId) throw new Error('card cannot depend on itself')
    if (!known.has(d)) throw new Error(`dep '${d}' not in project`)
    if (getDeps && leadsToSelf(d, selfId, getDeps)) throw new Error(`dependency cycle: the dependency chain of '${d}' leads back to this card`)
    out.push(d)
  }
  return out
}

/** DFS: can selfId be reached from start along the dependency chain (new edge → cycle). */
function leadsToSelf(start, selfId, getDeps) {
  const seen = new Set()
  const stack = [start]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === selfId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    stack.push(...getDeps(cur))
  }
  return false
}

/** The card's latest execution (exec_order first, falling back to key order) */
export function latestExecutionState(card) {
  const order = card.exec_order.length ? card.exec_order : Object.keys(card.executions)
  const sid = order[order.length - 1]
  return (sid && card.executions[sid]) || null
}

/** Dependency gate (§2.1 scheduling gate): true (can start) when the latest execution of every dependency card is Done. */
export function depsMet(card, cardsById) {
  return (card.deps ?? []).every((d) => {
    const dc = cardsById[d]
    const le = dc ? latestExecutionState(dc) : null
    return !!le && le.status === 'Done'
  })
}

/** Ids of unfinished dependency cards (preserves the declaration order of deps) */
export function unmetDeps(card, cardsById) {
  return (card.deps ?? []).filter((d) => {
    const dc = cardsById[d]
    const le = dc ? latestExecutionState(dc) : null
    return !le || le.status !== 'Done'
  })
}

/** Whether a normal execution generation exists (not a calibration session; per D1.7, calibration does not count as "really executed") */
export function hasRealExecution(card) {
  return card.exec_order.some((sid) => !card.executions[sid]?.calib)
}

export function newCardState(meta) {
  return {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    kind: meta.kind,
    milestone: meta.milestone,
    deps: meta.deps ?? [],
    criteria: meta.criteria ?? null,
    budget: meta.budget ?? null,
    executions: {},
    exec_order: [],
    created_at: meta.created_at,
  }
}

/** Extract all text from a content-block array ([{type:'text',text},...]). */
function extractText(v) {
  if (!Array.isArray(v)) return undefined
  let out = ''
  for (const b of v) {
    if (typeof b.text === 'string') {
      if (out.length > 0) out += '\n'
      out += b.text
    }
  }
  return out
}

function pushActivity(t, a) {
  if (t.activities.length >= MAX_ACTIVITIES) t.activities.shift()
  t.activities.push(a)
}

function pushComment(t, who, text, at) {
  if (t.comments.length >= MAX_COMMENTS) t.comments.shift()
  t.comments.push({ who, text, at })
}

/** Fold one log event (purely incremental; unknown event types are ignored). */
export function foldTask(t, ev) {
  const ty = typeof ev.type === 'string' ? ev.type : ''
  const seq = (typeof ev.seq === 'number' ? ev.seq : typeof ev.seq0 === 'number' ? ev.seq0 : 0)
  const time = (typeof ev.time === 'number' ? ev.time : typeof ev.time0 === 'number' ? ev.time0 : 0)
  if (seq > t.last_seq) t.last_seq = seq
  const data = ev.data

  switch (ty) {
    case 'turn/start': {
      if (t.status === 'Pending') t.status = 'Running'
      if (t.started_at === undefined) t.started_at = time
      t.turns += 1
      const tn = data && typeof data.turn === 'number' ? data.turn : t.turns
      t.current_turn = tn
      break
    }
    case 'step/start':
      t.steps += 1
      break
    case 'turn/end': {
      // waiting non-null = task is paused awaiting a reply (plan/acceptance): this turn ended but the task is not finished, keep the waiting state
      if (t.waiting !== null) break
      if (t.status === 'Running' || t.status === 'Pending') {
        const reason = data?.reason
        const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
        t.status = kind === 'completed' ? 'Done' : kind === 'cancelled' ? 'Cancelled' : 'Failed'
        t.finished_at = time
      }
      break
    }
    case 'session/title': {
      const title = data && typeof data.title === 'string' ? data.title : undefined
      if (title) t.title = title
      break
    }
    case 'request/context': {
      const model = data && typeof data.model === 'string' ? data.model : undefined
      if (model) t.model = model
      break
    }
    case 'user/message': {
      const src = data?.source
      if (src?.kind === 'user') {
        const text = extractText(data?.content)
        if (text && text.length > 0) pushComment(t, 'user', text, time)
      }
      break
    }
    case 'assistant/message': {
      // Accumulate token usage (§6 execution economics: usage buckets)
      const u = data?.usage
      if (u) {
        t.usage.inputTokens += typeof u.inputTokens === 'number' ? u.inputTokens : 0
        t.usage.outputTokens += typeof u.outputTokens === 'number' ? u.outputTokens : 0
        t.usage.cacheReadTokens += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
        t.usage.reasoningTokens += typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0
      }
      // Single source of the full text (matches the official deriveEventMessage: assistant/message.content is
      // the authoritative text; chunk/text-chunks are its streaming/storage intermediate forms and are not accumulated again).
      // text in content → Text activity, reasoning → Reasoning activity (appended/merged within the same turn).
      const msg = data?.message
      const content = Array.isArray(msg?.content) ? msg.content : []
      let textSeen = false
      let reasonSeen = false
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
          const last = t.activities[t.activities.length - 1]
          if (!textSeen && last && 'Text' in last && last.Text.turn === t.current_turn) {
            last.Text.text += b.text
          } else {
            pushActivity(t, { Text: { text: b.text, at: time, turn: t.current_turn } })
          }
          textSeen = true
        } else if (b?.type === 'reasoning' && typeof b.text === 'string' && b.text.length > 0) {
          const last = t.activities[t.activities.length - 1]
          if (!reasonSeen && last && 'Reasoning' in last && last.Reasoning.turn === t.current_turn) {
            last.Reasoning.text += b.text
          } else {
            pushActivity(t, { Reasoning: { text: b.text, at: time, turn: t.current_turn } })
          }
          reasonSeen = true
        }
      }
      break
    }
    case 'assistant/chunk': {
      // Streaming intermediate state: the frontend shows it live via streams; it does not go into projection activities (the authoritative text source is
      // assistant/message, avoiding duplication with the message channel —— same note as in the v1 projection).
      break
    }
    case 'text-chunks':
    case 'reasoning-chunks': {
      // JSONL storage encoding (lossless packing of assistant/chunk deltas): also kept out of the projection.
      // Text comes from assistant/message.content (live and replay take the same path).
      break
    }
    case 'tool/call': {
      const callId = data && typeof data.callId === 'string' ? data.callId : undefined
      const name = data && typeof data.name === 'string' ? data.name : undefined
      if (callId && name) {
        const args = data && typeof data.arguments === 'string' ? data.arguments : ''
        t.tool_calls.push({ call_id: callId, name, args, is_error: false })
        pushActivity(t, { ToolStart: { name, at: time, turn: t.current_turn } })
      }
      break
    }
    case 'tool/result': {
      const content = data?.message
      const c0 = Array.isArray(content?.content) ? content.content[0] : undefined
      if (c0) {
        const tid = typeof c0.toolCallId === 'string' ? c0.toolCallId : ''
        const isErr = c0.isError === true
        const tc = t.tool_calls.find((x) => x.call_id === tid)
        if (tc) tc.is_error = isErr
        pushActivity(t, { ToolResult: { name: tid, is_error: isErr, at: time, turn: t.current_turn } })
      }
      break
    }
    default:
      break
  }
}

/** Control-channel terminal state (stop_reason): end_turn → Done; cancelled → Cancelled; anything else → Failed. */
export function finishTask(t, stopReason, at) {
  // Waiting non-null = task is paused awaiting a reply: keep the waiting state, do not overwrite with a terminal state
  if (t.waiting) return
  t.status = stopReason === 'end_turn' ? 'Done' : stopReason === 'cancelled' ? 'Cancelled' : 'Failed'
  t.finished_at = at
}

// ---------- Projection store (in-memory) ----------

export function newProjection() {
  return { projects: {}, sessionProject: {}, sessionCard: {} }
}

export function ensureProject(p, id, name, path) {
  if (!p.projects[id]) p.projects[id] = { id, name, path, cards: {}, chats: {} }
}

export function ensureCard(p, projectId, meta) {
  const proj = p.projects[projectId]
  if (!proj) return
  if (!proj.cards[meta.id]) proj.cards[meta.id] = newCardState(meta)
}

/** Register a session. Empty cardId = simple chat (standalone, lives under the project's chats, not on the board). */
export function registerSession(p, sessionId, projectId, cardId) {
  p.sessionProject[sessionId] = projectId
  p.sessionCard[sessionId] = cardId
  const proj = p.projects[projectId]
  if (!proj) return
  if (cardId) {
    const card = proj.cards[cardId]
    if (!card) return
    if (!card.executions[sessionId]) card.executions[sessionId] = newTaskState(sessionId)
    if (!card.exec_order.includes(sessionId)) card.exec_order.push(sessionId)
  } else {
    if (!proj.chats[sessionId]) proj.chats[sessionId] = newTaskState(sessionId)
  }
}

/** Resolve which container a session belongs to (simple chat → chats; execution → card executions) */
function resolveSession(p, sessionId) {
  const pid = p.sessionProject[sessionId]
  const cardId = p.sessionCard[sessionId]
  const proj = p.projects[pid]
  if (!proj) return undefined
  if (cardId) return proj.cards[cardId]?.executions[sessionId]
  return proj.chats[sessionId]
}

export function foldSession(p, sessionId, ev) {
  const cardId = p.sessionCard[sessionId]
  const pid = p.sessionProject[sessionId]
  if (!pid) return
  const proj = p.projects[pid]
  if (!proj) return
  let t
  if (cardId) {
    const card = proj.cards[cardId]
    if (card) t = card.executions[sessionId] ?? (card.executions[sessionId] = newTaskState(sessionId))
  } else {
    t = proj.chats[sessionId] ?? (proj.chats[sessionId] = newTaskState(sessionId))
  }
  if (!t) return
  if (!t.id) t.id = sessionId
  foldTask(t, ev)
}

export function finishSession(p, sessionId, stopReason, at) {
  const t = resolveSession(p, sessionId)
  if (t) finishTask(t, stopReason, at)
}

export function removeProject(p, projectId) {
  delete p.projects[projectId]
  const sids = Object.keys(p.sessionProject).filter((sid) => p.sessionProject[sid] === projectId)
  for (const sid of sids) {
    delete p.sessionProject[sid]
    delete p.sessionCard[sid]
  }
}

// ---------- Marker detection (plan / calibrate / checkpoint) ----------

export const PLAN_DONE_MARKER = '[PLAN DONE]'
export const CALIBRATE_DONE_MARKER = '[ACCEPTANCE CRITERIA DONE]'
export const CHECKPOINT_DONE_MARKER = '[CHECKPOINT DONE]'

/** The last contiguous run of Text output (broken by non-Text activities such as exploration/tool calls; shared text source for marker detection and extraction) */
function lastTextSegment(t) {
  const texts = []
  for (let i = t.activities.length - 1; i >= 0; i--) {
    const a = t.activities[i]
    if (!('Text' in a)) break
    const txt = a.Text?.text ?? ''
    if (!txt) break
    texts.unshift(txt)
  }
  return texts.join('\n')
}

/**
 * Detect whether the agent has emitted the marker in its output (the last contiguous Text activities contain the marker).
 * G5 fix: only Text output counts, not Reasoning —— agents commonly discuss the marker string while thinking,
 * and counting it causes false positives of "no output yet but parked in Waiting".
 */
export function detectMarker(t, marker) {
  return lastTextSegment(t).includes(marker)
}

export function detectPlanCompletion(t) {
  return detectMarker(t, PLAN_DONE_MARKER)
}

/**
 * Extract the text the agent produced before the marker (the nearest contiguous Text output before [marker]).
 * G4 fix: only take "the last contiguous Text output", so intermediate text does not pollute the proposal.
 */
export function extractMarkerText(t, marker) {
  const joined = lastTextSegment(t)
  const idx = joined.indexOf(marker)
  if (idx >= 0) return joined.slice(0, idx).trim()
  return joined.slice(-800)
}

export function extractPlanText(t) {
  return extractMarkerText(t, PLAN_DONE_MARKER)
}
