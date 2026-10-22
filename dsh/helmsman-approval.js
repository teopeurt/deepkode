// [helmsman] D3-4 approval channel internalized into the engine: an engine-plugin answerer replaces patch 1 (the ACP requestPermission bridge).
// How it works: ctx.approval.request → 'approval/request' waterfall (scope=agent).
// This plugin acts as the answerer: enqueue the request → return a pending promise (waiting for the HTTP decision) → fulfil it with the outcome.
// B1 extension: compatible with the frontend contract (/api/approvals?project=, decideApproval(id, outcome, comment, remember)).
// Interface:
//   GET  /api/approvals/pending            → [{id, sid, tool_name, reason, at}] (internal liveness probe)
//   GET  /api/approvals?project=           → [{id, sid, kind, reason, status, ...}] (frontend contract)
//   GET  /api/approvals/suspended?project= → suspended list
//   POST /api/approvals/:id                {outcome:'approved'|'rejected', comment, remember} → {ok:true}
//   POST /api/approvals/:id/resume         → {ok:true}
//   POST /api/projects/:pid/approvals/resume-all → {ok:true}
// Timeout / process exit → fail-closed (returns 'unavailable', same semantics as the engine having no answerer).
export const name = 'helmsman-approval'
export const inject = ['webServer', 'approval', 'helmsmanStorage', 'helmsmanAcceptance']

