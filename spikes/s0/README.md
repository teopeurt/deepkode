# S0 probes

Scripts used for spike phase S0 of `docs/specs/001-deepcode-flowkit-execution-plane.md`. Results are in `docs/specs/001a-s0-findings.md`.

They drive a real DeepCode 2.3.1 against a **scripted mock model**, so no API key is needed. They test DeepCode's transport and lifecycle behaviour, not model quality.

| File | Purpose |
|---|---|
| `mock_llm.py` | OpenAI-compatible streaming server. The first user message selects the behaviour with a marker: `MARK:TEXT`, `MARK:SLOW` (about 24 s of streamed words), `MARK:WRITE <path>` (asks the `write` tool for a file), `MARK:JSON`. Every request is appended to a log, so duplicate model calls can be counted. |
| `probe_rpc.py` | JSON-RPC probes using DeepCode's own client: `idempotency <path>`, `trust <path>`, `read <thread> <turn>`, `interrupt <thread> <turn>`, `events <thread>`. |
| `probe_wt.py` | Exercises DeepCode's built-in per-thread worktree (`git/worktree/create`). |

## Running

```console
uv tool install --python 3.12 deepcode-hku      # use an isolated UV_TOOL_DIR / UV_TOOL_BIN_DIR
export DEEPCODE_HOME=$PWD/home MOCK_KEY=sk-mock # a throwaway home, never your real ~/.deepcode
python3 mock_llm.py 18080 mock.log &
deepcode init
deepcode provider set mock --template custom --adapter openai_compat \
  --api-base http://127.0.0.1:18080/v1 --catalog openai --api-key-env MOCK_KEY
deepcode provider test mock --model mock-1
```

Run the probe scripts with the Python from DeepCode's own tool environment (they import `app_server` and `core`). They use a trusted toy repository you create yourself:

```console
mkdir -p work/toy && cd work/toy && git init && git commit --allow-empty -m init && cd ../..
<tool-venv>/bin/python probe_rpc.py idempotency $PWD/work/toy
```

The first DeepCode command starts a background service on `127.0.0.1:3081`. Stop it with `deepcode service stop` when finished.
