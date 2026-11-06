# Spec C: DeepCode as the execution plane for FlowKit (Option B)

**Status:** DRAFT v0.1, awaiting approval. Nothing here is built.
**Depends on:** Spec A (`gate: auto`) and Spec B (`orchestrate`), both implemented on the local, **unpushed** FlowKit branch `feat/auto-gated-ai-steps` (`51dcb7c`, `bbe959b`). FlowKit 1.1.0 is not published, so this work links to a local checkout until it is.
**Replaces:** Helmsman's engine (`dsh/` plugins). Helmsman is retired, not fixed. Nothing has been deleted yet: that happens on this branch only after S0 gives a go.
**Lives in:** `teopeurt/deepkode`, on branch `claude/deepcode-flowkit-execution-plane` (decision D6, made by the project owner). Specs A and B live with FlowKit, not here.
**Nature of this document:** a design plus a time-boxed spike plan. It has more unknowns than Specs A and B; §3 lists which statements are verified and which are not.

---

## 1. Goal

Run an autonomous, production-grade engineering workflow in which:

- **FlowKit on Temporal** decides *what happens, in what order, who approves, when it times out, and what the audit trail says*.
- **DeepCode** does the *agent work*: reading and editing code, running tests, verifying, in sandboxed, isolated workspaces.
- Inputs (call notes, customer email, Slack, crash reports) enter as FlowKit signals or workflow starts.
- Every workflow plans, then gets an adversarial critique of the plan, *then* executes. Models are chosen per role, not globally.

**Non-goals for this spec:** a custom UI, a knowledge base, the input connectors themselves (contract only, §9), multi-tenant operation, and any change to FlowKit beyond Specs A and B.

## 2. Architecture

```
 inputs (Slack / email / notes / crash)          Temporal server
        │  normalize, dedupe, signal                  │
        ▼                                             ▼
 ┌──────────────┐   start / signal   ┌─────────────────────────────┐
 │ intake       │ ─────────────────▶ │ FlowKit workflow (control)  │
 │ adapters     │                    │  stages, gates, SLA, audit  │
 └──────────────┘                    └──────────────┬──────────────┘
                                                    │ activities
                                     ┌──────────────▼──────────────┐
                                     │ worker (TypeScript)         │
                                     │  plan / runSubagent /       │
                                     │  synthesize / recordTransition
                                     └──────────────┬──────────────┘
                              JSON-RPC (target) or `deepcode exec` (spike)
                                     ┌──────────────▼──────────────┐
                                     │ DeepCode service (Python)   │
                                     │  sessions, goals, sandbox,  │
                                     │  approvals, providers, MCP  │
                                     └──────────────┬──────────────┘
                                                    ▼
                                       git worktree per subagent task
```

| Concern | Owner |
|---|---|
| Stage graph, ordering, gates, human approval, SLA timers, escalation, audit | FlowKit / Temporal |
| Retries, timeouts, durability across restarts, cancellation | Temporal |
| Agent loop, tools, sandbox, per-tool approvals, model calls | DeepCode |
| Verified completion of one unit of work (checklist, reviewer) | DeepCode Goals |
| Which model each role uses | Worker configuration (not the definition) |
| Worktree creation, merge, conflict handling for FlowKit subagents | Worker |

**Nesting rule.** `orchestrate` is the only fan-out across subagents in a flow. DeepCode's own `spawn_agent` is not used for that. It may still be used *inside* a single activity for small helpers, because it is model-driven and not durable and would otherwise nest two orchestrators.

## 3. What is verified, and what is not

**Verified by reading the DeepCode source and docs (it was not run):**

