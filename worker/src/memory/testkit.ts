// Test helpers: deterministic clock and ids, canned candidates.
import { InProcessMemory, type MemoryOptions } from "./service";
import type { CandidateNote, CaptureInput, HumanActor, Origin } from "./types";

export const human: HumanActor = { kind: "human", id: "alice" };

export function mkMemory(o: MemoryOptions = {}): InProcessMemory {
  let t = Date.UTC(2026, 0, 1);
  let n = 0;
  return new InProcessMemory({
    now: () => new Date((t += 1000)),
    newId: () => "n" + String(++n).padStart(4, "0"),
    ...o,
  });
}

export const esmNote: CandidateNote = {
  title: "Jest fails with ERR_REQUIRE_ESM importing node-fetch in packages/api/src/db.ts",
  content: [
    "Importing `node-fetch` v3 from packages/api/src/db.ts throws ERR_REQUIRE_ESM under jest 29.",
    "Pin node-fetch to 2.7.0 or load it with a dynamic import().",
  ],
  applicability: "Any package using jest with the CommonJS transform and an ESM-only dependency",
  antiPatterns: ["Do not set transformIgnorePatterns to an empty list globally"],
  tags: ["jest", "esm"],
};

export const cap = (
  projectId: string, taskId: string, taskOrigin: Origin, candidates: CandidateNote[], extra: Partial<CaptureInput> = {},
): CaptureInput => ({ projectId, taskId, taskOrigin, review: { approved: true }, candidates, ...extra });
