// Lightweight Markdown rendering (no dependencies) —— supports headings / bold / italics / inline code / code blocks / lists / tables / horizontal rules.
// Used for: showing markdown text such as plans and agent messages (no big library pulled in, to keep the build chain light).
// Code blocks go through CodeBlock (ported from Beautiful UI): a line-numbered listing; unified diffs can switch between Code/Diff.
import { useMemo, type ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';

/** Inline formatting: **bold**, *italic*, `code` */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else parts.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Parse one table row: | a | b | → ['a','b'] */
function splitTableRow(line: string): string[] {
  return line.split('|').slice(1, -1).map((s) => s.trim());
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    // Pure JSON output (no ``` fence, e.g. distill results / structured data returned by the agent):
    // if the whole text, trimmed, is valid JSON → render it directly as a code block (monospace + json syntax highlighting),
    // instead of showing it as a lump of plain text.
    const trimmedWhole = text.trim();
    const looksJson =
      (trimmedWhole.startsWith('{') && trimmedWhole.endsWith('}')) ||
      (trimmedWhole.startsWith('[') && trimmedWhole.endsWith(']'));
    if (trimmedWhole.length > 0 && looksJson) {
      try {
        JSON.parse(trimmedWhole);
        return [<CodeBlock key="json" code={trimmedWhole} info="json" />];
      } catch {
        // Not valid JSON, use normal markdown parsing
      }
    }
    const lines = text.split('\n');
    const out: ReactNode[] = [];
    let i = 0;
    let k = 0;
    while (i < lines.length) {
      const line = lines[i];
      // Code block
      if (line.trim().startsWith('```')) {
        const info = line.trim().slice(3);
        const buf: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
        i++; // skip the closing ```
        out.push(<CodeBlock key={k++} code={buf.join('\n')} info={info} />);
        continue;
      }
      // Heading
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        const level = h[1].length;
        const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
        out.push(<Tag key={k++} className="md-h">{inline(h[2])}</Tag>);
        i++;
        continue;
      }
      // Horizontal rule
      if (/^\s*[-*_]{3,}\s*$/.test(line)) {
        out.push(<hr key={k++} className="md-hr" />);
        i++;
        continue;
      }
      // Table (the current line contains | and the next line is a separator row)
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const header = splitTableRow(line);
        const body: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|')) { body.push(splitTableRow(lines[i])); i++; }
        out.push(
          <table key={k++} className="md-table">
            <thead><tr>{header.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>{row.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>,
        );
        continue;
      }
      // List (- / * / number.)
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]/.test(line);
        const items: ReactNode[] = [];
        const re = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/;
        while (i < lines.length && re.test(lines[i])) {
          items.push(<li key={i}>{inline(re.exec(lines[i])![1])}</li>);
          i++;
        }
        out.push(ordered
          ? <ol key={k++} className="md-ol">{items}</ol>
          : <ul key={k++} className="md-ul">{items}</ul>);
        continue;
      }
      // Plain line
      if (line.trim()) {
        out.push(<p key={k++} className="md-p">{inline(line)}</p>);
      }
      i++;
    }
    return out;
  }, [text]);

  return <div className="md">{blocks}</div>;
}