1. `deepcode exec --json` emits one JSON event per line with `msg.type`, including `turn_started`, `tool_started`, `tool_completed`, `agent_message`, `error`, and `task_complete` (with `stop_reason`).
2. `exec` exits 0 only if the turn completed, 1 otherwise, and 130 on interrupt. `--detach` returns `{threadId, turnId, status, detached}` and exits 0.
3. **`exec` has no idempotency key.** Retrying it starts a second session and turn.
4. SIGINT makes `exec` call `turn/interrupt`. Cancelling only the client waiter does not stop an already-admitted turn, so killing the process leaves the turn running in the service.
5. In non-interactive Ask mode an approval that cannot be answered is denied. `--access` takes `read-only`, `ask`, or `full-access`; `--access full-access` removes approvals and the sandbox.
6. The JSON-RPC protocol has `thread/start` (`projectId`, `workspacePath`, `agentPreset`, `parentThreadId`, `connectionId`, `model`, `reasoningEffort`), `turn/start` (requires a caller-supplied **`messageId`**), `turn/interrupt`, `turn/read`, an event-replay method, and approval-respond. The service listens on `127.0.0.1` and clients authenticate with a token file.
7. Goals can carry confirmed check commands (`--check`, `--test-cmd`), a token or time budget, and an optional independent read-only reviewer. A Goal active at restart is **paused**, not continued, and `deepcode loop --resume SESSION_ID` continues it.
8. Native subagents are model-driven, at most 5 concurrent, depth 1, isolated in worktrees by default, merged back with git's 3-way merge reporting conflicts. External `codex` and `claude-code` CLIs are available as subagent backends.
9. A new workspace needs project trust (`--trust`, once per project).

**Not verified (each is a spike question, §10):**

- U1. That `turn/start`'s `messageId` is a true idempotency key (a repeated id returns the same turn rather than a second one).
- U2. How an out-of-process client connects: the service's HTTP/WebSocket surface with the token file, or a stdio app-server per client. The P1 architecture doc describes stdio only; the service evidently has a network surface.
- U3. Whether trust is per path, so every new git worktree needs a trust step, and how to do that non-interactively and safely.
- U4. Whether a top-level turn can return schema-validated structured output. A forced `submit_result` capture tool exists for sub-agents; its exposure to `exec`/`turn/start` is unknown.
- U5. Whether `claude-fable-5-1` and the other target models work through DeepCode's Anthropic provider, and whether native subagents can use a model other than their parent's (the code suggests they inherit it).
- U6. The real behaviour of an unattended `ask`-mode turn that needs writes, and whether pre-approved rules can express "allow edits inside this worktree, deny network".
- U7. Token and cost reporting per turn, for budgets and metrics.
- U8. Behaviour when the DeepCode service restarts mid-turn (what state does the turn end in, and can the activity re-attach).

## 4. The activity contract

### 4.1 Transport

Target: the JSON-RPC surface (idempotent `messageId`, `turn/interrupt`, `turn/read`, event replay). Spike: shell out to `deepcode exec --json --detach`/`loop`, then poll, because it is available today. The worker hides the transport behind one interface so the switch does not touch FlowKit.

```ts
interface ExecutionPlane {
  start(req: { key: string; role: Role; workspace: string; access: Access;
               prompt: string; connection: string; model: string;
               checks?: string[]; tokenBudget?: number }): Promise<{ threadId: string; turnId: string }>;
  watch(ref: Ref, onEvent: (e: AgentEvent) => void): Promise<TurnResult>; // heartbeats from events
  interrupt(ref: Ref): Promise<void>;                                     // confirmed, not fire-and-forget
  read(ref: Ref): Promise<TurnResult>;
}
```

### 4.2 Idempotency (a requirement, because `exec` has none)

The worker keeps a small store of `idempotencyKey -> { threadId, turnId }`, where the key is FlowKit's `[workflowId, entryEpoch, stepIndex, phase, taskId]`. On any activity attempt: look the key up first. If found, **re-attach** (`read`/`watch`) instead of starting. Only start when absent, and write the mapping *before* the first model call returns work. Result: an activity retried after a worker crash never creates a duplicate session. Execution activities use a small `maximumAttempts` (2 to 3) with a non-retryable error type for "turn finished and failed".

### 4.3 Cancellation

