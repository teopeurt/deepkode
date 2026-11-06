# Spec C: DeepCode as the execution plane for FlowKit (Option B)

**Status:** v0.6. v0.5 recorded the WP-E decisions; v0.6 records the WP-C (intake) and WP-D (triage) decisions and changes only §9, §9a, §9b, and §18. Implemented so far: S0 probes and the `worker/` skeleton, activities, plan validation, workspaces, memory, intake and triage, all tested against fakes and synthetic data only (no real DeepCode, model, mailbox or embedding run).
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

**Non-goals for this spec:** a custom UI, the input connectors themselves (contract only, §9), multi-tenant operation, and any change to FlowKit beyond Specs A and B. The knowledge base is **in scope** from v0.2, as the Memory service (§9b).

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
                              JSON-RPC over stdio (`deepcode-app-server`)
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

## 2a. Domain model: Input, Triage, Project, Task, Memory

The product keeps Helmsman's central idea (projects, tasks, memory) and runs it on the architecture above.

```
Input ──▶ Triage ──▶ Project ──▶ Task ──▶ Memory
 raw       shared     long-lived  FlowKit   captured on approval,
 events    FlowKit    context     workflow  read at triage and plan
           flow
```

| Concept | Definition | Realised as |
|---|---|---|
| **Input** | A raw event from a channel: Slack message, email, call note, crash report. | A normalized record (§9), stored by reference, deduplicated by a stable id. |
| **Triage** | Turns an input into a decision: discard, answer, merge into an existing task, ask a human, or create a task in a project. | **One shared FlowKit flow** for every input type (§9a). Source-specific differences are data and pre-processing, not separate flows. |
| **Project** | The long-lived unit of context and policy. **It may span several repositories.** | A registry record, not a workflow: repos, per-repo check commands, conventions, autonomy and budget policy, allowed channels, model overrides, SLAs, memory namespace. |
| **Task** | One unit of work in one project. | One FlowKit workflow (the plan, critique, execute, security, review flow of §8). `subject.id` is the task id and `subject.organizationId` is the project id. |
| **Memory** | What the project has learned, kept across tasks. | A Memory service with Helmsman's trust model (§9b). |

### Projects that span several repositories

A project lists its repositories, each with a remote, a default branch, and its own check commands. Rules that follow:

- **Tasks are planned per repository.** Each orchestration task carries a `repo` field in its `input`, and worktrees, integration branches and checks are per repository. DeepCode's thread takes a single `workspacePath`, so one subagent works in one repository unless U9 shows multi-root workspaces are supported.
- **Cross-repository coordination happens at plan and synthesis level.** The planner emits tasks across repos with declared ordering; the synthesizer reports per-repo results; the `review` stage sees all of them together.
- **There is no atomic cross-repo merge.** Nothing merges until every repository's integration branch has passed its checks and the `review` stage has approved. Merges then go in the planned order as pull requests. If a later merge fails after an earlier one landed, the flow stops at a human gate with the partial state described. It does not try to roll back. This is the hardest unsolved part of multi-repo support and is listed as risk R5.
- **A task's repository set is decided at triage** and recorded in task metadata. Widening it later goes back through a human gate.

## 3. What is verified, and what is not

**Established by reading the DeepCode source and docs before S0.** S0 later ran DeepCode and confirmed the cases it exercised: the event shapes (item 1), exit codes 0 and 130 and the `--detach` output (item 2), SIGINT stopping a turn while a killed client does not (item 4), denial of unanswered approvals under `ask` (item 5), and the trust requirement (item 9). Not exercised: the exit-1 path for a failed turn, a retried `exec` creating a duplicate session (item 3; each `exec` call did start a new session), and items 6 to 8.

1. `deepcode exec --json` emits one JSON event per line with `msg.type`, including `turn_started`, `tool_started`, `tool_completed`, `agent_message`, `error`, and `task_complete` (with `stop_reason`).
2. `exec` exits 0 only if the turn completed, 1 otherwise, and 130 on interrupt. `--detach` returns `{threadId, turnId, status, detached}` and exits 0.
3. **`exec` has no idempotency key.** Retrying it starts a second session and turn.
4. SIGINT makes `exec` call `turn/interrupt`. Cancelling only the client waiter does not stop an already-admitted turn, so killing the process leaves the turn running in the service.
5. In non-interactive Ask mode an approval that cannot be answered is denied. `--access` takes `read-only`, `ask`, or `full-access`; `--access full-access` removes approvals and the sandbox.
6. The JSON-RPC protocol has `thread/start` (`projectId`, `workspacePath`, `agentPreset`, `parentThreadId`, `connectionId`, `model`, `reasoningEffort`), `turn/start` (requires a caller-supplied **`messageId`**), `turn/interrupt`, `turn/read`, an event-replay method, and approval-respond. The service listens on `127.0.0.1` and clients authenticate with a token file.
7. Goals can carry confirmed check commands (`--check`, `--test-cmd`), a token or time budget, and an optional independent read-only reviewer. A Goal active at restart is **paused**, not continued, and `deepcode loop --resume SESSION_ID` continues it.
8. Native subagents are model-driven, at most 5 concurrent, depth 1, isolated in worktrees by default, merged back with git's 3-way merge reporting conflicts. External `codex` and `claude-code` CLIs are available as subagent backends.
9. A new workspace needs project trust (`--trust`, once per project).

