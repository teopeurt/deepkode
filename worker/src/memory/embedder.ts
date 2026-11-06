import type { Embedder } from "./types";
import { tokens } from "./text";

/**
 * Deterministic offline test double: hashed bag of word tokens plus character
 * trigrams, L2-normalised. Lexical, so it behaves like a weak embedder. It
 * exists so tests and the U10 harness run without a model or network.
 */
export class HashEmbedder implements Embedder {
  readonly id: string;
  constructor(private dims = 256) { this.id = `hash-${dims}-v1`; }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    for (const tok of tokens(text)) {
      v[fnv(tok) % this.dims]! += 1;
      const p = `^${tok}$`;
      for (let i = 0; i + 3 <= p.length; i++) v[fnv("g" + p.slice(i, i + 3)) % this.dims]! += 0.3;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return n ? v.map((x) => x / n) : v;
  }
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
