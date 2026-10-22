# web —— frontend (Web first, Tauri later)

The Helmsman task-workspace frontend **P0 skeleton** (Vite + React 18 + TypeScript + zustand).
Visual/interaction source of truth: `taskboard-v9.html` (the THEMES theme contract, layout, components and copy were all extracted from it and ported as-is).

## Quick start

```bash
pnpm install    # the esbuild build is already approved via allowBuilds in pnpm-workspace.yaml, no interaction needed
pnpm dev        # http://localhost:5173 (/api and /api/events go through the Vite proxy → 127.0.0.1:3081)
pnpm build      # tsc -b && vite build
pnpm lint       # eslint (base config)
```

Prerequisite: the Rust product service runs on 3081 (the service sends no CORS headers, so you must go through the dev proxy; the proxy is configured with ws:true to support /api/events).

## Directory layout

```
web/src/
  theme/      themes.ts (THEME CONTRACT: six themes × 25 tokens + atmo spec, ported as-is)
              ThemeProvider.tsx (injects all tokens via the CSSOM; follows the system; persisted in localStorage)
              Atmosphere.tsx (renders glow/stars/blobs from the atmo spec, levels off/soft/on/strong)
  api/        client.ts (REST wrapper: projects / project / task / POST tasks / cancel)
              events.ts (WS client: exponential-backoff reconnect 1s→2s→…30s; event callbacks)
  store/      projection.ts ({pid:{sid:TaskState}} projection + state derivation + per-session cost/cache hit + usage folding)
              ui.ts (routing/sidebar/modals/toasts + hash writing)
  components/ layout (Sidebar/Topbar/Statusbar) + primitives (Button/Badge/Card/EmptyState/Modal/Switch/ThemePicker/Toast/Skeleton/Icon)
              modals/ (NewTask / Dir / Settings)
  views/      workspace home / project home / board / chat / graph / knowledge base / files / task detail drawer
  styles/     base.css (port of the prototype's visual system)
  main.tsx / App.tsx
```

## Key mechanisms

- **The engine is the only state writer**: every frontend "state change" sends an event (run = POST tasks, stop = POST cancel).
  Running cards are locked (not draggable, no action buttons, comments only). Drag / rerun / comments = target contract (not enabled in P0, marked as placeholders).
- **Blocking is computed on the fly**: unfinished dependencies are computed on every render (`depsUnmet`), never written to a state field.
- **Data flow**: REST snapshot → projection; WS events = change signals (debounced refetch, catching up by `last_seq`);
  `assistant/message.usage` is folded into per-session usage within the activeSession boundary.
- **Cost/hit rate**: per session. Price table: input ¥2 / output ¥8 / cache read ¥0.2 / reasoning ¥8 per M tokens;
  hit rate = cacheRead/(cacheRead+input). Without usage (sessions finished before a service restart) it shows —.
- **Hash routing**: `#pid=&view=&open=&tab=` (view: home|projhome|kanban|chat|graph|kb|files).

## Target contract (no fake implementations, only marked placeholders)

Comments as control, dependencies/DAG, awaiting confirmation (Waiting), briefs, knowledge base (KbNote), metrics, file tree, project registration
(POST /api/projects is not enabled: a project is registered when its first task card is POSTed to tasks with a cwd).
