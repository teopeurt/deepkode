// Text normalisation, tokenising and injection screening. Pure functions.

// Zero-width, bidi controls, BOM, soft hyphen, variation selectors, tag characters.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{E0000}-\u{E01EF}]/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// Common Cyrillic/Greek confusables mapped to Latin. Used for screening only.
const CONFUSABLE: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h", "к": "k", "м": "m", "н": "h", "т": "t", "в": "b",
  "α": "a", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "τ": "t", "υ": "u", "χ": "x", "ε": "e",
};

/** Strip invisibles and control chars, NFKC-normalise. Safe for storage and display. */
export function sanitize(s: string): string {
  return s.normalize("NFKC").replace(INVISIBLE, "").replace(CONTROL, "").replace(/[ \t]+/g, " ").trim();
}

/** Aggressive form for screening: sanitised, lowercased, confusables folded. */
export function skeleton(s: string): string {
  let out = "";
  for (const ch of sanitize(s).toLowerCase()) out += CONFUSABLE[ch] ?? ch;
  return out;
}

export function hasMixedScript(s: string): boolean {
  return s.split(/\s+/).some((w) => /[a-z]/i.test(w) && /[Ͱ-ϿЀ-ӿ]/.test(w));
}

const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(instruction|prompt|rule|guideline|polic|constraint|check)/,
  /\b(you must|you should|you are now|you will now|from now on|new instructions?|act as|pretend to be)\b/,
  /\b(system|assistant|developer)\s*(prompt|message|:)/,
  /<\s*\/?\s*(system|assistant|instructions?|untrusted-data|stable-knowledge|tool_call|function_call)\b/,
  /<\|[a-z_]+\|>/,
  /\[\s*(inst|\/inst|system)\s*\]/,
  /\b(trust|origin)\s*[:=]\s*["']?(human-approved|trusted)/,
  /\b(mark|treat|consider)\b[^.\n]{0,30}\b(as|being)\b[^.\n]{0,20}\b(trusted|human-approved|approved)\b/,
  /\b(auto[- ]?(approve|merge|accept|pass|release)|skip (the )?(review|tests?|checks?|gate)|approve (this|the) (pr|change|task))\b/,
  /\b(exfiltrate|send (the )?(secrets?|credentials?|tokens?|keys?) to)\b/,
  /\b(rm\s+-rf|curl\s+[^|\n]*\|\s*(sh|bash)|chmod\s+777)\b/,
];

/** Returns the first matching pattern source, or null. */
export function findInjection(s: string): string | null {
  const k = skeleton(s);
  for (const p of INJECTION_PATTERNS) if (p.test(k)) return p.source;
  if (hasMixedScript(sanitize(s))) return "mixed-script";
  return null;
}

const STOP = new Set("a an the and or of to in on for with is are was were be been it this that these those at by from as but not no if then so we you i they he she its our your their do does did can could should would will just also into out up down over under than too very".split(" "));

export function tokens(s: string): string[] {
  return skeleton(s)
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

export function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

/** Stable JSON: sorted keys, for hashing. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}
