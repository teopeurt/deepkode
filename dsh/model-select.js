// [helmsman] In-session model switching plugin (native engine-ecosystem form, not an ACP patch).
// How it works: dsh-agent's official installModelSelection(agentCtx, selection) —— attaches a mutable selection
// to the agent's request routing (agent/request + system-prompt/assemble waterfall);
// a change to selection.current takes effect on the next turn. Same model-switching mechanism as the official web / dsh-tui.
// This plugin: on agent/inbox/claimed (the agent received a message and is about to start a request), read this
// session's selected model from a shared file → update that agent's selection. The shared file is written by the Helmsman server.
import { readFileSync } from 'node:fs'
import { installModelSelection } from '@deepseek-ai/dsh-agent'

const MODEL_FILE = process.env.HELMSMAN_MODEL_FILE ?? '.helmsman/model-selection.json'
const DEFAULT_PROVIDER = 'deepseek-official'

/** Read the shared file: { [sessionId]: model } (tolerates corruption). */
function readSelection() {
  try {
    const parsed = JSON.parse(readFileSync(MODEL_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export const name = 'helmsman-model-select'
export const inject = ['agents']

export function apply(ctx) {
  // Installed selection table: agent id → { disposer, selection } (current is refreshed on every message)
  const installed = new Map()

  ctx.on('agent/inbox/claimed', ({ agent }) => {
    if (!agent?.session?.id) return
    const sid = agent.session.id
    // First time: install model selection (attaches an agent-scoped waterfall)
    if (!installed.has(agent.id)) {
      const selection = { current: undefined, assembled: undefined }
      const dispose = installModelSelection(agent.ctx, selection)
      installed.set(agent.id, { selection, dispose })
      // Clean up when the agent is disposed
      agent.ctx.on('agent/disposed', () => {
        try { dispose() } catch { /* idempotent */ }
        installed.delete(agent.id)
      })
    }
    // Refresh the currently selected model (shared file)
    const selection = readSelection()
    const model = selection[sid]
    const entry = installed.get(agent.id)
    if (entry && typeof model === 'string' && model) {
      entry.selection.current = { provider: DEFAULT_PROVIDER, model }
    } else if (entry) {
      entry.selection.current = undefined // nothing selected → fall back to the engine default
    }
  })
}

export default { name, inject, apply }
