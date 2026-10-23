// Helmsman CWL comparison experiment (paper-grade validation data)
// Usage: node benchmarks/run-cwl-experiment.mjs <group> [tasksFile] [budgetTokens]
//   group: baseline | summary | cwl
//   baseline = no management (engine default, no eviction)
//   summary  = summary compression (the ACP route: the model writes a summary that replaces history)
//   cwl      = structured eviction (the standalone dsh-cwl plugin, deterministic stripping within budget)
// Output: JSON results (stdout), including per-task status/steps/cost/eviction count/acceptance
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const GROUP = process.argv[2] ?? 'baseline'
const TASKS_FILE = process.argv[3] ?? new URL('./data/long-tasks.json', import.meta.url).pathname
const BUDGET = process.argv[4] ?? '6000' // a low budget simulates long-task pressure (tokens)
const BASE = 'http://127.0.0.1:3081'
const WS_ROOT = '/tmp/hm-bench'

const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf8'))

function api(path, method = 'GET', body) {
  const res = execSync(`curl -s -X ${method} ${BASE}${path}${body ? ` -H 'content-type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : ''}`, { encoding: 'utf8' })
  return JSON.parse(res || '{}')
}

async function main() {
  const runId = `${GROUP}-${Date.now().toString(36)}`
  const ws = `${WS_ROOT}-${runId}`
  // Generate the project fixture
  execSync(`bash ${new URL('./fixtures/seed.sh', import.meta.url).pathname} ${ws}`, { encoding: 'utf8' })
  execSync(`cd ${ws} && git init -q && git config user.email bench@t && git config user.name bench && git add -A && git commit -qm init`, { encoding: 'utf8' })

  // Create the project
  const proj = api('/api/projects', 'POST', { name: `bench-${GROUP}`, path: ws })
  const pid = proj.id
  if (!pid) throw new Error(`project create failed: ${JSON.stringify(proj)}`)

  const results = []
  for (const t of tasks) {
    // A separate subdirectory per task (avoids file conflicts), used as the card path
    const card = api(`/api/projects/${pid}/cards`, 'POST', {
      title: t.title,
      kind: 'task',
      criteria: t.acceptance,
    })
    const cid = card.card_id
    const brief = t.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    const task = api('/api/tasks', 'POST', {
      cwd: ws,
      brief,
      project_id: pid,
      card_id: cid,
    })
    const sid = task.session_id
    results.push({ id: t.id, title: t.title, sid, cardId: cid, acceptance: t.acceptance })
  }

  // Wait for everything to finish
  const deadline = Date.now() + 20 * 60 * 1000
  while (Date.now() < deadline) {
    const cards = api(`/api/projects/${pid}/cards`)
    const pending = cards.filter((c) => ['Running', 'Pending'].includes(c.latest?.status))
    if (pending.length === 0) break
    await new Promise((r) => setTimeout(r, 20000))
  }

  // Collect results
  const metrics = api(`/api/metrics?project=${pid}`)
  const bySid = {}
  for (const m of metrics) bySid[m.task_id] = m

  const evictions = api('/api/cwl/evictions')
  const evictCounts = {}
  for (const e of evictions) evictCounts[e.sid] = (e.evicted ?? []).length

  for (const r of results) {
    const m = bySid[r.sid] ?? {}
    // Acceptance: check the artifacts in the main workspace (the acceptance commands are file checks)
    let accepted = false
    try {
      // Simplified acceptance: check whether the task's artifact file exists (rough check from the test -f/grep in acceptance)
      const acc = r.acceptance
      const f = (acc.match(/test -f ([^\s]+)/) || [])[1]
      if (f) accepted = existsSync(join(ws, f.replace(/'/g, '')))
    } catch {}
    r.status = m.outcome ?? 'unknown'
    r.steps = m.steps ?? 0
    r.cost = m.cost ?? 0
    r.evicted = evictCounts[r.sid] ?? 0
    r.accepted = accepted
  }

  const summary = {
    runId,
    group: GROUP,
    budget: Number(BUDGET),
    tasks: results,
    totals: {
      done: results.filter((r) => r.status === 'Done').length,
      accepted: results.filter((r) => r.accepted).length,
      steps: results.reduce((a, r) => a + r.steps, 0),
      cost: results.reduce((a, r) => a + r.cost, 0),
      evictions: results.reduce((a, r) => a + r.evicted, 0),
    },
  }
  console.log(JSON.stringify(summary, null, 2))

  // Save the results
  const outDir = new URL(`../results/`, import.meta.url).pathname
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${runId}.json`), JSON.stringify(summary, null, 2))
  console.log(`\n[results saved] ${outDir}${runId}.json`)
}

main().catch((e) => { console.error('experiment failed:', e.message); process.exit(1) })