**Answered in S0 by running DeepCode 2.3.1 against a scripted mock model** (full detail in `001a-s0-findings.md`; the mock tests transport and lifecycle, not model quality):

| # | Question | S0 result |
|---|---|---|
| U1 | Is `messageId` a real idempotency key? | **Yes** (within one thread). A repeated id returns the same turn with one model call; the same id with different content is rejected. Whether the id is also unique across threads was not tested. |
| U2 | How does an outside process connect? | **Stdio `deepcode-app-server`**: documented JSON-RPC 2.0, relays to the running service and shares its state. The service's HTTP `/control/rpc` also works but is internal and needs the token and identity proof. |
| U3 | Is trust per path? | **Yes.** A new worktree is a separate, untrusted project; the worker trusts it with `project/add {trustState: "trusted"}`. Each worktree adds a project record; cleanup is open. |
| U4 | Structured output from a top-level turn? | **No.** The capture tool is not exposed to `turn/start`. The worker validates JSON itself (§4.4). |
| U5 | Anthropic and Fable models; per-subagent model? | **Still open: needs an API key.** Native subagents inherit the parent's model, so per-role models mean one thread per role. |
| U6 | Unattended writes? | **Yes, for files, without a container.** Under `ask`, `security.permissions` with `write` and `edit` set to `allow` permitted writes inside the workspace and the workspace fence refused writes outside it. Tested with tool-level rules; path-pattern rules and bash `allow` patterns were not tested. |
| U7 | Usage reporting? | **Yes.** `model_usage_recorded` events carry token counts. A new thread also makes one extra non-streamed model call. |
| U8 | Restart mid-turn? | A killed **client** leaves the turn running; `turn/interrupt` stops it. A killed **service** leaves the turn `interrupted` with its history, not resumed. |
| U9 | Multi-root workspaces? | **No**: one `workspacePath` per thread. |
| U10 | Embedding model for English and mixed content | **Deferred to S6.** Helmsman's `bge-small-zh-v1.5` is Chinese-only and is not carried over. |

**Behaviours the worker must handle (found in S0):**

1. **Exit code and turn status do not prove the work happened.** A turn whose only tool call was denied still ends `completed` with exit 0.
2. **Events carry no thread or turn id**; obtain ids from the RPC interface.
3. **A dead client does not stop its turn.**
4. **An interrupted turn is not a failed turn**; see §4.3.
5. **The service starts itself on port 3081**, the port Helmsman's engine uses, so they cannot run together.

## 4. The activity contract

### 4.1 Transport

**Stdio `deepcode-app-server`** (U2): the worker starts one long-lived child process and speaks JSON-RPC 2.0, one JSON object per line. It supplies idempotent `turn/start` (`messageId`), `turn/interrupt`, `turn/read`, event replay, and approval-respond, and shares state with the DeepCode service. The worker hides this behind one interface so the transport can change without touching FlowKit. The `deepcode exec` command is not used by the worker; it remains useful for manual checks.

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

### 4.2 Idempotency

`turn/start` is idempotent by `messageId` (U1). The worker sets **`messageId` to FlowKit's idempotency key** `[workflowId, entryEpoch, stepIndex, phase, taskId]` plus an attempt suffix only when a corrective or continuation message is deliberately sent (§4.3, §4.4). Because that guarantee holds per thread, the thread must be the same on every attempt:

- The worker sets the **thread title to the idempotency key** and keeps a small cache `key -> { threadId, turnId }`.
- On an attempt: consult the cache; on a miss, list threads and match on title; only if neither finds one, `thread/start`. A crash between `thread/start` and the cache write is then repaired by the title lookup instead of creating a second thread. The cache is an optimisation; the title lookup is the source of truth.
- A retried `turn/start` returns the existing turn; the activity then `watch`es or `read`s it instead of starting work again.

Execution activities use a small `maximumAttempts` (2 to 3) with a non-retryable error type for "turn finished and failed". S1 must confirm that thread listing by title is reliable at the expected scale and that `messageId` scoping does not collide across threads.

### 4.3 Cancellation and recovery

A Temporal activity cancel (stage change, SLA escalation, human takeover) must stop the agent. The activity heartbeats on every event and, on cancellation, calls **`turn/interrupt` and waits until the turn reads `interrupted`**, then reports the task `cancelled`. It never relies on killing a client or process: a dead client leaves its turn running (U8). If confirmation cannot be obtained, the worker records an alert and marks the thread for the cleanup path.

**Interrupt confirmation has a deadline.** `ExecutionPlane.interrupt` rejects with `InterruptUnconfirmed` after a configurable timeout (default 30 s). The activity then records an alert and marks the thread for the cleanup path, and still reports `cancelled`; it never reports success.

