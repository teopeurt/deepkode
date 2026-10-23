// [helmsman] Experiment: orchestrate agents directly inside the engine process (zero ACP patches).
// Validated chain:
//   1. ctx.agents.create({ sessionId, meta:{cwd}, agentOptions, setup }) —— create a task session inside the engine
//   2. handle.agent.followup(createUserMessage(...)) —— drive it directly, not through ACP session/prompt
//   3. read session/event (assistant/message) from agent.session.events to get the result —— the observation channel is the log
//   4. handle.dispose() to destroy it
//   5. ctx.agents.resume({ resumeSessionId }) —— natively resume the persisted session and continue the conversation
// Everything uses native engine APIs, proving server-ts's orchestration logic can move into the engine process.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'helmsman-tasks-probe'
export const inject = ['agents', 'sessions']

export function apply(ctx) {
  // Same as headless: wait for the loader to finish (scoped tools / adapters assembled) before creating the agent
  ctx.get('loader')?.await().then(async () => {
    try {
      await runProbe(ctx)
    } catch (err) {
      console.error('[tasks-probe] FAILED:', err?.message ?? err)
      process.exitCode = 1
    } finally {
      // End of the experiment: the engine process exits gracefully (without relying on ACP's stdin EOF)
      process.exit()
    }
  })
}

async function runProbe(ctx) {
  const agents = ctx.agents
  const sessions = ctx.sessions
  const sid = SessionId(`probe-${randomUUID().slice(0, 8)}`)
  const cwd = process.env.HELMSMAN_WORKSPACE ?? process.cwd()
  console.log(`[tasks-probe] create agent session=${sid} cwd=${cwd}`)

  // 1. Create a task session inside the engine (equivalent to server-ts's "new task")
  const { agent, dispose } = await agents.create({
    sessionId: sid,
    meta: { cwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: (agentCtx) => {
      // Task-level assembly hook point: preset mount / model selection both happen here (official extension point)
      console.log('[tasks-probe] setup(agentCtx) ran — task-level tool/persona assembly point')
    },
  })
  console.log(`[tasks-probe] agent created id=${agent.id} status=${agent.status}`)

  // 2. Drive one round directly (equivalent to server-ts's "submit comment / task instruction")
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Answer in one sentence: what is 1+1? Output only the answer.' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)

  // 3. Read the result from the session log (observation channel —— no need to tail the JSONL, the events are the log)
  const assistantText = extractAssistantText(agent.session.events, firstSeq)
  console.log(`[tasks-probe] round-1 reply: ${JSON.stringify(assistantText)}`)

  // 4. Dispose (equivalent to the task ending)
  await dispose()
  console.log('[tasks-probe] agent disposed')

  // 5. Native resume: restore the same session and continue the conversation (equivalent to server-ts's "resume a historical task")
  const resumed = await agents.resume({
    resumeSessionId: sid,
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  console.log(`[tasks-probe] resumed agent id=${resumed.agent.id} status=${resumed.agent.status}`)
  const secondSeq = resumed.agent.session.seq
  resumed.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Continue: please repeat what you said in the previous round.' }],
    source: { kind: 'user' },
  }))
  await resumed.agent.whenIdle()
  await sessions.flush(resumed.agent.session)
  const resumedText = extractAssistantText(resumed.agent.session.events, secondSeq)
  console.log(`[tasks-probe] round-2 reply: ${JSON.stringify(resumedText)}`)

  await resumed.dispose()
  console.log('[tasks-probe] OK — in-engine task creation + native resume chain fully working')
}

/** Extract the text of the last assistant/message after a given seq from the session-log events. */
function extractAssistantText(events, afterSeq) {
  let text = ''
  for (const ev of events) {
    if (ev.seq === undefined || ev.seq <= afterSeq) continue
    if (ev.type !== 'assistant/message') continue
    const msg = ev.message ?? ev.data?.message ?? {}
    text = (msg.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('')
  }
  return text
}

export default { name, inject, apply }
