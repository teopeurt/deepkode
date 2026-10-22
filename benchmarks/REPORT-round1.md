# CWL Structured Eviction — Experiment Report (Round 1)

> Date: 2026-09 | Paradigm: arXiv:2606.11213 (Context Window Lifecycle)
> In-house implementation: standalone plugin `dsh-cwl` (consumed by Helmsman as a dependency) | Experiment script: `run-cwl-experiment.mjs`

## Conclusion first (the honest version)

**At the current experiment scale (6 long tasks × 5 steps, ~8-15K tokens per task), CWL eviction is a burden, not an asset.**
This is **not an implementation failure** but **empirical evidence of a scale mismatch** —— the CWL paper targets ultra-long sessions
(89 consecutive tasks, 80M tokens), where evicting action segments that are "already persisted and no longer needed" pays off;
short-task contexts are too small, and eviction creates a negative loop of "context lost → redo".

## Setup

- **Three control groups** (target): unmanaged baseline / summary compression (the ACP route) / CWL eviction
- **Task set**: `data/long-tasks.json` (6 tasks × 5 steps, decidable acceptance: artifact file checks)
- **CWL budget**: low thresholds injected via `DSH_CWL_BUDGET` (6000/8000/10000/12000) to simulate long-task pressure
- **Metrics**: completion rate / acceptance pass rate / step count / cost / eviction count

## Results

### Budget 8000 (eviction fires aggressively, 103 times)

| Task | Status | Steps | Cost | Evictions |
|---|---|---|---|---|
| lt-1 config audit | Done | 18 | ¥0.088 | 14 |
| lt-2 multi-module docs | Done | 8 | ¥0.035 | 5 |
| **lt-3 refactor scripts** | Done | **74** | **¥0.657** | **50** |
| lt-4 data processing | Done | 10 | ¥0.066 | 6 |
| lt-5 environment config | Done | 12 | ¥0.042 | 5 |
| lt-6 fill in tests | Done | 28 | ¥0.118 | 23 |
| **Total** | 6/6 | 150 | **¥1.006** | 103 |

For comparison: the no-eviction baseline (budget 20000, never triggered) was 6/6 done, 75 steps, ¥0.399.

### Budget 12000 (evict expl first, still too frequent)

| Task | Status | Steps | Cost |
|---|---|---|---|
| 5 normal tasks | Done | 8-15 | ¥0.03-0.09 |
| 1 task dragged down | Failed | 47 | ¥0.632 (~50 evictions) |

## Analysis

1. **Over-frequent eviction breaks work continuity**: lt-3 was evicted 50 times → the agent lost its prior context at every step → repeatedly re-explored/redid work (74 steps, ¥0.66, 5-10× normal)
2. **Evicting expl first is still not enough**: expl eviction keeps a summary (`explored: read, grep (path)`), but the agent's **reasoning dependency on the summary** ("what was read → decide based on it") can't be replaced by one line
3. **There is no budget sweet spot**: 6000 breaks tasks; 8000/10000/12000 are all too frequent; and the normal 128K window never triggers at all —— there is no suitable eviction budget for short tasks

## Lessons and next steps

1. **CWL's value is in ultra-long tasks**: we need truly long tasks with 20+ steps accumulating >50K tokens (or cross-task sessions) to measure an eviction advantage
2. **Eviction selection needs to be smarter**: the current "oldest first" is too mechanical; follow the paper's **dependency graph** —— only evict exploration segments that "later actions no longer reference" (requires the agent to annotate deps actively, i.e. the full version of cwl_mark)
3. **Options**:
   - A. Build truly long tasks (20-30 steps of continuous work in one session) and retest
   - B. Accept the conclusion "eviction doesn't help short tasks" and position CWL as **for ultra-long sessions only** (off by default, enabled only above a threshold)
   - C. Improve the eviction strategy (dependency graph + better summaries) and then retest

## Reproduce

```bash
# Start the engine (inject the budget)
DSH_CWL_BUDGET=8000 node dsh/launcher.mjs dsh/cordis.yml
# Run the CWL group
node benchmarks/run-cwl-experiment.mjs cwl
```

---

## Round 2: episode inference v2 (phase merging + dependency graph)

### Improvements
- **Phase merging**: consecutive tool calls of the same type are merged into a semantic episode (7.7 tool calls per episode on average,
  instead of v1's one segment per assistant/message)
- **Dependency graph**: if a file touched (read/written) by an act was read earlier by an expl → a deps edge; expl segments that are depended on are not evicted
- **expl eviction keeps a summary** (`explored: read, grep (path)`), so working memory isn't lost

### Results (budget 12000)

| Metric | v1 (fragmented) | v2 (merged + deps) | Baseline (no eviction) |
|---|---|---|---|
| Evictions | 103 | **10** | 0 |
| Total steps | 150 | 95 | 75 |
| Total cost | ¥1.01 | ¥0.67 | ¥0.40 |
| Completion rate | 6/6 | 6/6 | 6/6 |
| Acceptance | 5/6 | 5/6 | 5/6 |

### Analysis
- Evictions dropped 90% (103→10); normal tasks (lt-1/4/5) had 0 evictions under v2 and cost on par with the baseline
  → **v2 fixes "fragmented eviction breaking tasks"**
- But lt-3 (refactor scripts, a difficulty outlier) was still amplified by 4 evictions (37 steps, ¥0.42 vs 19 steps for the baseline)
- **Honest conclusion**: v2 fixes correctness, but eviction still has no net benefit on short tasks —— the tokens saved
  don't outweigh the context loss + redo risk that eviction brings. CWL's value is in ultra-long sessions (the paper's scenario);
  at short-task (5-step) scale, "no eviction" is still optimal
