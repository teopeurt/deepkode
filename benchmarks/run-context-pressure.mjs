// Conversation-accumulation pressure test: many consecutive rounds in one session, observing context growth and CWL eviction
// Usage: node benchmarks/run-context-pressure.mjs [group] [rounds]
//   group: baseline (no eviction) | cwl (tiered eviction)
//   rounds: number of conversation rounds (default 12)
// Output: token usage per round + eviction count + final state
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const GROUP = process.argv[2] ?? 'cwl'
const ROUNDS = Number(process.argv[3] ?? 12)
const BASE = 'http://127.0.0.1:3081'
const WS = '/tmp/hm-pressure'

function api(path, method = 'GET', body) {
  const cmd = `curl -s -X ${method} ${BASE}${path}${body ? ` -H 'content-type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : ''}`
  return JSON.parse(execSync(cmd, { encoding: 'utf8' }) || '{}')
}

async function main() {
  const ws = `${WS}-${GROUP}-${Date.now().toString(36)}`
  execSync(`bash ${join(process.cwd(), 'benchmarks/fixtures/seed.sh')} ${ws}`)
  execSync(`cd ${ws} && git init -q && git config user.email p@t && git config user.name p && git add -A && git commit -qm init`)
  const proj = api('/api/projects', 'POST', { name: `pressure-${GROUP}`, path: ws })
  const pid = proj.id
  // Create a simple chat (chat, not a card execution; POST /api/projects/:pid/chats)
  const chat = api(`/api/projects/${pid}/chats`, 'POST') ?? {}
  const sid = chat.session_id ?? chat.sid ?? chat.id
  if (!sid) { console.error('chat create failed:', JSON.stringify(chat)); process.exit(1) }

  const rows = []
  for (let i = 1; i <= ROUNDS; i++) {
    // Each round sends a message making the agent read a file + write a small change (to generate context)
    const msg = `Round ${i}: read data/items.json, add ${i} to the price of item ${(i % 3) + 1}, write it to data/round-${i}.txt, and briefly describe the current progress.`
    // POST /api/chats/:sid sends the message asynchronously → poll GET until the round completes
    api(`/api/chats/${sid}`, 'POST', { text: msg })
    const deadline = Date.now() + 180000
    let st = api(`/api/chats/${sid}`)
    while (Date.now() < deadline && ['Running', 'Pending'].includes(st?.status)) {
      await new Promise((r) => setTimeout(r, 10000))
      st = api(`/api/chats/${sid}`)
    }
    rows.push({
      round: i,
      status: st.status ?? '?',
      tokens: (st.usage?.inputTokens ?? 0) + (st.usage?.outputTokens ?? 0) + (st.usage?.cacheReadTokens ?? 0),
      steps: st.steps ?? 0,
      cost: st.cost ?? 0,
    })
    console.log(`round ${i}: status=${rows[i-1].status} tokens≈${rows[i-1].tokens} steps=${rows[i-1].steps}`)
  }

  // Eviction stats
  const evictions = api('/api/cwl/evictions')
  const ev = evictions.filter((e) => e.sid === sid).flatMap((e) => e.evicted ?? [])
  // Final full usage for the session (the real comparison metrics: input/cacheRead/output/reasoning)
  const final = api(`/api/chats/${sid}`)
  const summary = {
    group: GROUP, rounds: ROUNDS, ws,
    rows,
    evictions: ev.length,
    totalTokens: rows.reduce((a, r) => a + r.tokens, 0),
    finalStatus: rows[rows.length - 1]?.status,
    finalUsage: final?.usage ?? null,
    finalSteps: final?.steps ?? null,
    finalTurns: final?.turns ?? null,
  }
  console.log(JSON.stringify(summary, null, 2))
  const outDir = join(process.cwd(), 'results')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `pressure-${GROUP}-${Date.now().toString(36)}.json`), JSON.stringify(summary, null, 2))
}

main().catch((e) => { console.error('failed:', e.message); process.exit(1) })
