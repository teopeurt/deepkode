import { Database } from "bun:sqlite";
import type { Note, Snapshot } from "./types";

/** Storage behind the Memory service (Spec C §9b rule 5: SQLite first, Postgres later). */
export interface MemoryStore {
  insert(note: Note): void;
  update(note: Note): void;
  get(id: string): Note | null;
  list(projectId: string): Note[];
  /** Insert-only: a stored snapshot is never overwritten. Returns the stored one. */
  putSnapshot(s: Snapshot): Snapshot;
  getSnapshot(id: string): Snapshot | null;
}

export class InMemoryStore implements MemoryStore {
  private notes = new Map<string, string>();
  private snaps = new Map<string, string>();
  insert(n: Note) { if (this.notes.has(n.id)) throw new Error("exists: " + n.id); this.notes.set(n.id, JSON.stringify(n)); }
  update(n: Note) { if (!this.notes.has(n.id)) throw new Error("missing: " + n.id); this.notes.set(n.id, JSON.stringify(n)); }
  get(id: string) { const s = this.notes.get(id); return s ? (JSON.parse(s) as Note) : null; }
  list(projectId: string) { return [...this.notes.values()].map((s) => JSON.parse(s) as Note).filter((n) => n.projectId === projectId).sort((a, b) => (a.id < b.id ? -1 : 1)); }
  putSnapshot(s: Snapshot) { if (!this.snaps.has(s.id)) this.snaps.set(s.id, JSON.stringify(s)); return JSON.parse(this.snaps.get(s.id)!) as Snapshot; }
  getSnapshot(id: string) { const s = this.snaps.get(id); return s ? (JSON.parse(s) as Snapshot) : null; }
}

export class SqliteStore implements MemoryStore {
  private db: Database;
  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.run("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, json TEXT NOT NULL)");
    this.db.run("CREATE INDEX IF NOT EXISTS notes_project ON notes(project_id)");
    this.db.run("CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
  }
  insert(n: Note) { this.db.query("INSERT INTO notes (id, project_id, json) VALUES (?, ?, ?)").run(n.id, n.projectId, JSON.stringify(n)); }
  update(n: Note) {
    const r = this.db.query("UPDATE notes SET json = ? WHERE id = ?").run(JSON.stringify(n), n.id);
    if (r.changes !== 1) throw new Error("missing: " + n.id);
  }
  get(id: string) { const r = this.db.query("SELECT json FROM notes WHERE id = ?").get(id) as { json: string } | null; return r ? (JSON.parse(r.json) as Note) : null; }
  list(projectId: string) { return (this.db.query("SELECT json FROM notes WHERE project_id = ? ORDER BY id").all(projectId) as { json: string }[]).map((r) => JSON.parse(r.json) as Note); }
  putSnapshot(s: Snapshot) {
    this.db.query("INSERT OR IGNORE INTO snapshots (id, json) VALUES (?, ?)").run(s.id, JSON.stringify(s));
    return this.getSnapshot(s.id)!;
  }
  getSnapshot(id: string) { const r = this.db.query("SELECT json FROM snapshots WHERE id = ?").get(id) as { json: string } | null; return r ? (JSON.parse(r.json) as Snapshot) : null; }
  close() { this.db.close(); }
}