A Temporal activity cancel (stage change, SLA escalation, human takeover) must stop the agent. The activity heartbeats on every event and, on cancellation, calls `interrupt` and waits for confirmation, then reports the task `cancelled`. If confirmation cannot be obtained, the worker marks the thread for cleanup and records an alert. It never assumes a killed client stopped the turn (verified fact 4).

### 4.4 The three orchestration activities

| FlowKit activity | DeepCode call | Access | Output |
|---|---|---|---|
| `planOrchestration` | One turn, planner role, read-only | `read-only` | Validated JSON `{ tasks: [{ id, agent, input }] }`. Invalid or unparsable JSON gets one corrective retry, then the activity fails (so the step degrades to a human). |
| `runSubagent` | A Goal (`loop`) for `coder`/`tester`; a turn for read-only roles. Runs in the task's worktree. | per role, §6 | `{ output: summary, outputRef: <patch or report path> }`. Large artifacts stay on disk; workflow state keeps only the reference. |
| `synthesizeOrchestration` | One read-only turn, or a deterministic function when no judgement is needed | `read-only` | Merged output within `maxOutputBytes`. |

Subagents that *change code* use `loop` with confirmed `--check` commands, so DeepCode itself refuses to call a task complete until the checks pass. A restart pauses the Goal, and the retried activity resumes it with `--resume`. This combines Temporal's durability with DeepCode's verified completion.

## 5. Workspaces and merging

- One `git worktree` per subagent task, created by the worker off a recorded base commit, named from `{workflowId}/{epoch}/{taskId}` (no short random suffixes).
- Each task is trusted before use (U3). Trusting is a deliberate worker step, never an `--trust` on user-supplied paths.
- On a successful task the worker commits in the worktree and merges to a per-workflow integration branch with a 3-way merge; **a conflict marks the task `failed` with reason `conflict`**, aborts the merge so nothing is left half-merged, and the plan/`decide` rule sees it. Nothing merges into the default branch without passing the `review` stage.
- Cleanup (remove worktree, delete thread) runs from a separate cleanup path that survives cancellation.

## 6. Autonomy and security policy

Inputs from email and Slack are **untrusted text**. An agent that can edit files and run commands and that reads them can be steered by them. The design is defence in depth, not trust in the model:

| Stage / role | Access | May auto-release? | Notes |
|---|---|---|---|
| `plan` (planner) | read-only | Yes, via rule on schema validity and task count | Receives intake text as quoted data. |
| `critique` (adversary) | read-only | Yes, only if the rule finds no blocking findings | The critique is a different role and ideally a different model from the planner. |
| `execute` (coder, tester) | write inside its worktree only | Yes for low-risk classes; **human gate for any run whose source is an untrusted channel** until proven | Network off. No credentials in the environment. |
| `security` (pen-test) | read-only plus a throwaway environment | **No**, always human | |
| `review` | human | n/a | |

Open decision D3 is how unattended writes are permitted (U6): a pre-approved rule set, or `full-access` inside a disposable container or VM per task. I recommend the latter if U6 shows the rule set cannot express worktree-scoped writes.

Further controls: token budgets on every Goal; Temporal timeouts and the stage SLA bound the wall clock; a per-workflow cost ceiling checked by a guard; an allowlist of intake channels and authors; no outbound network from execute/security tasks except through an allowlisted gateway.

## 7. Model routing

A worker configuration table maps **role to connection and model**, outside the definition, so a model change is a deploy of configuration, not a new flow version:

```yaml
roles:
  planner:   { connection: anthropic, model: <opus>,   effort: high }
  adversary: { connection: anthropic, model: <opus>,   effort: high }   # independent of planner
  coder:     { connection: anthropic, model: <opus>,   effort: medium }
  tester:    { connection: anthropic, model: <sonnet>, effort: low }
  copy:      { connection: anthropic, model: <sonnet>, effort: low }
  security:  { connection: anthropic, model: <fable>,  effort: high }   # U5: unverified
```

