// [helmsman] Observation/projection plugin: live session/event stream → board projection (the projection owner).
// Owns the Projection (helmsman-projection pure functions) and folds engine session/events into it.
// Provides internal services: registerSession / getProjection (used by the tasks/api plugins via ctx.provide).
// Replaces v1's tail.ts (polling the JSONL) + recovery.ts (startup replay) + the projection ownership in index.ts.
export const name = 'helmsman-board'
export const inject = ['sessions', 'webServer']

import { WebSocketServer } from 'ws'
import {
  newProjection,
  ensureProject,
  ensureCard,
  registerSession,
  foldSession,
  foldTask,
  removeProject,
} from './helmsman-projection.js'

export function apply(ctx) {
  const { webServer } = ctx
  const proj = newProjection()

  // Live folding: session/event → foldSession (equivalent to v1 tailer → foldTask, but live and without polling)
  ctx.on('session/event', (session, event) => {
    if (!session?.id || !event) return
    // Only fold registered sessions (those with a sessionProject mapping); unregistered sessions (e.g. distill's internal sessions) are ignored
    if (proj.sessionProject[session.id] !== undefined) {
      foldSession(proj, session.id, event)
    }
  })

  // Internal service for other plugins (helmsman-api / helmsman-tasks use it via ctx.get('helmsmanBoard'))
  ctx.provide('helmsmanBoard', {
    get projection() { return proj },
    ensureProject: (id, name, path) => ensureProject(proj, id, name, path),
    ensureCard: (projectId, meta) => ensureCard(proj, projectId, meta),
    registerSession: (sessionId, projectId, cardId) => registerSession(proj, sessionId, projectId, cardId),
    fold: (sessionId, ev) => foldSession(proj, sessionId, ev),
    foldTask: (t, ev) => foldTask(t, ev),
    removeProject: (projectId) => removeProject(proj, projectId),
    sessions: () => proj.sessionProject,
  })

  // ---------- /api/events: live event push (WS + SSE) → frontend projection store ----------
  // The frontend expects {type, seq, time, data} (the native session/event shape). WS preferred, SSE as fallback.
  // WS uses the same ws library as the official build (WebSocketServer noServer + handleUpgrade); no hand-written frames.
  const wss = new WebSocketServer({ noServer: true })
  const sseClients = new Set() // set of ServerResponse objects (SSE streams)

  // Forward: session/event → every WS/SSE client (session id attached so the frontend can route it)
  const forwardEvent = (session, event) => {
    const frame = { ...event, id: session?.id }
    const data = JSON.stringify(frame)
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try { client.send(data) } catch { /* ignore broken connections */ }
      }
    }
    for (const res of sseClients) {
      try { res.write(`data: ${data}\n\n`) } catch { sseClients.delete(res) }
    }
  }

  // WS upgrade: /api/events (official pattern: mux.handleUpgrade)
  webServer.registerUpgrade({
    path: '/api/events',
    handler: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    },
  })

  // SSE fallback: GET /api/events
  webServer.register({
    kind: 'exact',
    path: '/api/events',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405); return res.end()
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
    },
  })

  // Observation stats route (left over from D3-3, kept as a liveness probe)
  webServer.register({
    kind: 'exact',
    path: '/api/board/stats',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        projects: Object.keys(proj.projects).length,
        sessions: Object.keys(proj.sessionProject).length,
        cards: Object.values(proj.projects).reduce((n, p) => n + Object.keys(p.cards).length, 0),
      }))
    },
  })

  // Forward inside the session/event listener (same source as fold)
  ctx.on('session/event', (session, event) => {
    if (!session?.id || !event) return
    forwardEvent(session, event)
  })

  console.log('[helmsman-board] projection owner ready, folding session/events live')
}

export default { name, inject, apply }
