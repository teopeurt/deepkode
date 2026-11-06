# Remaining work plan, Spec C (for delegation to subagents)

**Status:** plan, not yet approved. Per the spec-first rule, work packages that change a spec wait for approval of that change. Written 2026-11-06 against Spec C v0.3, S0 findings, and the S1 runbook.

## How to use this plan
Each work package (WP) is self-contained so a separate agent session can take it. Every WP has: inputs, deliverables, acceptance, and what it must not do. Agents work on branches off `claude/deepcode-flowkit-execution-plane`, one WP per branch, and report evidence (test output or recorded runs). No agent changes a spec's behaviour without an approved amendment. No agent commits secrets or opens PRs unless told.

## Critical path and parallelism

```
S1 (human, real key) ──► WP-A fixes to DeepCodePlane ──► S2 ──► S3
WP-B Temporal wiring ───────────────────────────────────┘
WP-C intake + dedupe ──► S4        WP-D triage ──► S5       WP-E memory ──► S6
```
Can start now, in parallel, against the fake plane and mock model: WP-B, WP-C, WP-D, WP-E, WP-F, WP-G. Blocked on S1 findings: WP-A, and the real-model parts of S2 and later.

## Work packages

### WP-S1: run the S1 spike (human, own environment)
- Inputs: `001b-s1-runbook.md`.
- Deliverable: `001c-s1-findings.md` (table filled in), spec amendment proposal if anything differs.
- Acceptance: Spec C §10 S1 exit criteria, including zero duplicates and a recorded cancel time.
- Gate: if shell checks cannot run unattended and no container is acceptable, stop and re-decide D3.

### WP-A: make `DeepCodePlane` real (after S1)
- Inputs: S1 findings. Replace every `S1-CONFIRM` in `worker/src/deepcode-plane.ts`.
- Deliverables: correct `thread/list` paging and title lookup; `goal/*` start, resume and result mapping into `goalComplete` and `checksPassed`; event-based heartbeats instead of polling if available; an integration test under `worker/test/` that needs a model and is skipped without a key.
- Acceptance: the S1 scenarios (re-attach, cancel, evidence, Goal resume) pass through `DeepCodePlane`, not the fake.
- Must not: change the `ExecutionPlane` interface without a spec note.

### WP-B: Temporal wiring (can start now)
- Inputs: Spec C §4, FlowKit `createFlowkitWorkflow`, the `orchestrate` step and `orchestrators` registry from Spec B, `worker/src/run-subagent.ts`.
- Deliverables: Temporal activities `planOrchestration`, `runSubagent`, `synthesizeOrchestration` wrapping the core logic; heartbeat on every event; Temporal activity cancellation mapped to `AbortSignal`; non-retryable error type for "turn finished and failed"; `maximumAttempts` 2 to 3; a worker entry point.
- Acceptance: with the fake plane, a workflow test shows retry after a worker kill makes no second turn, and cancel ends `cancelled`. Note: Bun worker teardown makes Temporal tests report failure in some sandboxes, so judge by assertions, and run once in a clean environment.
- Must not: touch FlowKit packages; FlowKit stays generic (D6).

### WP-F: plan validation and the critique stage (can start now)
- Inputs: Spec C §4.4 and §8, adversarial-check requirement.
- Deliverables: a validator for the plan JSON `{ tasks: [{ id, agent, input }] }` with one corrective retry; the critique activity contract (separate thread, different model per §7, read-only); deterministic checks that run before any model critique (scope, repo set, task count, cycle in dependencies).
- Acceptance: unit tests for invalid, duplicate-id, unknown-agent, and oversized plans; each failure ends in a human gate, never a silent pass.

### WP-G: workspaces and multi-repo (can start now)
- Inputs: Spec C §5, D8.
- Deliverables: worktree creation and naming `{workflowId}/{epoch}/{repo}/{taskId}`; diff collection (`collectDiff`) and scope enforcement; per-repo checks; partial-failure policy that stops at a human gate; cleanup of worktrees and project records (depends on the S1 cleanup finding).
- Acceptance: tests on temporary git repos for one and two repos, a conflict, and a partial failure; no automatic cross-repo merge.

### WP-S2: orchestrate end to end (needs WP-A, WP-B, WP-F, WP-G)
- Deliverable: an `orchestrate` flow with plan, 2 to 3 subagents, synthesize, auto gate; failure-injection suite (bad plan, failed task, conflict).
- Acceptance: every injected failure ends in a human gate, never a silent release.

### WP-S3: full pipeline
- Deliverable: plan, critique, execute, security, review flow with human approval and SLA escalation.
- Acceptance: a run completes end to end; an SLA timeout escalates and cancels cleanly. Security stage uses the model assigned in the routing table (§7); if a Fable model is unavailable (U5), record the fallback.

### WP-C: intake and dedupe (can start now; S4)
- Inputs: Spec C §9.
- Deliverables: one channel adapter (choose the first: email or Slack; ask which), normalisation to an `Input` record with origin and trust level, content-hash dedupe, and a prompt-injection test set (at least 30 cases) with an assertion that injected text cannot change files outside the plan.
- Acceptance: duplicates collapse; all untrusted-origin runs require a human before `execute` (D4).

### WP-D: shared triage flow (can start now with fixtures; S5)
- Inputs: Spec C §9a, a labelled sample (needs 50 or more examples per input type; the user must supply or approve synthetic ones).
- Deliverables: one FlowKit triage definition for two input types; project registry supporting several repos per project; `needs_human` below a confidence threshold.
- Acceptance: both types classify and route correctly on the sample; every wrong or low-confidence case reaches a human; a two-repo task gets per-repo worktrees.

### WP-E: memory service (can start now; S6)
- Inputs: Spec C §9b, D7, Helmsman's KB design in `docs/ARCHITECTURE.md`.
- Deliverables: a `Memory` interface with an in-process implementation; capture after review with a specificity bar; trust levels; retrieval at triage and plan; snapshot id recorded on the task; poisoning test set; embedding comparison for U10 on measured retrieval.
- Acceptance: a repeated issue is recognised; untrusted-origin notes never reach the stable prefix or an auto-gate.

### WP-H: retire Helmsman (last; Spec C §11)
- Deliverable: a migration note and removal PR plan for `dsh/` engine plugins and the web UI decision (D5: Temporal UI plus DeepCode Web now).
- Acceptance: nothing in the new path depends on port 3081 conflict or on dsh plugins. Do not delete anything without explicit approval.

### WP-I: FlowKit PR (human decision)
- Open a PR for `feat/auto-gated-ai-steps` once the test suite passes in a clean environment. CONTRIBUTING requires verification output.

## Standing rules for every WP
1. Success is judged from evidence, not from turn status (Spec C §3).
2. Untrusted input never reaches a prompt's trusted section, an auto-gate, or the stable memory prefix.
3. Record metrics from S1 on: success rate, interventions, tokens and cost, wall-clock, duplicates (must be 0), resume correctness.
4. Tests that need a model are skipped without a key; all others run offline.
5. Report back: what was done, evidence (commands and output), what is untested.

## Open items needing the user
- First intake channel (email or Slack) for WP-C.
- The labelled sample for WP-D: supply it or approve synthetic data.
- Approval of this plan, then which WPs to launch now (suggested: WP-B, WP-F, WP-G first).
