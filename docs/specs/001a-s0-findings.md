# Spec C, phase S0 findings

**Date:** 2026-11-06
**Applies to:** `docs/specs/001-deepcode-flowkit-execution-plane.md` (v0.2, approved)
**Verdict:** **GO** on the execution plane, with the transport chosen below and the amendments in §5. The two stop conditions (U1 and U3 both failing) did not occur.

## 1. Method and limits

DeepCode 2.3.1 was installed from PyPI into an isolated tool directory with a throwaway `DEEPCODE_HOME`, and driven against a scripted mock model (`spikes/s0/`). FlowKit's Temporal test harness also ran locally (Spec A and B work).

**What this proves:** DeepCode's transport, idempotency, trust, cancellation, crash recovery, permissions, and event contract.

**What it does not prove (nothing here used a real model):**
- model quality, real tool-use behaviour, or cost;
- Goals (`deepcode loop`) with confirmed checks, the independent reviewer, and pause/resume after a restart. The spec relies on these for code-changing subagents, so they are the first item of S1;
- the OS command sandbox on this machine (bubblewrap was not checked) or bash `allow` patterns;
- Anthropic, and any Fable model, through the real provider (no API key).

## 2. Answers to the unknowns

| # | Question | Result |
|---|---|---|
| U1 | Is `messageId` a real idempotency key? | **Yes.** `turn/start` twice with one `messageId` returned the same turn id and the mock saw **one** model call. Reusing the id with a different prompt is rejected: `messageId was already used with different content`. |
| U2 | How does an outside process connect? | Two paths, both working. (a) **`deepcode-app-server`** speaks documented JSON-RPC 2.0 over stdio and relays to the already-running service (`transport: websocket`, shared state: it listed the same threads). (b) The service's HTTP endpoints `/control/identity` and `/control/rpc`, authenticated by a token file and an HMAC identity proof; this is what the CLI uses internally. **Choose (a)**: public, documented, no auth code to reimplement. |
| U3 | Is trust per path? | **Yes.** A new git worktree is a separate project record, untrusted by default. A thread can be created but a turn is refused (`Project is untrusted; inspect it and use --trust explicitly`). The worker can register and trust a path it created with `project/add {path, trustState: "trusted"}`. Each worktree adds a project record; a project-removal method was not found, so cleanup is an open item. |
| U4 | Structured output from a top-level turn? | **No.** The forced `submit_result` capture tool exists only for sub-agent delegation and the Goal reviewer; the `spawn_agent` tool does not expose it, and `turn/start` has no schema parameter. The plan activity must ask for JSON, validate it in the worker, and on failure send one corrective message (new `messageId`) in the same thread. |
| U5 | Anthropic and Fable models; per-subagent model? | **Not verifiable without a key.** The model list is discovered from the provider at runtime and the repository contains no Fable entry. Native subagents inherit their parent's model (the `spawn_agent` tool has no model parameter). So per-role models mean one **thread per role**, which `orchestrate` already gives. |
| U6 | Unattended writes? | **Solved without a container for file edits.** Under `ask`, non-interactive turns deny every write. With `security.permissions: {"write": "allow", "edit": "allow"}` under `ask`, writes inside the workspace succeeded and a write to an absolute path outside it was refused ("Writes are fenced to the workspace directory"). `read-only` denies all writes. `full-access` is not needed. |
| U7 | Usage reporting? | **Yes.** A `model_usage_recorded` event carries `prompt_tokens`, `completion_tokens`, `total_tokens` per model response. New threads also make an **extra non-streamed model call** (apparently title generation), which costs tokens on the chosen connection. |
| U8 | Restart mid-turn? | **Recoverable.** Killing the **client** (SIGKILL) leaves the turn `running` in the service; SIGINT, or RPC `turn/interrupt`, stops it and closes the model stream. Killing the **service** mid-turn: on restart the turn is reconciled as `interrupted`, with its event history intact (`thread.reconciled`). It is not resumed automatically. |
| U9 | Multi-root workspaces? | **No.** `thread/start` takes one `workspacePath`. DeepCode has per-thread worktrees (`git/worktree/create|remove`, branch `deepcode/<thread>`), but in 2.3.1 a turn started in one was rejected with `thread worktree ownership is invalid` (see §4). |
| U10 | Embedding model | **Deferred to S6**, as planned. |

## 3. Behaviour the worker must handle

1. **Exit code 0 does not mean the work happened.** A turn whose only tool call was denied still ends `status=completed`, `stop_reason=completed`, exit 0 (the denial is a tool error inside the turn). The worker must decide success from evidence: the diff, the confirmed checks, or the Goal's own result, never from the turn status alone.
2. **The NDJSON event stream carries no thread or turn id.** Events have only `id` and `msg`. The session id appears on stderr at the end, or on stdout only with `--detach`. Use the RPC interface to learn ids.
3. **A client death does not stop the work.** Cancellation must be an explicit `turn/interrupt` and wait for `interrupted`.
4. **An interrupted turn is not a failed turn.** After a service crash the activity should start a new turn (new `messageId`) in the same thread and worktree, telling the agent to continue.
5. **The service starts itself on port 3081**, the port Helmsman's engine uses. They cannot run together.

## 4. Things tried that did not work

- Built-in thread worktrees: `git/worktree/create` succeeded and recorded the path, but `turn/start` failed with `thread worktree ownership is invalid`, with and without an explicit `workspacePath`. The cause may be my call sequence. It was time-boxed and is not a blocker, because worker-managed worktrees with programmatic trust work.
- `deepcode exec` without `--trust` on a new worktree path is refused (expected, and now understood).

## 5. Proposed amendments to Spec C (for approval, as v0.3)

1. **§4.1 transport:** replace "JSON-RPC (target) or `exec` (spike)" with **stdio `deepcode-app-server`**, one long-lived child per worker. Keep the `ExecutionPlane` interface.
2. **§4.2 idempotency:** use RPC `turn/start` with `messageId` set to FlowKit's idempotency key. This replaces the worker-side mapping store as the primary mechanism (the store becomes a cache of thread and turn ids).
3. **§4.3 cancellation:** `turn/interrupt`, wait for `interrupted`. Never rely on killing a client.
4. **§6 and D3:** file edits do not need a container: use `ask` plus path-scoped `allow` rules for `write` and `edit`, inside a trusted per-task worktree. Whether shell checks run unattended still needs S1 (bash allow patterns, sandbox availability).
5. **§4.4 plan activity:** worker-side JSON validation with one corrective retry; drop the reference to a capture tool.
6. **§4.4 success criteria:** judge subagent results by evidence, not by turn status (§3.1).
7. **§3:** mark U1, U2, U3, U4, U6, U7, U8 and U9 as answered; U5 stays open for a key; U10 stays for S6.

## 6. Plan changes for S1

S1 now also covers, with a real model and key: a Goal with confirmed `--check` commands and its restart/resume behaviour, bash `allow` patterns, the sandbox on the target host, Anthropic and Fable connectivity (U5), and project-record cleanup after many worktrees. The S1 exit criteria are unchanged: zero duplicate sessions after killing the worker mid-turn, and cancellation that stops the agent within a bounded time. Both now have a tested mechanism (U1, U8).