**Temporal settings.** FlowKit's orchestrator registration must set, for the three activities: `maximumAttempts` 2 to 3; `nonRetryableErrorTypes` including `SubagentTurnFailed` and `PlanInvalid`; a `heartbeatTimeout`; and `cancellationType: WAIT_CANCELLATION_COMPLETED`. The activity sends a keepalive heartbeat (default every 3 s) in addition to per-event heartbeats, because Temporal delivers a cancel only on a heartbeat. A cancelled activity throws `CancelledFailure` after the interrupt is confirmed; FlowKit's `orchestrate` step must map it to task status `cancelled` (verified in S2, not assumed). A retried attempt re-attaches through the idempotent start and sends a continuation message only if `read` reports the previous turn `interrupted`; S1 must confirm that `turn/read` on a crashed turn does report `interrupted`.

An **`interrupted` turn is not a failure.** If the service crashed, a turn comes back `interrupted` with its history intact. A retried activity starts a new turn (new attempt suffix on the `messageId`) in the same thread and worktree, with a short continuation prompt, rather than restarting from scratch.

### 4.4 The three orchestration activities

| FlowKit activity | DeepCode call | Access | Output |
|---|---|---|---|
| `planOrchestration` | One turn, planner role, read-only | `read-only` | JSON `{ tasks: [{ id, agent, input }] }` **validated by the worker** (U4: there is no schema-constrained output for top-level turns). Invalid or unparsable JSON gets one corrective message in the same thread (new attempt suffix), then the activity fails, so the step degrades to a human. |
| `runSubagent` | A Goal for `coder`/`tester` (RPC `goal/*`; the CLI `deepcode loop` is the equivalent); a turn for read-only roles. Runs in the task's worktree. | per role, §6 | `{ output: summary, outputRef: <patch or report path> }`. Large artifacts stay on disk; workflow state keeps only the reference. **Success is judged from evidence** (below). |
| `synthesizeOrchestration` | One read-only turn, or a deterministic function when no judgement is needed | `read-only` | Merged output within `maxOutputBytes`. |

Subagents that *change code* use a Goal with confirmed check commands, so DeepCode itself refuses to call a task complete until the checks pass. A restart pauses the Goal, and the retried activity resumes it. This combines Temporal's durability with DeepCode's verified completion. (Goals, their RPC methods and their restart behaviour were not exercised in S0; this is the first item of S1.)

