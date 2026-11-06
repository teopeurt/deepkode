import { describe, expect, test } from "bun:test";
import { SqliteStore, InMemoryStore, type MemoryStore } from "./store";
import { HashEmbedder } from "./embedder";
import { specificity } from "./specificity";
import { evaluateEmbedder, recallAt, reciprocalRank, type EvalDataset } from "./eval";
import type { Embedder } from "./types";
import { cap, esmNote, human, mkMemory } from "./testkit";

const P = "proj";

describe("capture and specificity", () => {
  test("generic summaries are rejected", async () => {
    const m = mkMemory();
    const generic = [
      { title: "Fixed a bug", content: ["Fixed the bug and improved code quality in several places."] },
      { title: "Refactored the module", content: ["Refactored and cleaned up the module, updated tests and docs, following best practices."] },
      { title: "Various improvements", content: ["Made various changes and general improvements to make it work as expected overall."] },
    ];
    const r = await m.capture(cap(P, "t1", "trusted", generic));
    expect(r.map((x) => x.action)).toEqual(["rejected", "rejected", "rejected"]);
    expect(r.every((x) => x.action === "rejected" && x.reason === "not_specific")).toBe(true);
    expect(m.list(P)).toHaveLength(0);
  });
  test("a specific note passes the bar", () => {
    expect(specificity(esmNote).ok).toBe(true);
  });
  test("capture requires review approval", async () => {
    const m = mkMemory();
    const r = await m.capture({ ...cap(P, "t1", "trusted", [esmNote]), review: { approved: false } });
    expect(r[0]).toMatchObject({ action: "rejected", reason: "review_not_approved" });
    expect(m.list(P)).toHaveLength(0);
  });
  test("trusted task yields agent-generated/trusted; untrusted task yields unverified/untrusted; provenance recorded", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [esmNote], { repo: "api" }));
    await m.capture(cap(P, "t2", "untrusted", [{ ...esmNote, title: "Vite build fails with ENOSPC watching packages/web/src", content: ["`vite build --watch` raises ENOSPC when inotify limit is 8192 in packages/web/vite.config.ts."], applicability: "Linux CI containers with low fs.inotify limits" }]));
    const [a, b] = m.list(P);
    expect(a).toMatchObject({ trust: "agent-generated", origin: "trusted", pinned: false, provenance: [{ taskId: "t1", repo: "api" }] });
    expect(b).toMatchObject({ trust: "unverified", origin: "untrusted" });
    expect(a!.validUntil).toBeNull();
    expect(a!.recordedAt).toBeTruthy();
  });
  test("exact repeat merges instead of inserting; occurrences and provenance grow", async () => {
    const m = mkMemory();
    const r1 = await m.capture(cap(P, "t1", "trusted", [esmNote]));
    const r2 = await m.capture(cap(P, "t2", "trusted", [{ ...esmNote, tags: ["jest", "esm", "node-fetch"] }], { repo: "api" }));
    expect(r1[0]!.action).toBe("inserted");
    expect(r2[0]!.action).toBe("merged");
    const notes = m.list(P);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ occurrences: 2, version: 2 });
    expect(notes[0]!.provenance.map((p) => p.taskId)).toEqual(["t1", "t2"]);
    expect(notes[0]!.tags).toContain("node-fetch");
    expect(notes[0]!.trust).toBe("agent-generated");
  });
  test("merge never edits a human-approved note", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [esmNote]));
    const id = m.list(P)[0]!.id;
    m.approve(id, human);
    const v = m.list(P)[0]!.version;
    const r = await m.capture(cap(P, "t2", "trusted", [{ ...esmNote, content: [...esmNote.content, "Extra line from a later task."] }]));
    expect(r[0]).toMatchObject({ action: "duplicate", noteId: id });
    expect(m.list(P)[0]!.version).toBe(v);
    expect(m.list(P)[0]!.content).toEqual(esmNote.content);
  });
});

