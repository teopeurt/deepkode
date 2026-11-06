// Turns a routed decision into per-repo workspace requests for the existing WorktreeManager API
// (Spec C 5, D8). Produces plain objects only: no git, no filesystem.
import { branchName, type TaskRef } from "../workspaces/worktrees";
import type { Project } from "../workspaces/project";
import type { ProjectRegistry } from "./registry";
import type { TriageDecision } from "./decision";

export interface WorkspaceRequest {
  /** Arguments of `WorktreeManager.create(repoPath, ref, baseRef)`. */
  repoPath: string;
  ref: TaskRef;
  baseRef: string;
  /** Branch the manager would create, for display and audit. */
  branch: string;
}

export interface TaskIdentity { workflowId: string; epoch: string | number; taskId: string }

export class WorkspaceRequestError extends Error {}

/** One request per repo of a routed decision. Throws if the decision is not a route or names a foreign repo. */
export function workspaceRequests(registry: ProjectRegistry, decision: TriageDecision, task: TaskIdentity): WorkspaceRequest[] {
  if (decision.kind !== "route") throw new WorkspaceRequestError(`cannot create workspaces for a ${decision.kind} decision`);
  const project = registry.get(decision.project);
  if (!project) throw new WorkspaceRequestError(`unknown project ${decision.project}`);
  return decision.repos.map((name) => {
    const repo = project.repos.find((r) => r.name === name);
    if (!repo) throw new WorkspaceRequestError(`repo ${name} is not part of project ${project.id}`);
    const ref: TaskRef = { ...task, repo: repo.name };
    return { repoPath: repo.path, ref, baseRef: repo.defaultBranch, branch: branchName(ref) };
  });
}

/** The routed subset of a project as the `Project` shape `createProjectWorkspaces` takes. */
export function toWorkspaceProject(registry: ProjectRegistry, decision: TriageDecision): Project {
  if (decision.kind !== "route") throw new WorkspaceRequestError(`cannot create a project for a ${decision.kind} decision`);
  const project = registry.get(decision.project);
  if (!project) throw new WorkspaceRequestError(`unknown project ${decision.project}`);
  return {
    id: project.id,
    repos: project.repos.filter((r) => decision.repos.includes(r.name)).map((r) => ({ name: r.name, path: r.path, baseRef: r.defaultBranch })),
  };
}
