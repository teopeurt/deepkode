// Project registry (Spec C 2a): a project may span several repositories. In-memory implementation;
// no network, no git. Routing hints are plain keywords/fragments matched case-insensitively.

export interface RegistryRepo {
  /** Short repo name, unique within the project. Used as the `{repo}` path segment of a worktree. */
  name: string;
  /** Local path of the clone the worktree manager branches from. */
  path: string;
  /** Branch or ref tasks start from and would merge into. */
  defaultBranch: string;
  remote?: string;
  /** Words or fragments (paths, identifiers, error names) that point at this repo. */
  hints: string[];
}

export interface ProjectRecord {
  id: string;
  name?: string;
  repos: RegistryRepo[];
  owners: string[];
  routingHints: {
    /** Words that point at the project as a whole (product names, domain terms). */
    keywords: string[];
    /** Channels or senders known to belong to this project (optional). */
    senders?: string[];
  };
}

export interface ProjectRegistry {
  get(id: string): ProjectRecord | undefined;
  list(): ProjectRecord[];
}

export class RegistryError extends Error {}

export class InMemoryProjectRegistry implements ProjectRegistry {
  private readonly byId = new Map<string, ProjectRecord>();

  constructor(projects: ProjectRecord[] = []) {
    for (const p of projects) this.add(p);
  }

  add(p: ProjectRecord): void {
    if (!p.id) throw new RegistryError("project id is empty");
    if (this.byId.has(p.id)) throw new RegistryError(`duplicate project ${p.id}`);
    if (p.repos.length === 0) throw new RegistryError(`project ${p.id} has no repos`);
    const names = p.repos.map((r) => r.name);
    if (new Set(names).size !== names.length) throw new RegistryError(`project ${p.id} has duplicate repo names`);
    // Defensive copy so later mutation of the argument cannot change routing.
    this.byId.set(p.id, structuredClone(p));
  }

  get(id: string): ProjectRecord | undefined {
    const p = this.byId.get(id);
    return p ? structuredClone(p) : undefined;
  }

  list(): ProjectRecord[] {
    return [...this.byId.values()].map((p) => structuredClone(p));
  }
}