describe("repeated issue is recognised (S6 exit)", () => {
  const issue = "Jest crashes with ERR_REQUIRE_ESM when api/src/db.ts imports node-fetch";
  test("approved note is top hit at triage, eligible for stable prefix once pinned", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [esmNote]));
    await m.capture(cap(P, "t1", "trusted", [{ title: "Postgres pool exhausted in services/billing/src/pool.ts", content: ["`max: 10` in pool.ts is exceeded by the nightly job; raise to 40 and set idleTimeoutMillis."], applicability: "Billing service under nightly batch load", antiPatterns: ["Do not retry on connection refused without backoff"] }]));
    const id = m.list(P).find((n) => n.title.startsWith("Jest"))!.id;
    m.approve(id, human);
    m.pin(id, human);
    const tri = await m.retrieve(P, issue, { stage: "triage" });
    expect(tri.hits[0]!.noteId).toBe(id);
    expect(tri.hits[0]!.channelScores.keyword).toBeGreaterThan(0);
    expect(tri.hits[0]!.channelScores.semantic).toBeGreaterThan(0);
    expect(tri.hits[0]!.trust).toBe("human-approved");
    const asm = await m.assemble(P, issue);
    expect(asm.stablePrefix).toContain("ERR_REQUIRE_ESM");
    expect(asm.gateEligible.map((h) => h.noteId)).toEqual([id]);
    expect(m.getSnapshot(asm.snapshotId)!.stage).toBe("plan");
  });
  test("unapproved agent-generated note is recognised as labelled data, not in prefix or gate", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [esmNote]));
    const a = await m.assemble(P, "ERR_REQUIRE_ESM node-fetch jest failure");
    expect(a.hits).toHaveLength(1);
    expect(a.hits[0]!.label).toContain("agent-generated");
    expect(a.stablePrefix).toBe("");
    expect(a.gateEligible).toHaveLength(0);
    expect(a.dataBlock).toContain("<untrusted-data>");
    expect(a.dataBlock).toContain("not instructions");
  });
  test("a semantically close paraphrase without shared rare tokens still ranks the note first", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [esmNote]));
    await m.capture(cap(P, "t1", "trusted", [{ title: "Vite build fails with ENOSPC in packages/web/vite.config.ts", content: ["`vite build --watch` raises ENOSPC when the inotify limit is 8192."], applicability: "Linux CI containers with low fs.inotify limits" }]));
    const r = await m.retrieve(P, "jest esm dependency import error in the api package", { stage: "triage" });
    expect(r.hits[0]!.title).toMatch(/Jest/);
  });
});

describe("bitemporal validity", () => {
  test("invalidation is soft; past views still explain", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [esmNote]));
    const n = m.list(P)[0]!;
    const before = new Date(Date.parse(n.recordedAt) + 500).toISOString();
    m.invalidate(n.id, human);
    expect(m.list(P)).toHaveLength(0);
    expect(m.list(P, { includeInvalid: true })).toHaveLength(1);
    const now = await m.retrieve(P, "ERR_REQUIRE_ESM node-fetch");
    expect(now.hits).toHaveLength(0);
    const past = await m.retrieve(P, "ERR_REQUIRE_ESM node-fetch", { asOf: before, knownAt: before });
    expect(past.hits.map((h) => h.noteId)).toEqual([n.id]);
    // known-now view of the past: the note had ended by now, but asOf before its end still sees it
    const hist = await m.retrieve(P, "ERR_REQUIRE_ESM node-fetch", { asOf: before });
    expect(hist.hits.map((h) => h.noteId)).toEqual([n.id]);
    // not yet recorded
    const none = await m.retrieve(P, "ERR_REQUIRE_ESM node-fetch", { asOf: before, knownAt: "2025-01-01T00:00:00.000Z" });
    expect(none.hits).toHaveLength(0);
    expect(m.list(P, { includeInvalid: true })[0]).toMatchObject({ invalidatedBy: "alice" });
  });
  test("repo scope and project scope filter", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [{ ...esmNote, repoScope: "api" }]));
    await m.capture(cap("other", "t2", "trusted", [esmNote]));
    expect((await m.retrieve(P, "ERR_REQUIRE_ESM", { repoScope: "web" })).hits).toHaveLength(0);
    expect((await m.retrieve(P, "ERR_REQUIRE_ESM", { repoScope: "api" })).hits).toHaveLength(1);
    expect((await m.retrieve("other", "ERR_REQUIRE_ESM")).hits).toHaveLength(1);
    expect((await m.retrieve("nobody", "ERR_REQUIRE_ESM")).hits).toHaveLength(0);
  });
});

