# dsh engine composition

helmsman's engine layer: a spawned dsh (Node) child process. Control goes over ACP (stdin/stdout); observation goes through the JSONL session logs (`.sessions/`).

## Composition (cordis.yml)

A granular spine (modeled on dsh's headless-agent composition) + an ACP control channel:

- **No session-query**: an architectural decision (architecture-v1.md §2.1) —— observation = tailing the JSONL logs; we build the derived index ourselves (SQLite on the Rust side).
- **No dependency on the acp-demo bundle**: it unconditionally mounts SessionQuerySqlite (needs an extra DB), and it is a demo composition.
- One agent per task: `agent-spine` has `agents: []`; ACP `session/new` creates them on demand.
- Model: `deepseek-v4-flash` (P0 default; the tiering strategy is in spec §6).

## Where dependencies come from

`~/.dsh/source/current` (the compiled install after each branch pull). `dsh/node_modules` is a symlink farm (the same pattern as dsh's own `$DSH_HOME/profiles/node_modules`), rebuilt with:

```sh
# Rebuild the package.json dependencies + symlinks from the bare plugin names in the current cordis.yml
python3 - <<'PY'
import re, subprocess, os, json
D = os.path.expanduser('~/.dsh/source/current')
s = open('cordis.yml').read()
names = sorted(set(re.findall(r"name: '(@deepseek-ai/[^']+)'", s))) + ['@deepseek-ai/dsh-app-boot']
deps = {}
for n in sorted(set(names)):
    out = subprocess.run(['grep','-rl',f'"name": "{n}"','--include=package.json','packages'],
                         cwd=D, capture_output=True, text=True).stdout.split()
    if out:
        deps[n] = f"file:{D}/{os.path.dirname(out[0])}"
json.dump({"name":"helmsman-dsh","private":True,"type":"module","dependencies":deps},
          open('package.json','w'), indent=2, ensure_ascii=False)
for n, spec in deps.items():
    t = os.path.normpath(os.path.join('node_modules', n))
    os.makedirs(os.path.dirname(t), exist_ok=True)
    if os.path.lexists(t): os.remove(t)
    os.symlink(os.path.normpath(spec.replace('file:','')), t)
PY
# tsx (the loader needs tsx to resolve config-relative bare package names; dsh itself also starts with node --import tsx/esm)
ln -sfn ~/.dsh/source/current/node_modules/tsx node_modules/tsx
```

## Running (important: cwd must be the dsh checkout root)

The loader resolves bare plugin names via tsconfig `paths`, and tsx finds the tsconfig by **cwd** ——
so you **must start from the dsh checkout root** (same as `pnpm dsh` running from source; the current default is
`~/Code/github/opensource/test-kalifun`, overridable with `HELMSMAN_DSH_ROOT`).
Use absolute paths, and set persistence/workspace via environment variables (so nothing is written into the checkout):

```sh
DSH_ROOT=~/Code/github/opensource/test-kalifun
cd $DSH_ROOT
mkdir -p $PWD/../helmsman-sessions   # sessions outside the repo? see below

HELMSMAN_SESSIONS_ROOT=~/.dsh/source/current/.sessions \
HELMSMAN_WORKSPACE=~                       \
node --import tsx/esm /path/to/helmsman/dsh/launcher.mjs /path/to/helmsman/dsh/cordis.yml
# Keep it running: stdin/stdout is the ACP channel (the Rust product service spawns it, see crates/spawn)
```

The Rust `spawn` module already implements this shape (cwd = install root + absolute paths + HELMSMAN_* environment variables).

## Caveats

- **After changing the compression config you must clear `.sessions/`**: the backend detects the old artifact format
  (`.jsonl.zstd` vs `.jsonl`) and refuses to load on a format mismatch.
