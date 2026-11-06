// Email channel adapter (first channel; the user did not choose, see WP-C report).
// Parses RFC 822 / MIME text that has already been fetched. No mailbox, no network, no credentials, and nothing is
// executed, opened, resolved or fetched. Everything inside a message is data.
import { findInjection, sanitize } from "../memory/text";
import { htmlToText } from "./html";
import {
  LIMITS, type Entity, type Header, byteStringBytes, charsetDecode, decodeTransfer, header, headerAll, parseContentType,
  parseEntity, splitMultipart, toByteString,
} from "./mime";
import { contentHash, normalizeSubject, sha256 } from "./normalize";
import type { AdapterContext, AttachmentMeta, ChannelAdapter, Input, Origin, Sender, Signal, SignalCode } from "./types";

/**
 * Email is untrusted unless BOTH hold: the sender is explicitly allowlisted, and the topmost Authentication-Results
 * header (added by our own receiving MTA, identified by `trustedAuthservIds`) says dmarc=pass for the sender's domain.
 * Allowlist entries are exact addresses ("a@b.com") or whole domains ("@b.com"). Empty policy = nothing is trusted.
 */
export interface TrustPolicy { allowlist: readonly string[]; trustedAuthservIds: readonly string[] }
export const NO_TRUST: TrustPolicy = { allowlist: [], trustedAuthservIds: [] };

export const MAX_BODY_CHARS = 20_000;
const MAX_SUBJECT_CHARS = 300;

const BIDI = /[‎‏‪-‮⁦-⁩]/;
const ZERO_WIDTH = /[­͏؜឴឵᠋-᠏​-‍⁠-⁤︀-️﻿\u{E0000}-\u{E01EF}]/u;

// ---- addresses -------------------------------------------------------------------------------------------------

function splitList(v: string): string[] {
  const out: string[] = [];
  let cur = "", q = false, angle = 0, paren = 0;
  for (const ch of v) {
    if (ch === '"' && !paren) q = !q;
    else if (!q && ch === "(") paren++;
    else if (!q && ch === ")" && paren) paren--;
    else if (!q && !paren && ch === "<") angle++;
    else if (!q && !paren && ch === ">" && angle) angle--;
    if (ch === "," && !q && !angle && !paren) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function parseMailboxes(v: string | undefined): Sender[] {
  if (!v) return [];
  const res: Sender[] = [];
  for (const item of splitList(v)) {
    const withoutComments = item.replace(/\([^)]*\)/g, " ");
    const ang = /<([^<>]*)>/.exec(withoutComments);
    const addr = (ang ? ang[1] : withoutComments).trim().replace(/^mailto:/i, "");
    if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(addr)) continue;
    const name = ang ? withoutComments.slice(0, ang.index).trim().replace(/^"([\s\S]*)"$/, "$1") : "";
    res.push({ address: addr.toLowerCase(), displayName: sanitize(name).slice(0, 120) });
  }
  return res;
}

// ---- trust -----------------------------------------------------------------------------------------------------

export function evaluateOrigin(sender: Sender | null, headers: Header[], policy: TrustPolicy): { origin: Origin; reason: string } {
  const untrusted = (reason: string) => ({ origin: "untrusted" as Origin, reason });
  if (!sender) return untrusted("no single unambiguous From address");
  const domain = sender.address.slice(sender.address.lastIndexOf("@")).toLowerCase();
  const listed = policy.allowlist.map((a) => a.toLowerCase()).some((a) => (a.startsWith("@") ? a === domain : a === sender.address));
  if (!listed) return untrusted("sender is not on the allowlist");
  const ar = header(headers, "authentication-results");
  if (!ar) return untrusted("no Authentication-Results header");
  const authserv = ar.split(";")[0].trim().split(/\s+/)[0].toLowerCase();
  if (!policy.trustedAuthservIds.map((s) => s.toLowerCase()).includes(authserv)) return untrusted(`Authentication-Results from untrusted authserv-id "${authserv}"`);
  const dmarc = [...ar.matchAll(/\bdmarc=([a-z]+)/gi)].map((m) => m[1].toLowerCase());
  if (dmarc.length === 0 || dmarc.some((r) => r !== "pass")) return untrusted(`dmarc result is not pass (${dmarc.join(",") || "absent"})`);
  const hf = /\bheader\.from=([^\s;]+)/i.exec(ar);
  if (hf && "@" + hf[1].toLowerCase() !== domain) return untrusted("authenticated domain differs from From domain");
  return { origin: "trusted", reason: `allowlisted sender with dmarc=pass from ${authserv}` };
}

