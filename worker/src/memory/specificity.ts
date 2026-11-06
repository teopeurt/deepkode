import type { CandidateNote } from "./types";
import { sanitize } from "./text";

export const LIMITS = {
  title: 200,
  contentTotal: 4000,
  contentLines: 30,
  listItems: 20,
  itemChars: 300,
  untrustedPerProject: 100,
  /** Max notes of one origin class sharing a near-identical title. */
  sameTitleGroup: 5,
};

const GENERIC = [
  /\bimprov(e|ed|es|ing)\b.{0,20}\b(code|quality|performance|readability)\b/,
  /\b(fixed|fixes|fix)\b.{0,12}\b(a |the )?(bug|bugs|issue|issues|problem|problems)\b/,
  /\b(refactor(ed|ing)?|cleaned up|clean up|tidied)\b/,
  /\bupdated?\b.{0,15}\b(tests?|docs?|documentation|code|dependencies)\b/,
  /\b(various|several|some|misc(ellaneous)?)\b.{0,15}\b(changes|fixes|improvements|updates)\b/,
  /\bbest practices?\b/,
  /\bmade (it|things) (better|work)\b/,
  /\bwork(s|ed)? as expected\b/,
  /\bgeneral (cleanup|improvements?)\b/,
];

// Concrete anchors: path, backticked code, camel/snake/CONSTANT identifiers, error codes, versions, flags.
const ANCHORS: RegExp[] = [
  /(?:[\w.-]+\/)+[\w.-]+\.\w{1,6}/,
  /`[^`\n]{2,}`/,
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/,
  /\b[a-z0-9]+_[a-z0-9_]+\b/,
  /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/,
  /\b[A-Z]{2,}-?\d{2,}\b/,
  /\bv?\d+\.\d+(\.\d+)?\b/,
  /--[a-z][a-z-]+/,
  /\b(error|exception|errno|status)\s*:?\s*[\w.]*\d+/i,
  /\b\w+Error\b/,
];

export interface SpecificityVerdict { ok: boolean; score: number; reasons: string[] }

/** The specificity bar: a note must name something concrete and say when it applies. */
export function specificity(c: CandidateNote): SpecificityVerdict {
  const reasons: string[] = [];
  const body = c.content.map(sanitize).join("\n");
  const all = [sanitize(c.title), body, sanitize(c.applicability ?? ""), ...(c.antiPatterns ?? []).map(sanitize)].join("\n");
  const lower = all.toLowerCase();
  let score = 0;

  const anchors = ANCHORS.filter((p) => p.test(all)).length;
  if (anchors === 0) reasons.push("no concrete anchor (file path, identifier, error, version, command)");
  else score += Math.min(anchors, 3);

  if (body.length >= 60) score += 1; else reasons.push("content under 60 characters");
  if ((c.applicability ?? "").trim().length >= 15) score += 1;
  if ((c.antiPatterns ?? []).some((a) => a.trim().length >= 10)) score += 1;

  const generic = GENERIC.filter((p) => p.test(lower)).length;
  if (generic) { score -= generic * 2; reasons.push(`generic phrasing (${generic})`); }

  // Content that merely repeats the title adds nothing.
  if (sanitize(c.title).toLowerCase() === body.toLowerCase().trim()) { score -= 2; reasons.push("content repeats the title"); }

  const ok = anchors > 0 && score >= 3;
  if (!ok && reasons.length === 0) reasons.push("score below bar");
  return { ok, score, reasons };
}
