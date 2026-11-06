// Minimal RFC 822 / MIME reader. Offline, bounded, never throws on hostile input beyond limits it reports.
// Internally raw mail is a "byte string" (one char per byte, latin1) so base64 and 8-bit survive intact.

export const LIMITS = { maxBytes: 5 * 1024 * 1024, maxDepth: 6, maxParts: 100, maxHeaderLines: 500 } as const;

export interface Header { name: string; value: string }   // name lowercased, value unfolded and RFC 2047 decoded
export interface Entity { headers: Header[]; body: string }
export interface ContentType { type: string; params: Record<string, string> }

export const toByteString = (s: string | Uint8Array): string =>
  typeof s === "string" ? Buffer.from(s, "utf8").toString("latin1") : Buffer.from(s).toString("latin1");
export const byteStringBytes = (s: string): Buffer => Buffer.from(s, "latin1");

function charsetDecode(bytes: Uint8Array, charset: string | undefined): string {
  const cs = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  const name = cs === "us-ascii" || cs === "ascii" ? "utf-8" : cs;
  try { return new TextDecoder(name).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

/** RFC 2047 encoded words. Adjacent encoded words join without the whitespace between them. */
export function decodeEncodedWords(v: string): string {
  const joined = v.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?)/g, "$1");
  return joined.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
    const charset = cs.split("*")[0];
    try {
      const bytes = enc.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : decodeQpBytes(text.replace(/_/g, " "), true);
      return charsetDecode(bytes, charset);
    } catch { return ""; }
  });
}

function decodeQpBytes(s: string, header = false): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d /* = */ && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else if (c === 0x3d && !header && (s[i + 1] === "\n" || s[i + 1] === undefined)) { i += 1; }      // soft line break
    else if (c === 0x3d && !header && s[i + 1] === "\r" && s[i + 2] === "\n") { i += 2; }
    else out.push(c & 0xff);
  }
  return Buffer.from(out);
}

const normalizeNewlines = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const latin1ToUtf8IfNonAscii = (s: string) => (/[^\x00-\x7f]/.test(s) ? Buffer.from(s, "latin1").toString("utf8") : s);

export function parseEntity(raw: string): Entity {
  const text = normalizeNewlines(raw);
  const sep = text.indexOf("\n\n");
  const head = sep < 0 ? text : text.slice(0, sep);
  const body = sep < 0 ? "" : text.slice(sep + 2);
  const lines = head.split("\n").slice(0, LIMITS.maxHeaderLines);
  const headers: Header[] = [];
  let cur: string | null = null;
  const flush = () => {
    if (cur === null) return;
    const i = cur.indexOf(":");
    if (i > 0 && !/\s/.test(cur.slice(0, i))) headers.push({ name: cur.slice(0, i).toLowerCase(), value: decodeEncodedWords(latin1ToUtf8IfNonAscii(cur.slice(i + 1).trim())) });
    cur = null;
  };
  for (const l of lines) {
    if (/^[ \t]/.test(l) && cur !== null) cur += " " + l.trim();
    else { flush(); cur = l; }
  }
  flush();
  return { headers, body };
}

export const header = (h: Header[], name: string): string | undefined => h.find((x) => x.name === name)?.value;
export const headerAll = (h: Header[], name: string): string[] => h.filter((x) => x.name === name).map((x) => x.value);

/** Parses `type/subtype; k=v; k*=utf-8''pct; k*0=...` including quoted values and RFC 2231 continuations. */
export function parseContentType(v: string | undefined, dflt = "text/plain"): ContentType {
  const parts: string[] = [];
  let cur = "", q = false;
  for (const ch of v ?? dflt) {
    if (ch === '"') q = !q;
    if (ch === ";" && !q) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  const type = (parts.shift() ?? dflt).trim().toLowerCase() || dflt;
  const raw: Record<string, string> = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    raw[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"([\s\S]*)"$/, "$1");
  }
  const params: Record<string, string> = {};
  const bases = new Set(Object.keys(raw).map((k) => k.replace(/\*\d*\*?$/, "")));
  for (const base of bases) {
    if (raw[base] !== undefined) params[base] = decodeEncodedWords(raw[base]);
    const ext = raw[base + "*"];
    const cont = Object.keys(raw).filter((k) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\d+\\*?$`).test(k)).sort((a, b) => parseInt(a.replace(/\D+/g, "")) - parseInt(b.replace(/\D+/g, "")));
    const value = ext ?? (cont.length ? cont.map((k) => raw[k]).join("") : undefined);
    if (value !== undefined) {
      const m = /^([^']*)'[^']*'([\s\S]*)$/.exec(value);
      try { params[base] = m ? charsetDecode(decodeQpBytes(m[2].replace(/%/g, "="), true), m[1] || "utf-8") : value; }
      catch { params[base] = value; }
    }
  }
  return { type, params };
}

/** Decodes a part body to bytes per Content-Transfer-Encoding. Unknown encodings are treated as opaque 8-bit. */
export function decodeTransfer(body: string, cte: string | undefined): Buffer {
  const enc = (cte ?? "7bit").trim().toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") return decodeQpBytes(body);
  return Buffer.from(body, "latin1");
}

/** Splits a multipart body. Returns at most `max` raw parts; the preamble and epilogue are discarded. */
export function splitMultipart(body: string, boundary: string, max: number): { parts: string[]; truncated: boolean } {
  const parts: string[] = [];
  let cur: string[] | null = null;
  let truncated = false;
  const push = () => { if (cur) { if (parts.length < max) parts.push(cur.join("\n")); else truncated = true; } };
  for (const line of body.split("\n")) {
    const t = line.trimEnd();
    if (t === `--${boundary}`) { push(); cur = []; }
    else if (t === `--${boundary}--`) { push(); cur = null; break; }
    else if (cur) cur.push(line);
  }
  push(); // missing closing boundary: keep what was read
  return { parts, truncated };
}

export { charsetDecode };