// ---- reply / signature stripping -------------------------------------------------------------------------------

const ORIGINAL_MSG = /^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i;
const ON_WROTE = /^\s*(on|am|le|el)\s.{4,200}(wrote|schrieb|a écrit|escribió)\s*:\s*$/i;
const QUOTED = /^\s*>/;

/** Conservative: only well-known shapes are removed. Anything else stays in the body. */
export function stripReply(text: string): { text: string; quoted: string } {
  let lines = text.split("\n");
  const quoted: string[] = [];
  const cutTail = (i: number) => { quoted.push(...lines.slice(i)); lines = lines.slice(0, i); };

  const orig = lines.findIndex((l) => /^\s*-{2,}\s*original message\s*-{2,}\s*$/i.test(l));
  if (orig >= 0) cutTail(orig);
  else {
    const i = lines.findIndex((l, k) => /^\s*From:\s+\S/i.test(l) && lines.slice(k + 1, k + 6).filter((x) => /^\s*(Sent|Date|To|Subject|Cc):/i.test(x)).length >= 3 && (k === 0 || /^\s*(_{5,}|\s*)$/.test(lines[k - 1])));
    if (i >= 0) cutTail(i > 0 && /^\s*_{5,}\s*$/.test(lines[i - 1]) ? i - 1 : i);
  }

  for (let i = 0; i < lines.length; i++) {
    const two = i + 1 < lines.length && /^\s*(on|am|le|el)\s/i.test(lines[i]) && /(wrote|schrieb|a écrit|escribió)\s*:\s*$/i.test(lines[i + 1]);
    if (ON_WROTE.test(lines[i]) || two) {
      const hdrLen = ON_WROTE.test(lines[i]) ? 1 : 2;
      const rest = lines.slice(i + hdrLen);
      if (rest.every((l) => QUOTED.test(l) || l.trim() === "")) { cutTail(i); break; }
      quoted.push(...lines.splice(i, hdrLen)); i--;
    }
  }
  lines = lines.filter((l) => { if (QUOTED.test(l)) { quoted.push(l); return false; } return true; });

  const sig = lines.map((l, i) => [l, i] as const).filter(([l]) => l === "-- " || l === "--" || l === "-- \r").map(([, i]) => i);
  const lastSig = sig.length ? sig[sig.length - 1] : -1;
  if (lastSig > 0 && lines.length - lastSig <= 15) cutTail(lastSig);
  while (lines.length && /^\s*(sent from my .{2,40}|get outlook for .{2,20})\s*$/i.test(lines[lines.length - 1])) lines.pop();

  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), quoted: quoted.join("\n") };
}

// ---- body walk -------------------------------------------------------------------------------------------------

interface Piece { kind: "plain" | "html"; text: string }
interface State { signals: Signal[]; attachments: AttachmentMeta[]; parts: number; hiddenSeen: boolean }

const sig = (st: State, code: SignalCode, where: string, detail?: string) => {
  if (!st.signals.some((s) => s.code === code && s.where === where && s.detail === detail)) st.signals.push({ code, where, ...(detail ? { detail } : {}) });
};

function invisibleSignals(st: State, where: string, raw: string) {
  if (BIDI.test(raw)) sig(st, "bidi_controls", where);
  if (ZERO_WIDTH.test(raw)) sig(st, "invisible_chars", where);
  // Unicode "tag" characters smuggle ASCII invisibly. Decode them for screening only (the text itself is dropped).
  const tags = [...raw].filter((c) => { const cp = c.codePointAt(0)!; return cp >= 0xe0020 && cp <= 0xe007e; }).map((c) => String.fromCharCode(c.codePointAt(0)! - 0xe0000)).join("");
  if (tags && findInjection(tags)) sig(st, "injection_phrase", where, "directive hidden in unicode tag characters (dropped)");
}

export function cleanFilename(name: string): string {
  const base = sanitize(name).replace(/[\\/]/g, "_").replace(/\.{2,}/g, ".").replace(/\s+/g, " ").trim();
  return base.slice(0, 120);
}

