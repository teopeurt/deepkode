// Safe HTML to text. A small tokenizer: no DOM, no fetching, nothing is executed or resolved.
// Content that a reader would not see (hidden elements, scripts, styles, comments) is dropped and reported.

export interface HtmlText { text: string; hiddenFound: boolean; hiddenText: string; links: { text: string; href: string }[] }

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "(c)", hellip: "...", ndash: "-", mdash: "-", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
const DROP = new Set(["script", "style", "head", "template", "noscript", "title", "object", "iframe", "svg", "math", "textarea"]);
const BLOCK = new Set(["p", "div", "br", "hr", "li", "ul", "ol", "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "section", "article", "header", "footer"]);
const HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|%)?\s*(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|max-height\s*:\s*0|color\s*:\s*(?:#fff(?:fff)?|white)\b|text-indent\s*:\s*-\d{3,}|position\s*:\s*absolute[^"]*(?:left|top)\s*:\s*-\d{3,})/i;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

export function htmlToText(html: string): HtmlText {
  let hiddenFound = false, hiddenText = "";
  const src = html.replace(/<!--([\s\S]*?)(-->|$)/g, (_c, inner: string) => { hiddenText += inner + " "; hiddenFound = true; return " "; });
  const out: string[] = [];
  const links: { text: string; href: string }[] = [];
  const stack: { name: string; hidden: boolean; href?: string; linkStart: number }[] = [];
  const hiddenNow = () => stack.some((e) => e.hidden);
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|<[^>]*$/g;
  let last = 0, m: RegExpExecArray | null;
  const emitText = (t: string) => {
    const d = decodeEntities(t);
    if (!d) return;
    if (hiddenNow()) { hiddenFound = true; hiddenText += d + " "; } else out.push(d);
  };
  while ((m = re.exec(src))) {
    emitText(src.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] === undefined) continue; // unterminated tag at the end: dropped
    const closing = m[1] === "/", name = m[2].toLowerCase(), attrs = m[3] ?? "";
    if (!closing) {
      const style = attr(attrs, "style") ?? "";
      const hidden = DROP.has(name) || /(^|\s)hidden(\s|=|$)/i.test(attrs) || HIDDEN_STYLE.test(style) || attr(attrs, "aria-hidden") === "true" || attr(attrs, "type")?.toLowerCase() === "hidden";
      if (BLOCK.has(name) && !hiddenNow()) out.push("\n");
      if (VOID.has(name) || /\/\s*$/.test(attrs)) { if (hidden && !DROP.has(name)) hiddenFound = true; continue; }
      stack.push({ name, hidden, href: name === "a" ? attr(attrs, "href") ?? undefined : undefined, linkStart: out.length });
    } else {
      const i = stack.map((e) => e.name).lastIndexOf(name);
      if (i < 0) continue;
      const closed = stack.splice(i);
      const top = closed[0];
      if (top.name === "a" && top.href && !closed.some((e) => e.hidden) && !hiddenNow()) {
        const text = out.slice(top.linkStart).join("").replace(/\s+/g, " ").trim();
        links.push({ text, href: top.href });
        if (text !== top.href) out.push(` (link: ${top.href})`);
      }
      if (BLOCK.has(name) && !hiddenNow()) out.push("\n");
    }
  }
  emitText(src.slice(last).replace(/<[^>]*$/, ""));
  const text = out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, hiddenFound, hiddenText: hiddenText.trim(), links };
}
