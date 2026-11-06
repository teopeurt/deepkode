// Normalisation shared by the adapter (content hash) and dedupe (shingles). Pure.
import { createHash } from "node:crypto";
import { sanitize } from "../memory/text";

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Strips any number of Re:/Fwd:/Fw:/AW:/WG: prefixes (and [tag] list prefixes), lowercases, collapses whitespace. */
export function normalizeSubject(s: string): string {
  let cur = sanitize(s).toLowerCase();
  for (let i = 0; i < 20; i++) {
    const next = cur.replace(/^\s*(re|fwd?|aw|wg|sv|vs)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === cur) break;
    cur = next;
  }
  return cur.replace(/\s+/g, " ").trim();
}

/** Lowercase, NFKC, invisibles removed, punctuation folded to spaces, whitespace collapsed. */
export function normalizeText(s: string): string {
  return sanitize(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export const contentHash = (subject: string, body: string): string => sha256(normalizeSubject(subject) + "\n" + normalizeText(body));

/** Word shingles over the normalised text. A text shorter than `k` words yields one shingle (the whole text). */
export function shingles(text: string, k = 3): Set<string> {
  const w = normalizeText(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (w.length === 0) return out;
  if (w.length <= k) { out.add(w.join(" ")); return out; }
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

export function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