function walk(e: Entity, depth: number, st: State): Piece[] {
  if (++st.parts > LIMITS.maxParts || depth > LIMITS.maxDepth) { sig(st, "malformed", "mime", "part or depth limit exceeded"); return []; }
  const ct = parseContentType(header(e.headers, "content-type"));
  const disp = parseContentType(header(e.headers, "content-disposition"), "inline");
  const rawName = disp.params.filename ?? ct.params.name;

  if (ct.type.startsWith("multipart/")) {
    const boundary = ct.params.boundary;
    if (!boundary) { sig(st, "malformed", "mime", "multipart without boundary"); return []; }
    const { parts, truncated } = splitMultipart(e.body, boundary, LIMITS.maxParts);
    if (truncated) sig(st, "malformed", "mime", "too many parts");
    const kids = parts.map((p) => walk(parseEntity(p), depth + 1, st));
    if (ct.type === "multipart/alternative") {
      const flat = kids.flat();
      const plain = flat.filter((p) => p.kind === "plain"), html = flat.filter((p) => p.kind === "html");
      if (plain.length && html.length) {
        const pt = plain.map((p) => p.text).join("\n"), ht = html.map((p) => p.text).join("\n");
        if (findInjection(ht) && !findInjection(pt)) sig(st, "alternative_html_injection", "body", "html alternative carries directives the plain alternative lacks");
      }
      return plain.length ? plain : html;
    }
    return kids.flat();
  }

  const isText = ct.type === "text/plain" || ct.type === "text/html";
  if (disp.type === "attachment" || rawName !== undefined || !isText) {
    const bytes = decodeTransfer(e.body, header(e.headers, "content-transfer-encoding"));
    const filename = cleanFilename(rawName ?? "(unnamed)");
    if (rawName !== undefined) {
      if (BIDI.test(rawName) || ZERO_WIDTH.test(rawName)) sig(st, "attachment_name_suspicious", "attachment", "invisible or bidi characters in filename");
      if (findInjection(rawName)) sig(st, "attachment_name_suspicious", "attachment", "directive-like filename");
      if (/\.(pdf|docx?|xlsx?|txt|png|jpe?g|zip)\s*\.(exe|bat|cmd|scr|js|sh|ps1|vbs|jar)$/i.test(filename) || /[\\/]|\.\.[\\/]/.test(rawName)) sig(st, "attachment_name_suspicious", "attachment", "double extension or path in filename");
    }
    const embedded = ct.type.startsWith("message/");
    if (embedded) sig(st, "embedded_message", "attachment", "message attachment kept opaque, never parsed");
    st.attachments.push({ filename, contentType: ct.type, size: bytes.length, sha256: sha256(bytes), ...(embedded ? { embeddedMessage: true } : {}) });
    return [];
  }

  const raw = charsetDecode(decodeTransfer(e.body, header(e.headers, "content-transfer-encoding")), ct.params.charset);
  invisibleSignals(st, "body", raw);
  if (ct.type === "text/html") {
    const h = htmlToText(raw);
    if (h.hiddenFound) {
      st.hiddenSeen = true;
      sig(st, "hidden_html", "body", findInjection(h.hiddenText) ? "hidden content contains directives (dropped)" : "hidden content dropped");
    }
    for (const l of h.links) {
      const shown = /^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/i.exec(l.text);
      const target = /^(?:https?:)?\/\/([^/:?#]+)/i.exec(l.href);
      if (shown && (!target || shown[1].toLowerCase() !== target[1].toLowerCase())) sig(st, "link_mismatch", "body", `text shows ${shown[1]}, href goes elsewhere`);
    }
    return [{ kind: "html", text: h.text }];
  }
  return [{ kind: "plain", text: raw.replace(/\r/g, "") }];
}

function scanBase64(text: string): string | null {
  for (const m of text.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
    const dec = Buffer.from(m[0], "base64").toString("utf8");
    if (dec.length >= 12 && !/[\u0000-\u0008\u000e-\u001f�]/.test(dec) && findInjection(dec)) return dec.slice(0, 60);
  }
  return null;
}

const refs = (v: string | undefined): string[] => (v ? [...v.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]) : []);

// ---- adapter ---------------------------------------------------------------------------------------------------

export class EmailAdapter implements ChannelAdapter<string | Uint8Array> {
  readonly channel = "email" as const;
  constructor(private readonly policy: TrustPolicy = NO_TRUST) {}

  parse(raw: string | Uint8Array, ctx: AdapterContext = {}): Input {
    const bs = toByteString(raw);
    const rawHash = sha256(byteStringBytes(bs));
    const st: State = { signals: [], attachments: [], parts: 0, hiddenSeen: false };

    let entity: Entity;
    if (bs.length > LIMITS.maxBytes) { sig(st, "malformed", "message", `larger than ${LIMITS.maxBytes} bytes; body not parsed`); entity = { headers: [], body: "" }; }
    else entity = parseEntity(bs);
    const H = entity.headers;

    // sender: exactly one From mailbox, otherwise untrusted and unattributed
    const fromRaw = headerAll(H, "from");
    const mailboxes = fromRaw.flatMap((v) => parseMailboxes(v));
    if (fromRaw.length > 1 || mailboxes.length > 1) sig(st, "multiple_from", "headers");
    const sender: Sender = mailboxes.length === 1 && fromRaw.length === 1 ? mailboxes[0] : { address: mailboxes[0]?.address ?? "", displayName: mailboxes[0]?.displayName ?? "" };
    const replyTo = parseMailboxes(header(H, "reply-to"));
    if (replyTo.length && replyTo.some((r) => r.address !== sender.address)) sig(st, "reply_to_mismatch", "headers");

    // headers: scan everything a person could be steered by
    const subjectRaw = header(H, "subject") ?? "";
    invisibleSignals(st, "subject", subjectRaw);
    invisibleSignals(st, "from", fromRaw.join(" "));
    if (findInjection(subjectRaw)) sig(st, "injection_phrase", "subject");
    if (findInjection(fromRaw.join(" "))) sig(st, "injection_phrase", "headers:from");
    for (const h of H) {
      if (/^(x-|comments$|keywords$|organization$|thread-topic$|reply-to$|references$|in-reply-to$)/.test(h.name) && findInjection(h.value)) sig(st, "injection_phrase", `headers:${h.name}`);
    }

    // body
    let pieces: Piece[] = [];
    if (bs.length <= LIMITS.maxBytes) pieces = walk(entity, 0, st);
    let text = sanitize(pieces.map((p) => p.text).join("\n\n"));
    if (text.length > MAX_BODY_CHARS) { text = text.slice(0, MAX_BODY_CHARS); sig(st, "truncated", "body"); }
    if (/(^|\n)\s*(-{5,}\s*forwarded message\s*-{5,}|begin forwarded message:)/i.test(text)) sig(st, "forwarded_content", "body", "forwarded text is data; it does not carry the forwarder's or original sender's trust");
    const stripped = stripReply(text);
    let body = stripped.text;
    if (body === "" && text !== "") sig(st, "empty_after_strip", "body");
    if (stripped.quoted && findInjection(stripped.quoted)) sig(st, "quoted_injection", "quoted", "directives in quoted reply text (removed from body)");
    if (findInjection(body)) sig(st, "injection_phrase", "body");
    const enc = scanBase64(text + "\n" + subjectRaw);
    if (enc) sig(st, "encoded_instruction", "body", enc);

    const subject = sanitize(subjectRaw).replace(/\s+/g, " ").slice(0, MAX_SUBJECT_CHARS);
    if (stripped.quoted === "" && body === "" && text === "" && pieces.length === 0 && st.attachments.length === 0 && !st.signals.some((s) => s.code === "malformed")) sig(st, "malformed", "message", "no readable body");

    // identity and threading
    const messageId = refs(header(H, "message-id"))[0] ?? null;
    const inReplyTo = refs(header(H, "in-reply-to"))[0] ?? null;
    const references = refs(header(H, "references"));
    const threadId = references[0] ?? inReplyTo ?? messageId ?? `raw:${rawHash.slice(0, 16)}`;

    const { origin, reason } = mailboxes.length === 1 && fromRaw.length === 1
      ? evaluateOrigin(sender, H, this.policy)
      : { origin: "untrusted" as Origin, reason: "no single unambiguous From address" };

    const advisory = new Set<SignalCode>(["truncated", "empty_after_strip", "forwarded_content", "embedded_message"]);
    const requiresHuman = origin !== "trusted" || st.signals.some((s) => !advisory.has(s.code));

    const dateHdr = header(H, "date");
    const parsedDate = dateHdr ? new Date(dateHdr) : null;
    const receivedAt = ctx.receivedAt ?? (parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : new Date().toISOString());

    const id = "inp_" + sha256(["email", origin, sender.address, messageId ?? rawHash].join("\u0000")).slice(0, 32);
    return {
      id, channel: "email", origin, originReason: reason, requiresHuman, receivedAt, sender, subject, body,
      attachments: st.attachments, rawHash, contentHash: contentHash(subject, body), messageId, inReplyTo, references, threadId,
      signals: st.signals,
      occurrences: [{ inputId: id, messageId, sender, receivedAt, rawHash, kind: "original", similarity: 1 }],
    };
  }
}

export { normalizeSubject };
