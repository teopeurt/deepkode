// Dedupe (Spec C §9, §9a "duplicates collapse twice"; this is the intake-side pass).
// Exact: same normalised subject+body hash. Near: word-shingle Jaccard at or above NEAR_DUPLICATE_THRESHOLD.
// Keyed per project and channel. Trust rule: an Input only ever absorbs occurrences of its OWN trust class, and its
// origin and requiresHuman never change. A trusted mail identical to an untrusted one stays a separate Input.
import { jaccardSets, shingles } from "./normalize";
import type { Input, Occurrence, Signal } from "./types";

/** Minimum Jaccard similarity of 3-word shingles for a near duplicate. Tuned for re-sends with small edits. */
export const NEAR_DUPLICATE_THRESHOLD = 0.85;
/** Texts with fewer shingles than this are only exact-matched: Jaccard on a handful of shingles is unreliable. */
export const MIN_SHINGLES_FOR_NEAR = 8;

export type DedupeOutcome = "new" | "exact_duplicate" | "near_duplicate";
export interface DedupeResult {
  outcome: DedupeOutcome;
  /** Snapshot of the canonical Input after this ingest (a copy: mutate nothing). */
  input: Input;
  similarity: number;
}

interface Entry { input: Input; shingles: Set<string> }

export class IntakeDeduper {
  private readonly buckets = new Map<string, Entry[]>();
  private readonly byId = new Map<string, Entry>();

  /** `projectId` scopes dedupe; the channel comes from the Input. Idempotent for an identical rawHash. */
  ingest(projectId: string, incoming: Input): DedupeResult {
    const bucketKey = `${projectId}\u0000${incoming.channel}`;
    const bucket = this.buckets.get(bucketKey) ?? [];
    this.buckets.set(bucketKey, bucket);
    const sameClass = bucket.filter((e) => e.input.origin === incoming.origin);

    // Same delivery seen again (e.g. a queue redelivery): nothing to add.
    const redelivery = sameClass.find((e) => e.input.occurrences.some((o) => o.rawHash === incoming.rawHash));
    if (redelivery) return { outcome: "exact_duplicate", input: structuredClone(redelivery.input), similarity: 1 };

    const exact = sameClass.find((e) => e.input.contentHash === incoming.contentHash);
    if (exact) return this.absorb(exact, incoming, "exact", 1);

    const sh = shingles(incoming.subject + "\n" + incoming.body);
    if (sh.size >= MIN_SHINGLES_FOR_NEAR) {
      let best: { e: Entry; sim: number } | null = null;
      for (const e of sameClass) {
        if (e.shingles.size < MIN_SHINGLES_FOR_NEAR) continue;
        const sim = jaccardSets(sh, e.shingles);
        if (sim >= NEAR_DUPLICATE_THRESHOLD && (!best || sim > best.sim)) best = { e, sim };
      }
      if (best) return this.absorb(best.e, incoming, "near", best.sim);
    }

    const entry: Entry = { input: structuredClone(incoming), shingles: sh };
    bucket.push(entry);
    this.byId.set(entry.input.id, entry);
    return { outcome: "new", input: structuredClone(entry.input), similarity: 1 };
  }

  get(inputId: string): Input | undefined {
    const e = this.byId.get(inputId);
    return e ? structuredClone(e.input) : undefined;
  }

  private absorb(entry: Entry, incoming: Input, kind: "exact" | "near", similarity: number): DedupeResult {
    const canon = entry.input;
    const occ: Occurrence = {
      inputId: incoming.id, messageId: incoming.messageId, sender: incoming.sender, receivedAt: incoming.receivedAt,
      rawHash: incoming.rawHash, kind, similarity,
    };
    canon.occurrences.push(occ);
    // Never lower scrutiny: signals from a collapsed duplicate are recorded; trust class and requiresHuman stay as they were.
    for (const s of incoming.signals) {
      if (!canon.signals.some((x: Signal) => x.code === s.code && x.where === s.where && x.detail === s.detail)) canon.signals.push({ ...s, where: `occurrence:${s.where}` });
    }
    if (incoming.requiresHuman) canon.requiresHuman = true;
    return { outcome: kind === "exact" ? "exact_duplicate" : "near_duplicate", input: structuredClone(canon), similarity };
  }
}
