// FlowKit registry handlers for flows/triage.flow.yaml (Spec C 9a, v0.6). Plain functions with injected dependencies;
// binding them to FlowKit's Temporal registry types is part of S2's compatibility check, not done here.
import type { TriageInput as IntakeTriageInput } from "../intake/delivery";
import {
  classifyAction, classifyStage, dedupeAction, dedupeStage,
  type ClassifyOutcome, type DedupeOutcome, type TriageDeps,
} from "./decision";
import { fromIntake } from "./from-intake";
import type { ProjectRegistry } from "./registry";
import type { TriageInput } from "./types";
import { workspaceRequests, type TaskIdentity, type WorkspaceRequest } from "./workspace-requests";

export interface CreateTaskResult {
  project: string;
  workspaces: WorkspaceRequest[];
  /** D4: untrusted origin needs a human before `execute`; the task flow's guard enforces it from this metadata. */
  taskMetadata: { requiresHumanBeforeExecute: boolean; memorySnapshotId?: string };
}

export class TriageHandlerError extends Error {}

export function createTriageHandlers(deps: TriageDeps) {
  const registry: ProjectRegistry = deps.registry;
  return {
    /** system step `normalize_input` (stage `received`). */
    normalize_input: (intake: IntakeTriageInput): TriageInput => fromIntake(intake),

    /** ai step `classify_input` (stage `classify`): classification and the stage-1 decision. */
    classify_input: (input: TriageInput): Promise<ClassifyOutcome> => classifyStage(input, deps),

    /** rule `triage_decision`: maps the stage-1 outcome to an action. */
    triage_decision: (o: ClassifyOutcome) => classifyAction(o),

    /** system step `dedupe_search` (stage `dedupe`): memory search plus repo-set validation. */
    dedupe_search: (input: TriageInput, classified: ClassifyOutcome): Promise<DedupeOutcome> => {
      if (classified.kind !== "proceed") throw new TriageHandlerError(`dedupe_search needs a proceed outcome, got ${classified.kind}`);
      return dedupeStage(input, classified, deps);
    },

    /** rule `dedupe_decision`: maps the stage-2 outcome to an action. */
    dedupe_decision: (o: DedupeOutcome) => dedupeAction(o),

    /** system step `create_task` (stage `create_task`): per-repo workspace requests and task metadata. */
    create_task: (o: DedupeOutcome, task: TaskIdentity): CreateTaskResult => {
      if (o.kind !== "route") throw new TriageHandlerError(`create_task needs a route outcome, got ${o.kind}`);
      return {
        project: o.project,
        workspaces: workspaceRequests(registry, o, task),
        taskMetadata: {
          requiresHumanBeforeExecute: o.humanGateBeforeExecute,
          ...(o.memorySnapshotId ? { memorySnapshotId: o.memorySnapshotId } : {}),
        },
      };
    },
  };
}

export type TriageHandlers = ReturnType<typeof createTriageHandlers>;
