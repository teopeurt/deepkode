# Spec C, phase S1 runbook

Run this in an environment with a real model key. Record results in `docs/specs/001c-s1-findings.md` using the template at the bottom.

## Prerequisites
- DeepCode 2.3.1 (`uv tool install --python 3.12 deepcode-hku`), a throwaway `DEEPCODE_HOME`, never your real `~/.deepcode`.
- A model connection with a real key (`deepcode provider set ...`). Anthropic, plus a Fable entry if your provider lists one (U5).
- Bun, git, and ideally bubblewrap (`bwrap`). Temporal dev server is only needed from S2.
- Stop Helmsman's engine (port 3081 clash).
- Code under test: `worker/` (`bun test` passes against the fake plane; `src/deepcode-plane.ts` has never run).

## Steps and what to record
1. **Provider and models (U5).** `deepcode provider test <name> --model <m>` for each routing role. Record which models list, which fail, and whether a Fable model exists.
2. **Goal.** In a trusted toy repo, run a Goal with a check command (`deepcode loop` equivalent, then find the `goal/*` RPC names with the app-server schema). Record: RPC method names and params, how completion is recorded, and what a failing check does.
3. **Goal restart.** Kill the service mid-Goal, restart. Record whether the Goal is paused, and what resumes it.
4. **Shell allow patterns.** Under `ask`, with `security.permissions` allow rules for `write`/`edit` plus bash patterns for the check commands, run a turn that executes the check unattended. Record the exact rule syntax that works and that a non-matching command is denied.
5. **Sandbox.** `which bwrap`; run a shell tool call and see whether it is sandboxed. If unavailable, decide: per-task container or accept (stop condition in Spec C §10).
6. **Idempotent re-attach.** Using `DeepCodePlane`: start a task, SIGKILL the worker mid-turn, start again with the same key. Expect one thread, one turn, one model call per request (count at the provider or via `model_usage_recorded`).
7. **Cancel.** Abort during a long turn. Expect `interrupted` within a bounded time; record the time.
8. **Evidence rule.** Deny writes, run a turn, confirm `runSubagent` classifies it failed.
9. **Scale.** Create ~200 threads/worktrees; time title lookup (`thread/list` name and paging are S1-CONFIRM in `deepcode-plane.ts`); record project-record growth and whether any removal method exists; check `messageId` reuse across two threads does not collide.

## Fix-ups expected in `deepcode-plane.ts`
`thread/list`, `goal/start`, the `turn/start` response field for the turn id, and filling `goalComplete`/`checksPassed` from goal state are guesses. Correct them from step 2 and 6.

## Findings template
| Item | Pass/fail | Evidence | Spec change needed |
|---|---|---|---|
| U5 models | | | |
| Goal checks | | | |
| Goal restart | | | |
| Shell allow | | | |
| Sandbox | | | |
| Re-attach, zero duplicates | | | |
| Cancel bound (seconds) | | | |
| Evidence rule | | | |
| Scale / cleanup / messageId scope | | | |