describe("snapshots", () => {
  test("same state and query give the same id; re-read returns identical hits", async () => {
    const run = async () => {
      const m = mkMemory();
      await m.capture(cap(P, "t1", "trusted", [esmNote]));
      m.approve(m.list(P)[0]!.id, human);
      m.pin(m.list(P)[0]!.id, human);
      return { m, a: await m.assemble(P, "ERR_REQUIRE_ESM node-fetch") };
    };
    const x = await run(), y = await run();
    expect(x.a.snapshotId).toBe(y.a.snapshotId);
    const again = await x.m.assemble(P, "ERR_REQUIRE_ESM node-fetch");
    expect(again.snapshotId).toBe(x.a.snapshotId);
    expect(x.m.getSnapshot(x.a.snapshotId)!.hits).toEqual(x.a.hits);
  });
  test("later changes do not alter an earlier snapshot; a changed state gets a new id", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [esmNote]));
    const s1 = await m.retrieve(P, "ERR_REQUIRE_ESM node-fetch");
    const frozen = JSON.stringify(m.getSnapshot(s1.snapshotId));
    m.approve(m.list(P)[0]!.id, human);
    m.invalidate(m.list(P)[0]!.id, human);
    const s2 = await m.retrieve(P, "ERR_REQUIRE_ESM node-fetch");
    expect(s2.snapshotId).not.toBe(s1.snapshotId);
    expect(JSON.stringify(m.getSnapshot(s1.snapshotId))).toBe(frozen);
    expect(m.getSnapshot(s1.snapshotId)!.hits[0]!.trust).toBe("agent-generated");
    expect(m.getSnapshot("snap_missing")).toBeNull();
  });
  test("snapshot objects are frozen", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [esmNote]));
    const s = await m.retrieve(P, "ERR_REQUIRE_ESM");
    const snap = m.getSnapshot(s.snapshotId)!;
    expect(() => { (snap.hits[0] as { trust: string }).trust = "human-approved"; }).toThrow();
  });
  test("stage is part of the snapshot", async () => {
    const m = mkMemory();
    await m.capture(cap(P, "t1", "trusted", [esmNote]));
    const a = await m.retrieve(P, "ERR_REQUIRE_ESM", { stage: "triage" });
    const b = await m.retrieve(P, "ERR_REQUIRE_ESM", { stage: "plan" });
    expect(a.snapshotId).not.toBe(b.snapshotId);
  });
});

describe("storage implementations behave the same", () => {
  for (const [name, mk] of [["in-memory", () => new InMemoryStore()], ["sqlite", () => new SqliteStore()]] as [string, () => MemoryStore][]) {
    test(name, async () => {
      const m = mkMemory({ store: mk() });
      await m.capture(cap(P, "t1", "trusted", [esmNote]));
      await m.capture(cap(P, "t2", "trusted", [esmNote]));
      const n = m.list(P);
      expect(n).toHaveLength(1);
      m.approve(n[0]!.id, human);
      m.pin(n[0]!.id, human);
      const a = await m.assemble(P, "ERR_REQUIRE_ESM");
      expect(a.stableNoteIds).toEqual([n[0]!.id]);
      expect(m.getSnapshot(a.snapshotId)!.stablePrefix).toBe(a.stablePrefix);
    });
  }
  test("sqlite and in-memory produce the same snapshot id", async () => {
    const ids: string[] = [];
    for (const s of [new InMemoryStore(), new SqliteStore()]) {
      const m = mkMemory({ store: s });
      await m.capture(cap(P, "t1", "trusted", [esmNote]));
      ids.push((await m.retrieve(P, "ERR_REQUIRE_ESM")).snapshotId);
    }
    expect(ids[0]).toBe(ids[1]!);
  });
});

