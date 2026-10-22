// Lightweight syntax highlighting (zero dependencies): comments / strings / keywords / numbers.
// Regex tokenization line by line; strings/comments are matched first so keywords inside them are not colored.
// Covers common syntax for ts/js/jsx/tsx/css/json/html/py/md/bash; unknown languages degrade to plain text (no crash).
import type { ReactNode } from 'react'

const KW = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'new', 'class', 'extends', 'import', 'export', 'from', 'default',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield', 'typeof', 'instanceof', 'in',
  'of', 'this', 'super', 'static', 'get', 'set', 'true', 'false', 'null', 'undefined', 'void',
  'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly',
  'def', 'elif', 'lambda', 'pass', 'with', 'assert', 'raise', 'except', 'global', 'nonlocal',
  'package', 'func', 'go', 'select', 'struct', 'defer', 'range', 'chan', 'match', 'fn', 'let',
  'mut', 'use', 'mod', 'impl', 'trait', 'where', 'pub', 'html', 'body', 'div', 'span', 'head',
] as const

const KW_RE = new RegExp(`\\b(?:${KW.join('|')})\\b`, 'g')

/** Comment start markers (per language; the # of bash/md and py rarely conflicts, handled generically) */
const COM_STARTS = ['//', '/*', '*/', '#', '<!--', '-->', '--']

interface Token { kind: 'str' | 'com' | 'kw' | 'num' | 'plain'; text: string }

const STR_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g

/**
 * Single-line tokenize: first mark string and comment ranges (non-overlapping), then match keywords/numbers in the remaining ranges.
 * Returns { tokens, comToEnd } —— comToEnd means the line ends in an inline comment (everything after it is comment).
 */
function tokenizeLine(line: string): { tokens: Token[]; comToEnd: boolean } {
  const tokens: Token[] = []
  const zones: Array<{ start: number; end: number; kind: 'str' | 'com' }> = []
  let comToEnd = false

  // ① Strings (including inline templates)
  STR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STR_RE.exec(line))) {
    zones.push({ start: m.index, end: m.index + m[0].length, kind: 'str' })
  }
  // ② Inline comments (find the earliest comment start marker)
  let comStart = -1
  for (const c of COM_STARTS) {
    const i = line.indexOf(c)
    if (i >= 0 && (comStart === -1 || i < comStart)) comStart = i
  }
  if (comStart >= 0) {
    // Ignore a comment start that falls inside a string (e.g. "//" appearing in a string)
    const inStr = zones.some((z) => z.kind === 'str' && comStart >= z.start && comStart < z.end)
    if (!inStr) {
      zones.push({ start: comStart, end: line.length, kind: 'com' })
      comToEnd = true
    }
  }
  zones.sort((a, b) => a.start - b.start)

  // ③ Match keywords/numbers outside the zones
  let pos = 0
  const push = (s: string, kind: Token['kind']) => { if (s) tokens.push({ text: s, kind }) }
  for (const z of zones) {
    push(line.slice(pos, z.start), 'plain')
    push(line.slice(z.start, z.end), z.kind)
    pos = z.end
  }
  push(line.slice(pos), 'plain')

  // ④ Keywords/numbers only match within plain segments
  const out: Token[] = []
  for (const t of tokens) {
    if (t.kind !== 'plain') { out.push(t); continue }
    KW_RE.lastIndex = 0
    const NUM_RE = /\b\d+(?:\.\d+)?\b/g
    // Merge matches: keyword or number, in positional order
    let k: RegExpExecArray | null
    let n: RegExpExecArray | null
    let cursor = 0
    const parts: Array<{ start: number; end: number; kind: 'kw' | 'num' }> = []
    for (;;) {
      k = KW_RE.exec(t.text)
      n = NUM_RE.exec(t.text)
      const nextK = k ? { start: k.index, end: k.index + k[0].length, kind: 'kw' as const } : null
      const nextN = n ? { start: n.index, end: n.index + n[0].length, kind: 'num' as const } : null
      // Find the nearest next one
      const cands: Array<{ start: number; end: number; kind: 'kw' | 'num' }> = []
      if (nextK) cands.push(nextK)
      if (nextN) cands.push(nextN)
      if (cands.length === 0) break
      cands.sort((a, b) => a.start - b.start)
      const c = cands[0]
      // Reset the other regex to just after this position, to avoid missing matches
      if (c === nextK && n) NUM_RE.lastIndex = c.end
      if (c === nextN && k) KW_RE.lastIndex = c.end
      if (c.start < cursor) { // already consumed region, skip further ahead
        if (c === nextK) KW_RE.lastIndex = Math.max(KW_RE.lastIndex, c.end)
        else NUM_RE.lastIndex = Math.max(NUM_RE.lastIndex, c.end)
        continue
      }
      parts.push(c)
      cursor = c.end
      if (c === nextK) NUM_RE.lastIndex = Math.max(NUM_RE.lastIndex, c.end)
      else KW_RE.lastIndex = Math.max(KW_RE.lastIndex, c.end)
    }
    let p = 0
    for (const pt of parts) {
      if (pt.start > p) out.push({ text: t.text.slice(p, pt.start), kind: 'plain' })
      out.push({ text: t.text.slice(pt.start, pt.end), kind: pt.kind })
      p = pt.end
    }
    if (p < t.text.length) out.push({ text: t.text.slice(p), kind: 'plain' })
  }
  return { tokens: out, comToEnd }
}

const KIND_CLS: Record<Token['kind'], string> = {
  str: 'hl-str', com: 'hl-com', kw: 'hl-kw', num: 'hl-num', plain: '',
}

/** Code → highlighted fragments (per line; a trailing comment grays out the rest of the line) */
export function highlightLine(line: string): ReactNode {
  const { tokens, comToEnd } = tokenizeLine(line)
  const nodes: ReactNode[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const cls = comToEnd && i >= tokens.findIndex((x) => x.kind === 'com') ? 'hl-com' : KIND_CLS[t.kind]
    if (!cls) nodes.push(t.text)
    else nodes.push(<span key={i} className={cls}>{t.text}</span>)
  }
  return nodes.length ? nodes : null
}