Model ids are placeholders until U5 is confirmed. Dynamic selection (for example escalating the model after a failed Goal) is a worker rule using the task's retry count, not something FlowKit knows about.

## 8. The first flow

The plan, critique, execute, security, review pipeline from Spec B §12, with: `plan` and `critique` as `orchestrate` steps with auto gates, an iteration bound (a `revise` loop limited to N passes, enforced by a guard on a counter in subject metadata), `execute` as `orchestrate` with `allTasksClean`, `security` human-gated, and `review` human. Every stage has an SLA.

## 9. Intake contract (adapters out of scope)

An adapter normalizes an event to `{ source, externalId, author, receivedAt, body, attachments }`, derives `workflowId = intake:<source>:<externalId>`, and starts the flow (Temporal's workflow-id reuse policy dedupes repeats) or signals a running one. Slack (rooms, crash reports) and email can be connected through MCP servers or small webhooks. Granola's API availability is unchecked. Raw bodies are stored by reference; the workflow carries identifiers and a bounded summary.

## 10. Spike plan (time-boxed)

| Phase | Work | Exit criteria |
|---|---|---|
| S0 | Install Temporal dev server and DeepCode; link FlowKit locally; run `exec --json` on a toy repo; answer U1 to U8 | Written answers for U1 to U8 and a go/no-go on the transport |
| S1 | One `runSubagent`: worktree, trusted, `loop` with checks, idempotent re-attach, cancel via interrupt | Kill the worker mid-turn and restart: **zero duplicate sessions**; cancel stops the agent within a bounded time |
| S2 | `orchestrate` with plan (validated JSON), 2 to 3 subagents, synthesize, auto gate; failure injection (bad plan, failed task, conflict) | Every injected failure ends in a human gate, never a silent release |
| S3 | Full pipeline with critique and security stages, human approval, SLA escalation | A run completes end to end; an SLA timeout escalates and cancels cleanly |
| S4 | One real intake channel into the flow; dedupe; a prompt-injection test set | Duplicates collapse; injected instructions do not alter files outside the plan |

**Metrics recorded from S1:** success rate, human interventions per workflow, cost and tokens per workflow, wall-clock per stage, duplicates (must be 0), resume correctness after restarts of the worker, the DeepCode service, and Temporal.

**Stop conditions:** if U1 and U3 both fail, or S1 cannot reach zero duplicates, stop and reconsider before building more.

## 11. Retiring Helmsman

Retired: `dsh/` plugins, the SQLite schema, the board projection. Lost unless rebuilt: the knowledge base and context assembly, and the kanban/approvals UI. For the spike, use the Temporal UI for workflow state and DeepCode's Web client for session detail. A purpose-built status page, and whether to keep Helmsman's web front end on top of FlowKit state, is decision D5 and is deferred. Port 3081 is used by both the old Helmsman engine and the DeepCode service; the engine is not run alongside.

## 12. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve Option B and this spike as the next step | Yes, S0 first with go/no-go |
| D2 | Worker language | TypeScript (FlowKit's native language) |
| D3 | How unattended writes are permitted | Disposable container per task unless U6 shows scoped rules suffice |
| D4 | Should untrusted-channel runs always require a human before `execute` | Yes initially |
| D5 | UI: Temporal UI plus DeepCode Web now, custom later | Yes |
| D6 | Where this spec and the worker live | **Decided:** `teopeurt/deepkode`, branch `claude/deepcode-flowkit-execution-plane`. FlowKit stays generic. |

## 13. Risks

- Prompt injection via intake text is the largest risk and is mitigated by layers, not eliminated.
- Two fast-moving dependencies (DeepCode releases every few days; FlowKit 1.1.0 unpublished) that must be pinned.
- Cost: planner plus adversary plus subagents multiplies model calls per workflow; budgets and metrics from S1 are required before any production use.
- DeepCode is a large product; only its headless and RPC surface is used, so most of it is unused weight.
