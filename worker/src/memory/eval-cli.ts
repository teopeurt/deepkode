// Usage: cd worker && bun src/memory/eval-cli.ts <dataset.json> [<embedder-module> ...]
// See eval.ts for the dataset format and the embedder module contract.
import { HashEmbedder } from "./embedder";
import { evaluateEmbedder, formatReport, type EvalDataset } from "./eval";
import type { Embedder } from "./types";
import { resolve } from "node:path";

const [data, ...mods] = process.argv.slice(2);
if (!data) { console.error("usage: bun src/memory/eval-cli.ts <dataset.json> [<embedder-module> ...]"); process.exit(2); }
const dataset = (await Bun.file(data).json()) as EvalDataset;
const embedders: Embedder[] = [];
for (const m of mods) {
  const d = (await import(resolve(m))).default;
  embedders.push(typeof d === "function" ? await d() : d);
}
if (!embedders.length) embedders.push(new HashEmbedder());
for (const e of embedders) console.log(formatReport(await evaluateEmbedder(e, dataset)) + "\n");
