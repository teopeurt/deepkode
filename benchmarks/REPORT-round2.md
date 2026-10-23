# CWL Structured Eviction — Experiment Report (Round 2: real-pressure comparison)

> Date: 2026-09 | Paradigm: arXiv:2606.11213 | In-house: standalone plugin `dsh-cwl` (consumed by Helmsman as a dependency)
> Round 1 conclusion (hard-pressing eviction on short tasks is harmful) → methodology fix: **real pressure from multi-round conversation** + graduated eviction

## Methodology fix (the key point)

Round 1 tested eviction by "hard-pressing 5-step short tasks with a low budget" and concluded "eviction is harmful" —— **that was the wrong way to test**.
After the fix:
1. **A real pressure scenario**: 12 consecutive rounds of conversation in the same session, with context naturally accumulating to 200K+ cacheRead tokens
2. **Pressure-metering fix**: `tokenMeter.measure().totalTokens` excludes cacheRead (the cache is the main occupant of a long session's
   context) → real pressure is now accumulated from session usage events instead (input+cache+output+reason)
3. **Graduated eviction**: aligned with pi-cwl's graduated levels (expl first, depended-on expl protected, the newest tail protected)

## Setup

- Scenario: 12 consecutive rounds in the same chat session, each round "read items.json + write a file based on the round number"
- CWL budget: `DSH_CWL_BUDGET=30000` (eviction triggers when the context exceeds 30K)
- baseline: no eviction (the default 80% threshold never triggers)

## Results (real session usage, all 12 rounds Done)

| Metric | baseline | CWL (evicted expl-1/expl-2/act-1) | Δ |
|---|---|---|---|
| turns | 12 | 12 | — |
| steps | 30 | 26 | **-13%** |
| inputTokens | 28,478 | **10,343** | **-64%** |
| cacheReadTokens | 200,576 | 178,432 | **-11%** |
| outputTokens | 2,809 | 2,107 | **-25%** |
| reasoningTokens | 128 | 126 | — |

## Conclusion

**CWL is effective in real long sessions (answering "when to manage, and how")**:
- **inputTokens -64%**: once the early expl segments are evicted, the agent no longer re-reads large chunks every round → uncached input drops sharply
- **steps -13%, output -25%**: efficiency improves, and quality over the 12 rounds doesn't drop (the price calculation is correct every round)
- **3 evictions did not break the task** (compared with round 1 v1, where 50 evictions dragged a task down)

**Limits (honestly)**:
- cacheRead only -11%: the early segments are evicted, but each new round's content dominates the cache, so the total pressure reduction is limited
- The gains are concentrated in input (the uncached part) → suited to ultra-long sessions / low cache-hit scenarios

## Reproduce

```bash
# baseline (no eviction)
node dsh/launcher.mjs dsh/cordis.yml
node benchmarks/run-context-pressure.mjs baseline 12
# CWL (budget 30000 triggers eviction)
DSH_CWL_BUDGET=30000 node dsh/launcher.mjs dsh/cordis.yml
node benchmarks/run-context-pressure.mjs cwl 12
```
