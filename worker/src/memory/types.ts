// Memory service types (Spec C §9b). Offline, no network, no model calls.

export type Trust = "human-approved" | "agent-generated" | "unverified";
export type Origin = "trusted" | "untrusted";

export interface Note {
  id: string;
  projectId: string;
  repoScope?: string;
  title: string;
  content: string[];
  tags: string[];
  keywords: string[];
  summary: string;
  antiPatterns: string[];
  applicability: string;
  links: string[];
  source: { kind: string; ref: string };
  /** Provenance: which task (and repo) produced this note. Merged notes accumulate entries. */
  provenance: { taskId: string; repo?: string }[];
  /** Valid time: when the fact holds in the world. validUntil null = still valid. */
  validFrom: string;
  validUntil: string | null;
  /** Record time: when the system learned it, and when it learned it was invalidated. */
  recordedAt: string;
  invalidatedAt: string | null;
  invalidatedBy: string | null;
  version: number;
  trust: Trust;
  origin: Origin;
  pinned: boolean;
  /** Human who approved the note, if any. */
  approvedBy: string | null;
  /** Ids of valid notes that state a contradicting fact; blocks stable prefix and gates. */
  conflictsWith: string[];
  /** How many captures were merged into this note (repeat count). */
  occurrences: number;
  createdAt: string;
  updatedAt: string;
  /** Embedding of the note text, with the embedder that produced it. */
  embedding: number[] | null;
  embedderId: string | null;
}

/** What a distiller proposes. It cannot set trust, origin, pinning, validity or conflicts. */
export interface CandidateNote {
  title: string;
  content: string[];
  tags?: string[];
  keywords?: string[];
  summary?: string;
  antiPatterns?: string[];
  applicability?: string;
  links?: string[];
  repoScope?: string;
}

export interface CaptureInput {
  taskId: string;
  projectId: string;
  repo?: string;
  /** Set by the system from the task record: did the task begin from an untrusted input? */
  taskOrigin: Origin;
  /** Capture is only legal after the review stage approved. */
  review: { approved: boolean };
  candidates: CandidateNote[];
  /** Source channel, recorded in `source`. */
  source?: { kind: string; ref: string };
}

export type RejectReason =
  | "review_not_approved"
  | "not_specific"
  | "oversize"
  | "injection"
  | "flood_limit"
  | "empty";

export type CaptureResult =
  | { action: "inserted"; noteId: string }
  | { action: "merged"; noteId: string }
  | { action: "duplicate"; noteId: string }
  | { action: "rejected"; reason: RejectReason; detail: string };

export interface HumanActor {
  kind: "human";
  id: string;
}

export type Channel = "keyword" | "semantic";

export interface Hit {
  noteId: string;
  version: number;
  title: string;
  content: string[];
  summary: string;
  antiPatterns: string[];
  applicability: string;
  score: number;
  channelScores: Record<Channel, number>;
  trust: Trust;
  origin: Origin;
  pinned: boolean;
  conflict: boolean;
  /** stablePrefix: in the stable prefix. autoGate: may feed an auto-gate. Otherwise labelled data only. */
  eligibility: { stablePrefix: boolean; autoGate: boolean };
  label: string;
}

export type Stage = "triage" | "plan" | "execute" | "other";

export interface RetrieveOptions {
  repoScope?: string;
  limit?: number;
  stage?: Stage;
  /** Valid-time point. Default: now. */
  asOf?: string;
  /** Record-time point (what did we know then). Default: now. */
  knownAt?: string;
  minScore?: number;
}

export interface Snapshot {
  id: string;
  projectId: string;
  query: string;
  stage: Stage;
  repoScope?: string;
  stablePrefix: string;
  stableNoteIds: string[];
  hits: Hit[];
  createdAt: string;
}

export interface Retrieval {
  snapshotId: string;
  hits: Hit[];
}

export interface Assembly extends Retrieval {
  /** Identical across tasks while pinned notes are unchanged: KV-cache friendly. */
  stablePrefix: string;
  stableNoteIds: string[];
  /** Hits rendered as clearly labelled data, never instructions. */
  dataBlock: string;
  /** The only hits an auto-gate may consume. */
  gateEligible: Hit[];
}

export interface Memory {
  capture(input: CaptureInput): Promise<CaptureResult[]>;
  retrieve(projectId: string, query: string, opts?: RetrieveOptions): Promise<Retrieval>;
  assemble(projectId: string, taskText: string, opts?: RetrieveOptions): Promise<Assembly>;
  getSnapshot(id: string): Snapshot | null;
  invalidate(noteId: string, by: HumanActor, reason?: string): void;
  approve(noteId: string, by: HumanActor, opts?: { acceptUntrustedOrigin?: boolean }): void;
  pin(noteId: string, by: HumanActor): void;
  unpin(noteId: string, by: HumanActor): void;
  list(projectId: string, opts?: { includeInvalid?: boolean }): Note[];
}

export interface Embedder {
  /** Identifies model + version; vectors from different ids are never mixed. */
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}
