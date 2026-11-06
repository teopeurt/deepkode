// Test fixtures: build RFC 822 text. Offline; nothing here reads a mailbox.
export interface MailOpts {
  from?: string; to?: string; subject?: string; messageId?: string; inReplyTo?: string; references?: string;
  headers?: Record<string, string>; date?: string;
}

export function head(o: MailOpts = {}): string {
  const h: string[] = [
    `From: ${o.from ?? "Customer <cust@example.org>"}`,
    `To: ${o.to ?? "intake@acme.test"}`,
    `Subject: ${o.subject ?? "Bug report"}`,
    `Date: ${o.date ?? "Tue, 03 Nov 2026 10:00:00 +0000"}`,
  ];
  if (o.messageId !== undefined) h.push(`Message-ID: ${o.messageId}`);
  if (o.inReplyTo) h.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references) h.push(`References: ${o.references}`);
  for (const [k, v] of Object.entries(o.headers ?? {})) h.push(`${k}: ${v}`);
  return h.join("\r\n");
}

export const plain = (body: string, o: MailOpts = {}) => `${head(o)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
export const html = (body: string, o: MailOpts = {}) => `${head(o)}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}\r\n`;

export function multipart(kind: "mixed" | "alternative", parts: string[], o: MailOpts = {}, boundary = "BND"): string {
  return `${head(o)}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/${kind}; boundary="${boundary}"\r\n\r\n` +
    parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("") + `--${boundary}--\r\n`;
}
export const partText = (type: string, body: string, extra = "") => `Content-Type: ${type}; charset=utf-8\r\n${extra}\r\n${body}`;
export const partAttachment = (name: string, ctype: string, b64: string, extraName = name) =>
  `Content-Type: ${ctype}; name="${extraName}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}`;

export const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
export const encWordB = (s: string, cs = "utf-8") => `=?${cs}?B?${b64(s)}?=`;

/** The allowlisted + authenticated sender used for trusted-path tests. */
export const TRUST = { allowlist: ["boss@acme.test", "@trusted.test"], trustedAuthservIds: ["mx.acme.test"] } as const;
export const authPass = (domain = "acme.test") => ({ "Authentication-Results": `mx.acme.test; dmarc=pass header.from=${domain}; dkim=pass; spf=pass` });
