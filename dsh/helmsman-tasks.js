// [helmsman] Task orchestration plugin (in-engine): the agents.create/followup driving surface.
// Provides the internal service helmsmanTasks (called by helmsman-api):
//   createTask({cwd, brief, preset, project_id, card_id}) → {sid}
//   sendComment(sid, text) → {ok}
//   getTaskStatus(sid) → {sid, status, reply}
// HTTP routes all live in helmsman-api (avoids /api/tasks route conflicts).
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'helmsman-tasks'
export const inject = ['agents', 'sessions', 'agentPresets', 'helmsmanBoard', 'helmsmanStorage', 'helmsmanWorktree', 'helmsmanKb']

export function apply(ctx) {
  const { agents, sessions } = ctx
  const board = ctx.get('helmsmanBoard')
  const storage = ctx.get('helmsmanStorage')?.storage
  const worktree = ctx.get('helmsmanWorktree')

  ctx.provide('helmsmanTasks', {
    /** Create a task: in-engine agents.create + first instruction (if sendBrief=false nothing is sent; wait for later input). Returns {sid, isolated}. */
    async createTask({ cwd, brief, preset, project_id, card_id, sendBrief = true, internalize = false }) {
      const sid = SessionId(`task-${randomUUID().slice(0, 12)}`)
      const pid = project_id ?? 'default'
      // Task-level isolation: git repo → worktree (the agent runs in the isolation area and does not write the main workspace); non-git/failure falls back to the project directory
      let runCwd = cwd
      let worktreeInfo = null
      let isolated = false
      if (worktree && card_id) {
        const wt = worktree.prepare(cwd, card_id, sid.slice(0, 8))
        if (wt) {
          runCwd = wt.path
          worktreeInfo = wt
        } else {
          isolated = true // M5: isolation area unavailable → visible flag (frontend shows "running in shared directory")
        }
      }
      // Register the projection first, then create the agent: session/event starts right after create, so registration must come first
      if (board && (project_id || card_id)) {
        if (card_id) {
          const card = board.projection.projects?.[pid]?.cards?.[card_id]
          if (!card) {
            if (worktreeInfo) worktree.discard(cwd, worktreeInfo)
            throw new Error(`card '${card_id}' not in project '${pid}'`)
          }
        }
        board.registerSession(sid, pid, card_id ?? '')
        // Simple chat: write to the chat_sessions table (restored into the project's chats after a restart, not on the board)
        if (storage && !card_id) {
          storage.registerChat(sid, pid)
        }
        // Persist the execution snapshot (authoritative source for restoring the session→card mapping after a restart)
        if (storage && card_id) {
          const created = Date.now()
          storage.upsertExecution({
            id: sid, card_id, status: 'Pending', preset_json: '{}', deps_json: '[]',
            forked_from: null, started_at: null, finished_at: null, created_at: created,
          })
        }
        // Write the execution's workspace info into the projection (frontend shows the isolation state)
        const t = board.projection.projects?.[pid]?.cards?.[card_id]?.executions?.[sid]
        if (t) {
          t.worktree = worktreeInfo
          t.isolated = isolated
        }
      }
      const { agent } = await agents.create({
        sessionId: sid,
        meta: { cwd: runCwd },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        // Task-level assembly: preset mounting (native replacement for patch 3) + model-selection hook point
        setup: async (agentCtx) => {
          if (preset) {
            const presets = ctx.get('agentPresets')
            if (presets) await presets.mount(agentCtx, preset)
          }
        },
      })
      if (sendBrief && brief) {
        // Task-start assembly (D3-9): project knowledge-base hits + stable prefix → first prompt
        let promptText = brief
        try {
          const kb = ctx.get('helmsmanKb')
          if (kb?.assembleTaskPrompt && (project_id || card_id)) {
            // Assemble (including the hit list) and record kbHits in the projection (shown in the frontend brief tab)
            const assembled = await kb.assembleTaskPromptFull({
              taskTitle: brief, // v2's brief = the task execution instruction (v1's title+description combined)
              taskDescription: '',
              projectId: pid,
              brief: true,
              internalize,
            })
            if (assembled) {
              promptText = assembled.prompt
              const t = board?.projection?.projects?.[pid]?.cards?.[card_id]?.executions?.[sid]
              if (t) t.brief_snapshot = assembled.kbHits
            }
          }
        } catch (e) {
          console.warn(`[helmsman-tasks] assembly failed (falling back to the raw brief):`, e?.message ?? e)
        }
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: promptText }],
          source: { kind: 'user' },
        }))
      }
      console.log(`[helmsman-tasks] created ${sid} cwd=${runCwd} project=${pid ?? '-'} card=${card_id ?? '-'}${isolated ? ' (ISOLATION FAILED)' : ''}${sendBrief ? '' : ' (waiting input)'}`)
      return { sid, isolated, worktree: worktreeInfo }
    },

    /** Cancel: in-engine agent.cancel (replaces v1's ACP session/cancel). */
    cancelTask(sid) {
      const agent = agents.get(SessionId(sid))
      if (!agent) return false
      agent.cancel('user-cancelled')
      return true
    },

    /** Comments = control channel: followup drives the agent. */
    async sendComment(sid, text) {
      // Historical session (not resumed after a restart): resume first to get a live agent, then drive it
      let agent = agents.get(SessionId(sid))
      if (!agent) {
        try {
          const resumed = await agents.resume({
            resumeSessionId: SessionId(sid),
            agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          })
          agent = resumed?.agent
        } catch (e) {
          throw new Error(`task ${sid} not resumeable: ${e?.message ?? e}`)
        }
      }
      if (!agent) throw new Error(`task ${sid} not live`)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return { ok: true }
    },

    /** Fork a session: copy the original session's history into a new session (continues independently without affecting the original). Returns {sid}. */
    async forkTask({ sid, project_id, card_id }) {
      // The source session needs a live agent: historical sessions (not resumed after a restart) are resumed first
      let srcAgent = agents.get(SessionId(sid))
      if (!srcAgent) {
        try {
          const resumed = await agents.resume({
            resumeSessionId: SessionId(sid),
            agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          })
          srcAgent = resumed?.agent
        } catch (e) {
          throw new Error(`task ${sid} not resumeable: ${e?.message ?? e}`)
        }
      }
      if (!srcAgent?.session) throw new Error(`task ${sid} not live`)
      const events = srcAgent.session.events
      const seed = events.filter((ev) => ev.seq !== undefined || ev.seq0 !== undefined)
      const newSid = SessionId(`task-${randomUUID().slice(0, 12)}`)
      const pid = project_id ?? board?.projection?.sessionProject?.[sid] ?? 'default'
      const { agent } = await agents.create({
        sessionId: newSid,
        meta: {
          cwd: srcAgent.session.header?.cwd ?? process.cwd(),
          parentSession: srcAgent.session.id,
          seedLength: seed.length,
        },
        seed,
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })
      // Fold the seed history into the projection (the board only folds live events; the seed has to be added manually)
      if (board) {
        board.registerSession(newSid, pid, card_id ?? '')
        for (const ev of seed) board.fold(newSid, ev)
        if (storage && card_id) {
          storage.upsertExecution({
            id: newSid, card_id, status: 'Pending', preset_json: '{}', deps_json: '[]',
            forked_from: sid, started_at: null, finished_at: null, created_at: Date.now(),
          })
        }
        if (storage && !card_id) storage.registerChat(newSid, pid)
      }
      console.log(`[helmsman-tasks] forked ${sid} → ${newSid} (${seed.length} events)`)
      return { sid: newSid }
    },

    /** Task status: if the agent is live, read the session log in real time; otherwise query the projection. */
    getTaskStatus(sid) {
      const agent = agents.get(SessionId(sid))
      if (agent) {
        return {
          sid: agent.id,
          status: agent.status,
          reply: extractAssistantText(agent.session.events),
        }
      }
      // Not live (e.g. after an engine restart) → query the projection
      const pid = board?.projection?.sessionProject?.[sid]
      if (!pid) return { sid, status: 'unknown', reply: '' }
      const cardId = board.projection.sessionCard?.[sid]
      const proj = board.projection.projects?.[pid]
      const t = cardId ? proj?.cards?.[cardId]?.executions?.[sid] : proj?.chats?.[sid]
      return { sid, status: t?.status ?? 'unknown', reply: extractTaskReply(t) }
    },
  })

  console.log('[helmsman-tasks] orchestration service provided: helmsmanTasks')
}

/** Extract the last assistant text from the session log. */
function extractAssistantText(events) {
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

/** Extract the last Text activity from a projection TaskState. */
function extractTaskReply(t) {
  if (!t) return ''
  const texts = []
  for (let i = t.activities.length - 1; i >= 0; i--) {
    const a = t.activities[i]
    if ('Text' in a) texts.unshift(a.Text.text)
    if (texts.length >= 3) break
  }
  return texts.join('\n')
}

export default { name, inject, apply }
