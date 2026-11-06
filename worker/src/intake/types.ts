// Intake: the normalised Input record (Spec C §2a, §9) and the channel adapter seam.
// Pure types. No I/O. Adapters parse already-fetched raw events; they never fetch, open or execute anything.

export type Channel = "email" | "slack";
export type Origin = "trusted" | "untrusted";

export interface Sender { address: string; displayName: string }

/** Metadata only. Attachment bytes are never opened, decoded into text or passed downstream. */
export interface AttachmentMeta {
  filename: string;            // sanitised: NFKC, invisibles and control characters removed, length capped
  contentType: string;
  size: number;                // decoded size in bytes
  sha256: string;
  embeddedMessage?: boolean;   // message/rfc822: kept as an opaque attachment, never parsed as a mail
}

export type SignalCode =
  | "injection_phrase" | "hidden_html" | "invisible_chars" | "bidi_controls" | "link_mismatch"
  | "attachment_name_suspicious" | "embedded_message" | "quoted_injection" | "encoded_instruction"
  | "malformed" | "multiple_from" | "reply_to_mismatch" | "alternative_html_injection"
  | "truncated" | "empty_after_strip" | "forwarded_content";
/** Advisory flags. They never lower scrutiny: absence of a signal does not make an input safe. */
export interface Signal { code: SignalCode; where: string; detail?: string }

export interface Occurrence {
  inputId: string;
  messageId: string | null;
  sender: Sender;
  receivedAt: string;
  rawHash: string;
  kind: "original" | "exact" | "near";
  similarity: number;          // 1 for original/exact
}

export interface Input {
  id: string;                   // hash of channel, origin, sender and message id (or raw hash)
  channel: Channel;
  origin: Origin;               // fail closed: "trusted" only through the explicit TrustPolicy
  originReason: string;
  /** D4: true for every untrusted input, and also for any input carrying an injection signal. */
  requiresHuman: boolean;
  receivedAt: string;           // ISO 8601
  sender: Sender;
  subject: string;
  body: string;                 // plain text, sanitised, quoted replies and signature removed. DATA, never instructions.
  attachments: AttachmentMeta[];
  rawHash: string;              // sha256 of the raw bytes as received
  contentHash: string;          // sha256 of normalised subject and body (dedupe key)
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadId: string;
  signals: Signal[];
  occurrences: Occurrence[];    // always at least the original
}

export interface AdapterContext {
  /** When the system received the event. Falls back to the Date header, then to "now". */
  receivedAt?: string;
}

/** A channel adapter turns one already-fetched raw event into an Input. Offline and side-effect free. */
export interface ChannelAdapter<Raw> {
  readonly channel: Channel;
  parse(raw: Raw, ctx?: AdapterContext): Input;
}