**Plan schema and critique rules (v0.4).** A plan is `{ tasks: [{ id, agent, input, dependsOn? }] }`:
- `id` is unique; `agent` is one of `coder`, `tester`, `reviewer`, `security`, `copy` (`planner` and `adversary` are stage roles, never plan agents); `input` is an object that must contain `repo` (checked against the project's allowed repos by the critique pre-check, not by the plan validator); `dependsOn` is an optional list of task ids that must exist and be acyclic.
- Limits: at most 20 tasks and 64 KB total, configurable per project.
- Plan JSON is extracted from fenced or prose-wrapped replies; one failure gets one corrective message (attempt suffix `corrective1`), a second failure degrades to a human.
- Critique pre-checks run before any model critique and are deterministic: task count, repo scope, `..`, NUL bytes and absolute or `~` paths in path-like fields, and untrusted origin (always a human gate, D4). A mention of `../` in free text also gates to a human; false positives are accepted.
- The critique runs read-only, on a thread separate from the planner's, on a model different from the planner's unless the project sets `allowSameModel`. Only a well-formed critique with no blocking finding may auto-release; a malformed critique result is a human gate.

**Success criteria.** The turn status and exit code are not evidence (§3, behaviour 1): a turn whose writes were all denied still ends `completed`. A subagent task succeeds only if the evidence says so: the expected diff exists in the worktree and stays inside the task's scope, the confirmed checks passed, and, for a Goal, DeepCode recorded the Goal complete. Anything else is a failed task, whatever the turn status.

## 5. Workspaces and merging

- One `git worktree` per subagent task, created by the worker off a recorded base commit, named from `{workflowId}/{epoch}/{repo}/{taskId}` (no short random suffixes; `repo` because a project may span several).
- Task, workflow and repo ids used in paths must be **generated** (not free text): path segments are sanitised, and two free-text ids can collide after sanitising. Worktrees are on branch `dk/{workflowId}/{epoch}/{repo}/{taskId}`; the recorded base commit is stored with the branch.
- The worker commits with `--no-verify` under the identity `deepkode-worker <worker@deepkode.invalid>`.
- Each task is trusted before use (U3). Trusting is a deliberate worker step, never an `--trust` on user-supplied paths.
- On a successful task the worker commits in the worktree and merges to a per-workflow integration branch with a 3-way merge; **a conflict marks the task `failed` with reason `conflict`**, aborts the merge so nothing is left half-merged, and the plan/`decide` rule sees it. In a multi-repo project each repo is judged on its own as `ready`, `failed` or `conflict`; all ready is `ready`, none ready is `failed`, and any mix is a **human gate** listing per-repo state (D8). Conflicts are detected by a dry run (`git merge-tree --write-tree`, git 2.38 or later) against the repo's *current* base, so a moved base shows up as a conflict. Nothing merges into the default branch without passing the `review` stage.
- Cleanup (remove worktree, delete thread) runs from a separate cleanup path that survives cancellation.

## 6. Autonomy and security policy

Inputs from email and Slack are **untrusted text**. An agent that can edit files and run commands and that reads them can be steered by them. The design is defence in depth, not trust in the model:

| Stage / role | Access | May auto-release? | Notes |
|---|---|---|---|
| `plan` (planner) | read-only | Yes, via rule on schema validity and task count | Receives intake text as quoted data. |
| `critique` (adversary) | read-only | Yes, only if the rule finds no blocking findings | The critique is a different role and ideally a different model from the planner. |
| `execute` (coder, tester) | `ask` plus `allow` for `write`/`edit`, inside its worktree only | Yes for low-risk classes; **human gate for any run whose source is an untrusted channel** until proven | Network off. No credentials in the environment. |
| `security` (pen-test) | read-only plus a throwaway environment | **No**, always human | |
| `review` | human | n/a | |

**Unattended writes (D3, resolved for files).** Run each task in its own trusted worktree under `ask`, with `security.permissions` setting `write` and `edit` to `allow`. S0 showed this permits edits inside the workspace while the workspace fence refuses paths outside it, so a container is not required for file edits. Shell commands (the confirmed checks) are still governed by the `ask` sandbox; whether they can run unattended through `allow` patterns, and whether the OS sandbox is available on the target host, is decided in S1. If either fails, fall back to a disposable container per task. Never use `full-access` for a task fed by an untrusted channel.

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

The worker's `Role` type must include every role in this table (added to `worker/src/types.ts` after v0.4). Model ids are placeholders until U5 is confirmed. Dynamic selection (for example escalating the model after a failed Goal) is a worker rule using the task's retry count, not something FlowKit knows about.

## 8. The first flow

The plan, critique, execute, security, review pipeline from Spec B §12, with: `plan` and `critique` as `orchestrate` steps with auto gates, an iteration bound (a `revise` loop limited to N passes, enforced by a guard on a counter in subject metadata), `execute` as `orchestrate` with `allTasksClean`, `security` human-gated, and `review` human. Every stage has an SLA.

## 9. Intake contract (adapters out of scope)

An adapter normalizes an event to an `Input` record `{ id, channel, source, externalId, author, receivedAt, body, attachments (metadata only, never opened), origin, originReason, requiresHuman, rawHash, contentHash, threadId, signals, occurrences[] }`, derives `workflowId = intake:<source>:<externalId>`, and starts the flow (Temporal's workflow-id reuse policy dedupes repeats) or signals a running one. Slack (rooms, crash reports) and email can be connected through MCP servers or small webhooks. Granola's API availability is unchecked. Raw bodies are stored by reference; the workflow carries identifiers and a bounded summary.

**Email rules (v0.6).** (1) `externalId` is attacker-controlled for email (a forged or re-sent Message-ID), so the email adapter derives `externalId` from the `contentHash` of the normalised subject and body; the Message-ID is kept as metadata, and `contentHash` is also recorded as a search attribute. Intake dedupe on the content hash is a second layer behind the workflow id. (2) Email is untrusted unless the sender is on an explicit allowlist **and** the topmost `Authentication-Results` header comes from a configured server with an aligned DMARC pass; anything else, including multiple From headers, is untrusted. A trusted sender whose text carries an injection signal still requires a human. (3) **The real mail ingress must strip any inbound `Authentication-Results` header before stamping its own** (RFC 8601); without that, a spoofed header could be believed, so this is a deployment requirement. (4) Dedupe is per project, channel and trust class, and never raises an Input's trust; an untrusted copy and a trusted copy of the same text are two Inputs.

## 9a. Triage: one shared flow

All inputs, whatever their source, enter the same FlowKit flow. The source and a trust label (`untrusted` for email, public Slack and customer reports; `internal` for notes and trusted rooms, and for email that passed the allowlist and authentication check above) travel as task metadata and drive policy, not the flow's shape.

Shape (illustrative, not final YAML):

```yaml
id: triage
stages:
  received:   # normalize, attach provenance, store the body by reference
  classify:   # ai step, read-only, cheaper model: kind (bug | feature | question | feedback | crash | security | noise),
              # confidence. gate: auto, decide: classificationConfident
  dedupe:     # a **visible** stage (v0.6): system step searching open tasks and Memory for the same issue. rule decides: new | merge | known-answer
  route:      # ai step: project, repositories, priority, risk class, autonomy level. gate: auto, decide: routingConfident
  needs_human:  # human gate: confirm / edit routing / discard. Reached whenever a rule declines
  create_task:  # system step: start the Task workflow; rule then moves to the final stage
  merged: { final: true }      # attached to an existing task by signal
  discarded: { final: true }
  answered: { final: true }    # known answer from Memory, no task
  done: { final: true }        # task created
```

Properties:

- **The only output is structured data.** Raw input text is never an instruction to a writing agent: it is quoted as data in the plan prompt and is not given to `execute` roles directly.
- **Fails closed.** Low confidence, a declined rule, or an error lands in `needs_human` (Spec A's behaviour). Specifically: classifier error or malformed output, low confidence (threshold 0.6), no project or an unregistered project, an ambiguous second project (margin 0.2), an empty or foreign repo set, a memory retrieval error, an unverified memory match, empty input, injection-pattern text (the classifier is skipped), and untrusted-origin items labelled `security`.
- **Classification contract.** The classifier returns `label`, `project`, `repos`, `confidence`, `rationale` and `alternatives[]`. In `alternatives`, each `confidence` is *that alternative project's own* confidence; the ambiguity rule compares it with the top choice and depends on this definition.
- **Trusted security items** route normally; only untrusted-origin `security` items go to a human. (D4 still requires a human before `execute` for anything untrusted.)
- **Merging never lowers a gate.** When `dedupe` attaches an Input to an existing task, an untrusted occurrence keeps the human gate before `execute`; the untrusted copy is never dropped in favour of a trusted one.
- **Flow wiring.** The decision runs as a rule on `classify` plus the `needs_human` gate; v0.6 makes `dedupe` a separate visible stage, so the rule's action set gains a `dedupe` stage. `route` stays inside the `classify` decision for now, because project and repos come from the classifier. Registry handlers (`triage_decision`, `classify_input`, `normalize_input`) are to be implemented.
- **Untrusted sources require a human gate before `execute`** (D4), set by the `create_task` step in the task's metadata and enforced by a guard in the task flow.
- **Duplicates collapse twice**: by workflow id at intake (§9) and semantically at `dedupe`.
- **Per-source preprocessing** (for example parsing a crash report or summarizing a call note) runs in the intake adapter, before the flow, and produces the same normalized record.

## 9b. Memory service

Memory is a service with a defined interface, taken from Helmsman's knowledge base design (not its code, which had unwired parts: metrics were never saved, and two features were no-ops).

**Note model:** `id`, `projectId`, optional `repoScope`, `title`, `content[]`, `tags`, `keywords`, `summary`, `antiPatterns[]`, `applicability`, `links`, `source { kind, ref }`, `validFrom`, `validUntil`, `invalidatedBy`, `invalidatedAt`, `version`, `trust`, `origin`, `approvedBy`, `pinned`, `conflictsWith[]`, `occurrences`, `provenance[]` (task id, repo), timestamps. Validity is bitemporal: valid time (`asOf`) and record time (`knownAt`).

- `trust`: `human-approved`, `agent-generated`, `unverified`.
- `source.kind` values used by triage: `open-task` (`ref` is the task id; marks a duplicate of that open task) and `known-answer` (a human-approved answer). Only **gate-eligible** notes (human-approved, trusted origin, unconflicted) may produce `duplicate` or `known_answer`; a strong match with any other note is `needs_human` with code `unverified_memory_match`. The retrieval `Hit` exposes `source` and `tags` so triage needs no second lookup.
- `origin`: `trusted` or `untrusted`, recording the channel the knowledge came from. This is new, and exists to stop poisoning.

**Interface:**

| Operation | Behaviour |
|---|---|
| `capture({ taskId, taskOrigin, review, candidates })` | Run by a system step **after the `review` stage approves**, never earlier. The caller derives `taskOrigin` from the task record; **anything other than the exact value `trusted` is treated as untrusted** (fail closed). `candidates` are already-distilled notes (distillation is a separate step). Capture ignores any `trust`, `origin`, `pinned`, `approvedBy` or validity field a candidate supplies. Trusted tasks yield `agent-generated` notes with `origin: trusted`; untrusted tasks yield `unverified` notes with `origin: untrusted`. |
| `retrieve(projectId, query, { repoScope, limit })` | Hybrid retrieval: keyword rules plus semantic similarity, filtered by validity window. |
| `assemble(projectId, taskText)` | Returns the stable prefix, the relevant hits, and a snapshot id. The snapshot id is recorded on the task for audit. |
| `approve`, `invalidate`, `pin`, `unpin`, `list` | Maintenance. These require a human actor `{ kind: "human", id }`. **Approving a note whose origin is untrusted needs an explicit `acceptUntrustedOrigin`**: the act sets `origin` to `trusted`, records `approvedBy`, and re-screens the text. Pinning needs a `human-approved`, `origin: trusted` note. |

**Rules:**

1. **Poisoning guard.** Notes with `origin: untrusted` or `trust` below `human-approved` never enter the stable prefix and never feed an auto-gate decision until a human approves them.
2. **Readers:** triage (`dedupe`, known answers), plan, critique, and the assembled prompt for execute. The first version injects memory by prompt assembly only. An on-demand memory tool for agents is deferred because it opens a second read path for injected content.
3. **Writers:** only the `capture` step and human maintenance.
4. **Validity is bitemporal:** an outdated note is invalidated, not deleted, so past tasks remain explainable from their snapshot.
5. **Stable prefix and gate eligibility.** The stable prefix holds only notes that are pinned, `human-approved`, `origin: trusted`, unconflicted and injection-free; pinning is the separate opt-in to the prefix. A note is **gate-eligible** (may feed an auto-gate decision) under the same rule without the pinning requirement. Every other hit is returned as a data block wrapped in `<untrusted-data>` with angle brackets neutralised, and never reaches the stable prefix or a gate decision.
6. **Capture hygiene.** Specificity bar (a concrete anchor and a score of at least 3; generic phrasing is penalised), size limits, and text screening (NFKC normalisation, zero-width and bidi stripping, confusable folding, instruction-pattern detection) run before insert. Dedupe and merge run before insert, never across origin classes and never edit a `human-approved` note; contradictions are flagged as conflicts instead of merged. At most 100 untrusted notes per project and 5 per near-identical title.
7. **Screening limits.** The text screen is regex-based and English-only. It is defence in depth, not the guarantee; the structural rules (origin, trust, human-only promotion) are the protection. Conflict detection is heuristic and misses contradictions phrased differently. Words mixing Latin, Cyrillic and Greek letters are rejected at capture; this rejects some legitimate multilingual notes, so it is revisited with U10's mixed-content results.
8. **Snapshots.** Each `assemble` or `retrieve` produces an immutable snapshot id (a hash over project, query, stage, repo scope, embedder id, prefix, note versions and hits). Re-reading a snapshot returns the same hits after notes change. The task records the snapshot id (done by the integrator).
9. **Tuning.** Dedupe thresholds (Jaccard 0.8, cosine 0.95), the 50/50 keyword and semantic weights and the 0.15 minimum score are starting values, calibrated with the U10 harness (`worker/src/memory/eval-cli.ts`) once a real embedder is chosen.
10. **Storage:** SQLite to start, behind the interface, so it can move to Postgres. The first implementation runs in the worker process behind the service interface and can be split out later (D7).

## 10. Spike plan (time-boxed)

| Phase | Work | Exit criteria |
|---|---|---|
| S0 | Install Temporal dev server and DeepCode; link FlowKit locally; run DeepCode on a toy repo; answer U1 to U8 | **Complete** (2026-11-06): see `001a-s0-findings.md`. Verdict: go. Transport chosen; U5 still needs an API key. |
| S1 | One `runSubagent`, run with a **real model and API key**: worktree trusted via `project/add`; a Goal with confirmed checks (RPC `goal/*`) and its pause and resume after a service restart; title-guarded thread and `messageId` re-attach (§4.2); cancel via `turn/interrupt`. Also settle the S0 leftovers: shell `allow` patterns so the checks run unattended; OS sandbox availability on the target host; Anthropic, and Fable if offered, connectivity and a per-role model (U5); project-record cleanup after many worktrees; `messageId` scoping across threads; thread listing by title at scale | Kill the worker mid-turn and restart: **zero duplicate threads or turns**; cancel stops the agent within a bounded time; a turn whose writes were denied is classified **failed** (§4.4 evidence rule); a Goal with a failing check is not accepted; a Goal paused by a service restart is resumed by the retried activity; written answers for U5 and for unattended shell checks, with the container fallback chosen or ruled out; `turn/read` on a crashed turn reports `interrupted`; an unconfirmed interrupt raises the alert and cleanup path |
| S2 | `orchestrate` with plan (validated JSON), 2 to 3 subagents, synthesize, auto gate; failure injection (bad plan, failed task, conflict) | Every injected failure ends in a human gate, never a silent release; FlowKit's real `orchestrate` types are asserted against the worker's activity types, and a cancelled activity maps to task status `cancelled`; the real per-repo integrate step (3-way merge, abort on conflict) exists |
| S3 | Full pipeline with critique and security stages, human approval, SLA escalation | A run completes end to end; an SLA timeout escalates and cancels cleanly |
| S4 | One real intake channel into the flow; dedupe; a prompt-injection test set | Duplicates collapse; injected instructions do not alter files outside the plan |
| S5 | The shared triage flow (§9a) over two different input types, with a two-repository project; `needs_human` on low confidence | Both input types classify and route correctly on a labelled sample; a wrong or low-confidence case always reaches a human; a two-repo task produces per-repo worktrees and checks |
| S6 | Memory (§9b): capture after review, retrieval at triage and plan, snapshot id on the task; a memory-poisoning test set | A repeated issue is recognised from memory; untrusted-origin notes never reach the stable prefix or an auto-gate; the embedding choice (U10) is made on measured retrieval quality (the harness and a 31-case poisoning set exist; the measurement with a real embedder, a distillation step that produces candidates, file-backed SQLite reopened across processes, and the task-record wiring remain) |

**Metrics recorded from S1:** success rate, human interventions per workflow, cost and tokens per workflow, wall-clock per stage, duplicates (must be 0), resume correctness after restarts of the worker, the DeepCode service, and Temporal.

**Stop conditions:** if U1 and U3 both fail (they did not, S0), or S1 cannot reach zero duplicates, stop and reconsider before building more. If shell checks cannot run unattended under `ask` and a per-task container is not acceptable, stop and decide D3 again before S2.

## 11. Retiring Helmsman

Retired: `dsh/` plugins, the SQLite schema, the board projection. Kept as **design**, rebuilt in this project: projects, tasks and the knowledge base (§2a, §9b). Lost unless rebuilt: the kanban/approvals UI. For the spike, use the Temporal UI for workflow state and DeepCode's Web client for session detail. A purpose-built status page, and whether to keep Helmsman's web front end on top of FlowKit state, is decision D5 and is deferred. Port 3081 is used by both the old Helmsman engine and the DeepCode service; the engine is not run alongside.

## 12. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve Option B and this spike as the next step | Yes, S0 first with go/no-go |
| D2 | Worker language | TypeScript (FlowKit's native language) |
| D3 | How unattended writes are permitted | **Resolved for files:** `ask` plus `allow` rules in a trusted worktree. Shell/checks and sandbox availability are decided in S1, with a container fallback |
| D4 | Should untrusted-channel runs always require a human before `execute` | Yes initially |
| D5 | UI: Temporal UI plus DeepCode Web now, custom later | Yes |
| D7 | Memory: a service interface with an in-process first implementation (recommended), or a separate process from the start | In-process behind the interface; split later |
| D8 | Multi-repo merge policy (§2a): all-or-nothing is not possible; stop at a human gate on partial failure | **Resolved at v0.4:** all repos ready is ready; none ready is failed (no gate); any mix, including a conflict beside a success, is a human gate |
| D6 | Where this spec and the worker live | **Decided:** `teopeurt/deepkode`, branch `claude/deepcode-flowkit-execution-plane`. FlowKit stays generic. |

## 13. Risks

- Prompt injection via intake text is the largest risk and is mitigated by layers, not eliminated.
- Two fast-moving dependencies (DeepCode releases every few days; FlowKit 1.1.0 unpublished) that must be pinned.
- Cost: planner plus adversary plus subagents multiplies model calls per workflow; budgets and metrics from S1 are required before any production use.
- DeepCode is a large product; only its headless and RPC surface is used, so most of it is unused weight.
- R5. Multi-repo merges are not atomic; a partial failure needs human recovery (§2a, D8).
- R6. Memory poisoning: untrusted input could try to plant notes that later steer agents. Mitigated by `origin`, the trust rules in §9b, and the S6 test set, not eliminated.
- R7. Triage mistakes (wrong project, a missed duplicate) waste work. Confidence rules and `needs_human` bound them; S5 measures the error rate.

## 14. Decisions recorded at v0.2

| Question | Decision |
|---|---|
| Memory: service with Helmsman's trust model, or DeepCode's files only? | A service with Helmsman's trust model (§9b). |
| Does a Project span one repository or several? | Several (§2a). |
| One triage flow or one per input type? | One shared flow (§9a). |

## 15. Changes at v0.3 (S0 amendments)

| # | Amendment | Where |
|---|---|---|
| 1 | Transport is stdio `deepcode-app-server` | §2 diagram, §4.1 |
| 2 | Idempotency uses `turn/start` `messageId` set to FlowKit's key | §4.2 |
| 3 | Cancellation is `turn/interrupt` and waits for `interrupted`; an interrupted turn is retried, not failed | §4.3 |
| 4 | File edits need no container: `ask` plus `allow` for `write` and `edit` | §6, D3 |
| 5 | The plan activity validates JSON in the worker, with one corrective retry | §4.4 |
| 6 | Subagent success is judged from evidence, not turn status | §4.4 |
| 7 | U1 to U4 and U6 to U9 marked answered; U5 open; U10 deferred to S6 | §3 |

Two wordings in the findings were tightened here, because the evidence supports less than they said:

- **Amendment 2** said `messageId` replaces the worker's mapping store as the primary mechanism. S0 proved `messageId` deduplicates turns **within one thread**, but `thread/start` is not idempotent: a retry after a crash could create a second thread, and the same `messageId` in a different thread would not be deduplicated. §4.2 therefore keeps a thread-level guard (title equals the key, looked up on a cache miss) and makes the store a cache of that.
- **Amendment 4** said "path-scoped" allow rules. S0 tested tool-level `allow` for `write` and `edit` plus the workspace fence, not path-pattern rules. §3 and §6 say exactly that.

S1 scope (approved afterwards): the findings' proposed additions are merged into the S1 row of §10 with matching exit criteria and one added stop condition: Goals with confirmed checks and their restart behaviour, shell `allow` patterns, the sandbox on the target host, Anthropic and Fable connectivity (U5), project-record cleanup, `messageId` scoping across threads, and thread listing by title at scale. The S1 exit criteria still include zero duplicates and bounded cancellation, plus the evidence rule and Goal-resume checks.

## 16. Changes at v0.4 (decisions from WP-B, WP-F, WP-G)

These record the resolutions applied on your instruction to apply the amendments. Each follows the behaviour the work package implemented and tested; change any you disagree with before S2.

| From | Question | Resolution | Where |
|---|---|---|---|
| WP-F | Valid agent names | `coder, tester, reviewer, security, copy`; `planner`, `adversary` are stage roles | §4.4 |
| WP-F | `adversary`, `copy` missing from `Role` | Role type must match §7; code follow-up | §7 |
| WP-F | `input.repo` | Required, checked in critique pre-check | §4.4 |
| WP-F | `dependsOn` | Optional, acyclic, ids must exist | §4.4 |
| WP-F | Limits | 20 tasks, 64 KB, configurable | §4.4 |
| WP-F | Stricter gating | Malformed critique and untrusted origin always gate | §4.4 |
| WP-B | `turn/read` on crashed turn | Must report `interrupted`; confirmed in S1 | §4.3, §10 |
| WP-B | Registration options | Non-retryable types, heartbeat timeout, wait-for-cancellation | §4.3 |
| WP-B | Cancelled activity to task status | `orchestrate` maps it; checked in S2 | §4.3, §10 |
| WP-B | Interrupt with no confirmation | Deadline, alert, cleanup path | §4.3 |
| WP-G | Conflict representation | Failed with reason `conflict`, per-repo state, gate on a mix | §5 |
| WP-G | Id collisions | Ids generated, not free text | §5 |
| WP-G | All repos fail | `failed`, not a gate | §5, D8 |
| WP-G | Conflict base | Current base ref | §5 |
| WP-G | Commit identity | `--no-verify`, `deepkode-worker` identity | §5 |

Not resolved here: the S1 results themselves, and the unwired items in the work packages (real `DeepCodePlane`, FlowKit type compatibility, the integrate step).

## 17. Changes at v0.5 (decisions from WP-E)

Applied on your instruction, following the behaviour WP-E implemented and tested. Change any you disagree with before S6.

| # | Question | Resolution | Where |
|---|---|---|---|
| 1 | Does human approval clear an untrusted origin? | Only with explicit `acceptUntrustedOrigin`; sets origin trusted, records `approvedBy`, re-screens | §9b ops |
| 2 | Note fields beyond the original model | `approvedBy`, `conflictsWith`, `occurrences`, `provenance[]`, `pinned`, `invalidatedAt` added | §9b model |
| 3 | `capture(taskId)` signature | Takes `taskOrigin`, review verdict, candidates; only exact `trusted` is trusted | §9b ops |
| 4 | Pin vs approve | Pin is the separate opt-in to the stable prefix; gate eligibility needs no pin | §9b rule 5 |
| 5 | Injection screening limits | Defence in depth only; structure is the protection | §9b rule 7 |
| 6 | Mixed-script words | Rejected at capture; revisited with U10 | §9b rule 7 |
| 7 | Untuned thresholds | Starting values, calibrated with the U10 harness | §9b rule 9 |

Still open: U10 (measured with a real embedder), distillation of finished tasks into candidates, file-backed persistence tests, concurrency, and recording the snapshot id on the task.

## 18. Changes at v0.6 (decisions from WP-C and WP-D)

Questions 1 to 3 of WP-D were answered by you (yes, agree, agree); the rest were accepted and applied as the agents implemented and tested them. Change any you disagree with before S4 and S5.

| From | Question | Resolution | Where |
|---|---|---|---|
| WP-D | Should dedupe be a visible stage? | Yes (you); the flow gains a `dedupe` stage | §9a |
| WP-D | Memory marks for duplicate and known answer | `open-task` and `known-answer` source kinds, gate-eligible only (you) | §9b |
| WP-D | Trusted security items | Route normally; only untrusted security items go to a human (you) | §9a |
| WP-D | `Hit` lacks `source` and `tags` | Expose them; code follow-up in `memory/` | §9b |
| WP-D | `alternatives[].confidence` meaning | That project's own confidence | §9a |
| WP-D | Kind `security` | Added to the kinds | §9a |
| WP-C | Email workflowId is forgeable | `externalId` from `contentHash`; Message-ID is metadata; search attribute | §9 |
| WP-C | Authentication-Results trust | Mail ingress must strip inbound headers first; deployment requirement | §9 |
| WP-C | Label for authenticated email | `internal` | §9a |
| WP-C | Input record fields | Named in the contract (`origin`, `requiresHuman`, `contentHash`, others) | §9 |
| WP-C | Untrusted and trusted copies | Two Inputs; merging never lowers a gate | §9, §9a |

Code follow-ups (made after v0.6): the `dedupe` stage and `dedupe_search`/`dedupe_decision` in `worker/src/triage/flows/`; `source` and `tags` on the memory `Hit`; the email `externalId` derived from `contentHash`; triage registry handlers in `worker/src/triage/handlers.ts`. Two integration findings from doing them: (1) intake's `<untrusted-data>` wrapper matched triage's injection screen, so every intake item would have gone to a person; triage now screens the content inside one outer wrapper pair (`unwrapDataBlock`), and intake escapes every `<` in the content so a stray tag cannot break out; (2) intake labels trusted email `internal` while triage treats only the exact value `trusted` as trusted; `fromIntake` maps `internal` to `trusted` and everything else to `untrusted`. The handlers are plain functions; binding them to FlowKit's Temporal registry types is part of S2's compatibility check.