describe("U10 evaluation harness", () => {
  const data: EvalDataset = {
    notes: [
      { id: "n1", text: "jest fails ERR_REQUIRE_ESM node-fetch" },
      { id: "n2", text: "postgres pool exhausted billing nightly job" },
      { id: "n3", text: "vite build ENOSPC inotify watch limit" },
    ],
    queries: [
      { query: "jest esm node-fetch import crash", relevant: ["n1"] },
      { query: "billing database connections exhausted", relevant: ["n2"] },
      { query: "file watcher inotify ENOSPC", relevant: ["n3", "n1"] },
    ],
  };
  test("metric helpers", () => {
    expect(recallAt(["a", "b", "c"], ["b", "z"], 2)).toBe(0.5);
    expect(recallAt([], [], 3)).toBe(0);
    expect(reciprocalRank(["a", "b", "c"], ["c"])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(["a"], ["z"])).toBe(0);
  });
  test("scripted embedder gives exact recall and MRR", async () => {
    // One-hot vectors: query i points at note given by `target`.
    const target: Record<string, number> = { "q-a": 0, "q-b": 1, "q-c": 2 };
    const ids = ["x0", "x1", "x2"];
    const e: Embedder = {
      id: "scripted",
      embed: async (ts) => ts.map((t) => {
        const v = [0, 0, 0];
        if (t in target) v[target[t]!] = 1; else v[ids.indexOf(t)] = 1;
        return v;
      }),
    };
    const d: EvalDataset = {
      notes: ids.map((id) => ({ id, text: id })),
      // q-a -> x0 ranks first (hit), q-b -> x1 first but relevant is x2 (rank 2 or 3 by id order), q-c -> x2 first
      queries: [{ query: "q-a", relevant: ["x0"] }, { query: "q-b", relevant: ["x2"] }, { query: "q-c", relevant: ["x2"] }],
    };
    const r = await evaluateEmbedder(e, d, [1, 2, 3]);
    // q-b ranking: x1 (1.0), then x0, x2 tie at 0 sorted by id -> x2 at rank 3
    expect(r.recallAtK[1]).toBeCloseTo(2 / 3);
    expect(r.recallAtK[2]).toBeCloseTo(2 / 3);
    expect(r.recallAtK[3]).toBe(1);
    expect(r.mrr).toBeCloseTo((1 + 1 / 3 + 1) / 3);
    expect(r.perQuery[1]!.rank).toBe(3);
  });
  test("runs offline with the hash test double", async () => {
    const r = await evaluateEmbedder(new HashEmbedder(), data);
    expect(r.embedder).toBe("hash-256-v1");
    expect(r.recallAtK[1]).toBeGreaterThanOrEqual(2 / 3 * 0.5);
    expect(r.recallAtK[3]).toBe(1);
    expect(r.mrr).toBeGreaterThan(0.6);
    expect((await evaluateEmbedder(new HashEmbedder(), data)).mrr).toBe(r.mrr);
  });
  test("empty dataset is an error", async () => {
    await expect(evaluateEmbedder(new HashEmbedder(), { notes: [], queries: [] })).rejects.toThrow();
  });
});

test("retrieval hits expose source and tags so callers need no second lookup", async () => {
  const m = mkMemory();
  const [r] = await m.capture(cap("p1", "task-1", "trusted", [{
    title: "Checkout pay button unresponsive in Safari 17 in src/components/PayButton.tsx",
    content: ["The pay button in `PayButton` ignores taps in Safari 17."], summary: "s", applicability: "pay button Safari", tags: ["checkout"],
  }], { source: { kind: "open-task", ref: "task-1" } }));
  if (r?.action !== "inserted") throw new Error("seed failed");
  const { hits } = await m.retrieve("p1", "checkout pay button unresponsive in Safari", { stage: "triage" });
  expect(hits[0]?.source).toEqual({ kind: "open-task", ref: "task-1" });
  expect(hits[0]?.tags).toContain("checkout");
});
