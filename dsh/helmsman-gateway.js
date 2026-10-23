// [helmsman] D3-1 gateway first: mount an HTTP server inside the engine process (reusing the official dsh-host-webserver).
// Validates the premise that the engine process can act as a server —— all of helmsman-api's /api routes are mounted here later.
// This plugin only validates the transport layer (route registration + responses); it contains no business logic.
export const name = 'helmsman-gateway'
export const inject = ['webServer']

export function apply(ctx) {
  const { webServer } = ctx

  // GET /api/health —— liveness probe
  webServer.register({
    kind: 'exact',
    path: '/api/health',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        engine: 'dsh',
        plugin: name,
        port: webServer.port,
      }))
    },
  })

  // GET /api/ping —— second validation route (proves multiple routes can be registered)
  webServer.register({
    kind: 'exact',
    path: '/api/ping',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pong: true, t: Date.now() }))
    },
  })

  console.log(`[helmsman-gateway] HTTP routes registered: /api/health /api/ping (port=${webServer.port})`)
}

export default { name, inject, apply }
