// U10 evaluation harness: compare embedders on labelled query/note pairs, offline.
//
// Run (see eval-cli.ts):
//   cd worker && bun src/memory/eval-cli.ts <dataset.json> [<embedder-module> ...]
// With no embedder module the deterministic HashEmbedder test double is used.
// An embedder module must `export default` an object (or a zero-arg function
// returning one) that implements `Embedder` from ./types. Real models are
// plugged in that way; this repository does not choose one (U10).
//
// Dataset JSON: { "notes": [{ "id": "n1", "text": "..." }],
//                 "queries": [{ "query": "...", "relevant": ["n1"] }] }
//
// Metrics: recall@k = share of relevant notes found in the top k, averaged
// over queries; MRR = mean of 1/rank of the first relevant note (0 if absent).

import type { Embedder } from "./types";
import { cosine } from "./text";

export interface EvalNote { id: string; text: string }
export interface EvalQuery { query: string; relevant: string[] }
export interface EvalDataset { notes: EvalNote[]; queries: EvalQuery[] }
export interface EvalReport {
  embedder: string;
  queries: number;
  recallAtK: Record<number, number>;
  mrr: number;
  perQuery: { query: string; rank: number | null; top: string[] }[];
}

export function recallAt(ranked: string[], relevant: string[], k: number): number {
  if (!relevant.length) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((r) => top.has(r)).length / relevant.length;
}

export function reciprocalRank(ranked: string[], relevant: string[]): number {
  const i = ranked.findIndex((id) => relevant.includes(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

export async function evaluateEmbedder(embedder: Embedder, data: EvalDataset, ks: number[] = [1, 3, 5, 10]): Promise<EvalReport> {
  if (!data.queries.length) throw new Error("dataset has no queries");
  const nv = await embedder.embed(data.notes.map((n) => n.text));
  const qv = await embedder.embed(data.queries.map((q) => q.query));
  const recall: Record<number, number> = Object.fromEntries(ks.map((k) => [k, 0]));
  let mrr = 0;
  const perQuery: EvalReport["perQuery"] = [];
  data.queries.forEach((q, qi) => {
    const ranked = data.notes
      .map((n, i) => ({ id: n.id, s: cosine(qv[qi]!, nv[i]!) }))
      .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1))
      .map((x) => x.id);
    for (const k of ks) recall[k]! += recallAt(ranked, q.relevant, k);
    mrr += reciprocalRank(ranked, q.relevant);
    const idx = ranked.findIndex((id) => q.relevant.includes(id));
    perQuery.push({ query: q.query, rank: idx < 0 ? null : idx + 1, top: ranked.slice(0, 3) });
  });
  const n = data.queries.length;
  for (const k of ks) recall[k] = recall[k]! / n;
  return { embedder: embedder.id, queries: n, recallAtK: recall, mrr: mrr / n, perQuery };
}

export function formatReport(r: EvalReport): string {
  const ks = Object.keys(r.recallAtK).map(Number).sort((a, b) => a - b);
  return [`${r.embedder}  queries=${r.queries}`, ...ks.map((k) => `  recall@${k}: ${r.recallAtK[k]!.toFixed(3)}`), `  MRR: ${r.mrr.toFixed(3)}`].join("\n");
}