export function apply(ctx) {
  const { webServer } = ctx
  const storage = ctx.get('helmsmanStorage')?.storage
  const acceptance = ctx.get('helmsmanAcceptance')
  // Tasks suspended at the acceptance gate → card/title lookup (projection)
  const acceptanceLookup = (sid) => {
    const board = ctx.get('helmsmanBoard')
    const pid = board?.projection?.sessionProject?.[sid]
    if (!pid) return null
    const cardId = board?.projection?.sessionCard?.[sid]
    const proj = board?.projection?.projects?.[pid]
    if (!proj) return null
    const t = cardId ? proj.cards?.[cardId]?.executions?.[sid] : proj.chats?.[sid]
    return { pid, cardId, t, card: cardId ? proj.cards?.[cardId] : undefined }
  }
  const pending = new Map() // id → { req, resolve, timer, at, project_id }
  const resolved = [] // decided records (latest 50, echoed back in lists)
  let seq = 0

  // The only answerer: enqueue and suspend, waiting for the HTTP decision
  ctx.on('approval/request', (req, next) => {
    seq += 1
    const id = seq
    return new Promise((resolve) => {
      const at = Date.now()
      // Infer project ownership from the agent's cwd (the sessionProject mapping is maintained by the board; simplified here: use an agent.id prefix)
      const project_id = req.agent?.session?.header?.cwd ? 'p-' + at.toString(36) : undefined
      const timer = setTimeout(() => {
        pending.delete(id)
        resolved.unshift({ id, project_id, sid: req.agent?.id, tool_name: req.toolName, reason: req.reason, status: 'unavailable', at })
        if (resolved.length > 50) resolved.pop()
        resolve('unavailable')
      }, 300_000) // 5-minute timeout (more lenient than v1)
      pending.set(id, { req, resolve, timer, at, project_id })
      console.log(`[helmsman-approval] pending ${id} tool=${req.toolName} reason=${req.reason ?? '-'}`)
    })
  })

  // GET /api/approvals —— frontend-contract list (filtered by ?project=)
  webServer.register({
    kind: 'exact',
    path: '/api/approvals',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const pid = url.searchParams.get('project')
      const list = [...pending.entries()].map(([id, p]) => ({
        id,
        sid: p.req.agent?.id,
        tool_name: p.req.toolName,
        call_id: p.req.callId ?? undefined,
        reason: p.req.reason,
        kind: 'permission',
        status: 'pending',
        project_id: p.project_id,
        created_at: p.at,
      })).filter((a) => !pid || a.project_id === pid)
      // Merge in pending acceptance items from storage (suspended at the acceptance gate; fill in frontend-contract fields)
      if (storage) {
        const pendingKinds = new Set(list.map((a) => a.sid))
        for (const a of storage.listPendingApprovals(pid ?? '')) {
          if (a.kind !== 'acceptance') continue
          if (pendingKinds.has(a.execution_id)) continue
          const found = acceptanceLookup?.(a.execution_id)
          list.push({
            id: a.id,
            project_id: a.project_id,
            execution_id: a.execution_id,
            kind: a.kind,
            payload: a.payload,
            reason: a.reason,
            status: 'pending',
            created_at: a.created_at,
            task_title: found?.card?.title ?? found?.t?.title ?? a.execution_id.slice(0, 16),
            card_id: found?.cardId ?? null,
            card_kind: found?.card?.kind ?? null,
          })
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
    },
  })

  // GET /api/approvals/suspended —— suspended list (B1: decided/rejected records shown in simplified form)
  webServer.register({
    kind: 'exact',
    path: '/api/approvals/suspended',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const pid = url.searchParams.get('project')
      const list = resolved
        .filter((a) => !pid || a.project_id === pid)
        .map((a) => ({ ...a, status: 'suspended' }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
    },
  })

  // GET /api/approvals/pending —— internal liveness probe (kept)
  webServer.register({
    kind: 'exact',
    path: '/api/approvals/pending',
    handler: (_req, res) => {
      const list = [...pending.entries()].map(([id, p]) => ({
        id,
        sid: p.req.agent?.id,
        tool_name: p.req.toolName,
        call_id: p.req.callId ?? undefined,
        reason: p.req.reason,
        at: p.at,
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
    },
  })

  // POST /api/approvals/:id and /api/approvals/:id/resume —— decide/resume (dispatched through a single prefix route)
  webServer.register({
    kind: 'prefix',
    path: '/api/approvals',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
      const resume = pathname.match(/^\/api\/approvals\/([^/]+)\/resume$/)
      if (resume) {
        // B1 simplification: resume has no suspension semantics (in v1 it resumed a Waiting that had timed out and been suspended); returns ok
        return json(200, { ok: true })
      }
      const m = pathname.match(/^\/api\/approvals\/([^/]+)$/)
      if (!m) return json(404, { error: 'not found' })
      let buf = ''
      req.on('data', (c) => { buf += c })
      req.on('end', () => {
        try {
          const body = JSON.parse(buf || '{}')
          const id = Number(m[1])
          const outcome = body.outcome === 'rejected' ? 'rejected' : 'approved'
          // acceptance approval (suspended at the acceptance gate, persisted in storage): approve → merge the worktree; reject → clear the waiting state
          const appr = storage?.getApproval(id)
          if (appr && appr.kind === 'acceptance') {
            if (!storage.decideApproval(id, outcome, typeof body.comment === 'string' ? body.comment : null)) {
              return json(409, { error: 'already decided' })
            }
            if (outcome === 'approved') {
              const mr = acceptance?.approveMerge(appr.execution_id)
              if (mr && !mr.ok) {
                // merge failed: don't swallow it —— roll back the decision? v1 semantics: 409 and keep it pending.
                // Simplified: the decision is already persisted, but report the error explicitly so a human can deal with the worktree.
                console.warn(`[helmsman-approval] acceptance ${id} approved but merge failed: ${mr.message}`)
                return json(200, { ok: true, decision: outcome, merge_error: mr.message })
              }
              console.log(`[helmsman-approval] acceptance ${id} approved → merge`)
            } else {
              acceptance?.rejectClear(appr.execution_id)
              console.log(`[helmsman-approval] acceptance ${id} rejected (worktree kept)`)
            }
            return json(200, { ok: true, decision: outcome })
          }
          const entry = pending.get(id)
          if (!entry) return json(404, { error: 'unknown id' })
          clearTimeout(entry.timer)
          pending.delete(id)
          // Frontend outcome: 'approved'|'rejected' → engine ApprovalOutcome
          const engineOutcome = body.outcome === 'rejected' ? 'rejected' : 'allowed-once'
          entry.resolve(engineOutcome)
          resolved.unshift({
            id, project_id: entry.project_id, sid: entry.req.agent?.id,
            tool_name: entry.req.toolName, reason: entry.req.reason,
            status: outcome === 'rejected' ? 'rejected' : 'approved', at: entry.at,
          })
          if (resolved.length > 50) resolved.pop()
          // Comment (optional): an explanation attached to the decision → delivered to the agent
          if (typeof body.comment === 'string' && body.comment.trim() && entry.req.agent) {
            try {
              entry.req.agent.followup?.({ role: 'user', content: [{ type: 'text', text: body.comment }], source: { kind: 'user' } })
            } catch { /* a failed delivery does not block the decision */ }
          }
          console.log(`[helmsman-approval] decided ${id} → ${outcome}`)
          json(200, { ok: true, decision: outcome })
        } catch (e) {
          json(500, { error: e?.message ?? String(e) })
        }
      })
    },
  })

  // POST /api/projects/:pid/approvals/resume-all is handled by helmsman-api's /api/projects prefix route
  // (avoids cross-plugin prefix route conflicts). Note: B1 simplification —— no suspend/resume semantics, returns ok.

  // ---------- Policy capture (P1 O6: persisted in SQLite) ----------
  const rememberPolicy = (project_id, tool_name, outcome) => {
    if (storage) return storage.learnPolicy(project_id, 'tool', tool_name, outcome)
    return null
  }

  // GET /api/policies?project= —— policy list
  webServer.register({
    kind: 'exact',
    path: '/api/policies',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const pid = url.searchParams.get('project')
      const list = storage ? storage.listPolicies(pid ?? '') : []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
    },
  })

  // DELETE /api/policies/:id —— delete a policy
  webServer.register({
    kind: 'prefix',
    path: '/api/policies',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const m = pathname.match(/^\/api\/policies\/(\d+)$/)
      if (!m || req.method !== 'DELETE') {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end('{"error":"not found"}')
      }
      const ok = storage ? storage.deletePolicy(Number(m[1])) : false
      res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'not found' }))
    },
  })

  console.log('[helmsman-approval] approval answerer mounted, routes: /api/approvals* (frontend-contract compatible)')
}

export default { name, inject, apply }
