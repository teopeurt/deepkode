import Database from "better-sqlite3";
const now = () => Date.now();
class Storage {
  db;
  constructor(path) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        path        TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status      TEXT NOT NULL,
        title       TEXT,
        model       TEXT,
        turns       INTEGER NOT NULL DEFAULT 0,
        steps       INTEGER NOT NULL DEFAULT 0,
        last_seq    INTEGER NOT NULL DEFAULT 0,
        recovered   INTEGER NOT NULL DEFAULT 0,
        started_at  INTEGER,
        finished_at INTEGER,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

      CREATE TABLE IF NOT EXISTS cards (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        kind          TEXT NOT NULL DEFAULT 'task',
        milestone     TEXT,
        criteria_json TEXT NOT NULL DEFAULT '[]',  -- requirement contract: acceptance criteria ('[]'=none, compatible with old NOT NULL schema)
        deps_json     TEXT NOT NULL DEFAULT '[]',  -- dependency contract: array of card ids (target contract: taskgraph)
        budget        REAL,                         -- execution budget (CNY, opt-in; Waiting{cost})
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id);

      CREATE TABLE IF NOT EXISTS executions (
        id          TEXT PRIMARY KEY,
        card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        session_id  TEXT,
        status      TEXT NOT NULL DEFAULT 'Pending',
        preset_json TEXT NOT NULL DEFAULT '{}',
        deps_json   TEXT NOT NULL DEFAULT '[]',
        forked_from TEXT,
        started_at  INTEGER,
        finished_at INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_executions_card ON executions(card_id);

      CREATE TABLE IF NOT EXISTS deleted_projects (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        PRIMARY KEY (project_id, key)
      );

      -- P1 policy learning (O6: every approval decision can be captured as a policy atom; command-pattern allowlists etc. wait on an engine seam, so approval policies land first)
      CREATE TABLE IF NOT EXISTS policies (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,              -- approval type: checkpoint | calibrate | plan | acceptance | permission
        scope       TEXT NOT NULL,              -- card type: requirement | bug | task | global
        outcome     TEXT NOT NULL,              -- approved | rejected
        count       INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE (project_id, kind, scope, outcome)
      );
      CREATE INDEX IF NOT EXISTS idx_policies_project ON policies(project_id);

      -- Group A chat-layer loop: persistence flag for simple chats (restored as standalone chats after restart; no implicit card is created)
      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id  TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      -- M4 knowledge base (architecture §4 kb_notes; bitemporal + trust levels + provenance)
      CREATE TABLE IF NOT EXISTS kb_notes (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        content_json  TEXT NOT NULL,            -- string[] (structured lines)
        tags_json     TEXT NOT NULL DEFAULT '[]',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        summary       TEXT NOT NULL DEFAULT '',
        anti_patterns_json TEXT NOT NULL DEFAULT '[]',  -- anti-patterns (inspired by WikiSkill: pitfalls / things to avoid)
        applicability TEXT NOT NULL DEFAULT '',         -- applicability (when this knowledge should be used)
        links_json    TEXT NOT NULL DEFAULT '[]',
        source_kind   TEXT NOT NULL,            -- 'task' | 'subagent' | 'human' | 'project'
        source_ref    TEXT NOT NULL,            -- card / session / project id
        valid_from    INTEGER NOT NULL,
        valid_until   INTEGER,                  -- NULL = currently valid
        invalidated_by TEXT,
        version       INTEGER NOT NULL DEFAULT 1,
        trust         TEXT NOT NULL DEFAULT 'unverified',  -- human-approved | agent-generated | unverified
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_project ON kb_notes(project_id);
      CREATE INDEX IF NOT EXISTS idx_kb_valid ON kb_notes(project_id, valid_until);

      -- M4 metrics loop (§5.2: brief hit rate / citation anchors / control-experiment groups)
      CREATE TABLE IF NOT EXISTS metrics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    TEXT NOT NULL,
        task_id       TEXT NOT NULL,
        brief_snapshot_json TEXT NOT NULL DEFAULT '[]',
        outcome       TEXT NOT NULL DEFAULT '',
        cited_entries_json TEXT NOT NULL DEFAULT '[]',
        turns         INTEGER NOT NULL DEFAULT 0,
        steps         INTEGER NOT NULL DEFAULT 0,
        group_tag     TEXT,                       -- control-experiment group ('A'=with assembly / 'B'=bare run)
        verified      INTEGER,                    -- acceptance result (1=passed / 0=failed / NULL=no acceptance criteria)
        cost          REAL NOT NULL DEFAULT 0,
        cache_hit     REAL NOT NULL DEFAULT 0,
        in_tokens     INTEGER NOT NULL DEFAULT 0,  -- input tokens (full-price portion)
        cache_tokens  INTEGER NOT NULL DEFAULT 0,  -- cache-hit input tokens (1/50 price)
        out_tokens    INTEGER NOT NULL DEFAULT 0,  -- output tokens
        reason_tokens INTEGER NOT NULL DEFAULT 0,  -- reasoning tokens
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_project ON metrics(project_id);

      -- P0 approval queue (architecture §4 approvals; first-class surface + single source of truth)
      CREATE TABLE IF NOT EXISTS approvals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL,
        execution_id TEXT NOT NULL,          -- = session id (D1.2)
        kind        TEXT NOT NULL,           -- 'plan' | 'permission' | 'acceptance' | 'cost'
        payload_json TEXT NOT NULL DEFAULT '{}',
        reason      TEXT,                    -- reason for waiting (explained by the agent when it stops)
        outcome     TEXT,                    -- 'approved' | 'rejected' | 'suspended' | NULL=awaiting decision
        comment     TEXT,                    -- an approval decision must carry a comment that is delivered to the agent
        created_at  INTEGER NOT NULL,
        decided_at  INTEGER,
        suspended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_project ON approvals(project_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(project_id, outcome);

      -- P0 preset profiles (§2.6: three-axis combinations collapsed into named profiles; managed per project)
      CREATE TABLE IF NOT EXISTS profiles (
        id          TEXT NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        is_builtin  INTEGER NOT NULL DEFAULT 0,
        mode        TEXT NOT NULL DEFAULT 'normal',    -- normal | plan | goal
        setting     TEXT NOT NULL DEFAULT 'balanced',  -- light | balanced | delivery
        approval    TEXT NOT NULL DEFAULT 'ask',       -- ask | auto | yolo
        sandbox     TEXT NOT NULL DEFAULT 'workspace-write',
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (project_id, id)
      );
    `);
    const cols = this.db.prepare(`SELECT name FROM pragma_table_info('metrics')`).all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("turns")) this.db.exec(`ALTER TABLE metrics ADD COLUMN turns INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("steps")) this.db.exec(`ALTER TABLE metrics ADD COLUMN steps INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("group_tag")) this.db.exec(`ALTER TABLE metrics ADD COLUMN group_tag TEXT`);
    if (!have.has("in_tokens")) this.db.exec(`ALTER TABLE metrics ADD COLUMN in_tokens INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("cache_tokens")) this.db.exec(`ALTER TABLE metrics ADD COLUMN cache_tokens INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("out_tokens")) this.db.exec(`ALTER TABLE metrics ADD COLUMN out_tokens INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("reason_tokens")) this.db.exec(`ALTER TABLE metrics ADD COLUMN reason_tokens INTEGER NOT NULL DEFAULT 0`);
    if (!have.has("verified")) this.db.exec(`ALTER TABLE metrics ADD COLUMN verified INTEGER`);
    const cardCols = this.db.prepare(`SELECT name FROM pragma_table_info('cards')`).all();
    if (!cardCols.some((c) => c.name === "deps_json")) {
      this.db.exec(`ALTER TABLE cards ADD COLUMN deps_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!cardCols.some((c) => c.name === "budget")) {
      this.db.exec(`ALTER TABLE cards ADD COLUMN budget REAL`);
    }
    const exCols = this.db.prepare(`SELECT name FROM pragma_table_info('executions')`).all();
    if (!exCols.some((c) => c.name === "worktree_path")) {
      this.db.exec(`ALTER TABLE executions ADD COLUMN worktree_path TEXT`);
      this.db.exec(`ALTER TABLE executions ADD COLUMN worktree_branch TEXT`);
    }
    // Inspired by WikiSkill: knowledge entries gain anti-patterns + applicability (ALTER migration for old databases)
    const kbCols = this.db.prepare(`SELECT name FROM pragma_table_info('kb_notes')`).all();
    const kbHave = new Set(kbCols.map((c) => c.name));
    if (!kbHave.has("anti_patterns_json")) {
      this.db.exec(`ALTER TABLE kb_notes ADD COLUMN anti_patterns_json TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!kbHave.has("applicability")) {
      this.db.exec(`ALTER TABLE kb_notes ADD COLUMN applicability TEXT NOT NULL DEFAULT ''`);
    }
  }
  // ---------- Projects ----------
  upsertProject(id, name, path, configJson) {
    const t = now();
    this.db.prepare(
      `INSERT INTO projects (id, name, path, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, updated_at=excluded.updated_at`
    ).run(id, name, path, configJson, t, t);
  }
  loadProjects() {
    return this.db.prepare("SELECT id, name, path, config_json, archived FROM projects WHERE archived = 0 ORDER BY updated_at DESC").all().map((r) => rowToProjectMeta(r));
  }
  archiveProject(id) {
    this.db.prepare("UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?").run(now(), id);
  }
  unarchiveProject(id) {
    this.db.prepare("UPDATE projects SET archived = 0, updated_at = ? WHERE id = ?").run(now(), id);
  }
  purgeProject(id) {
    for (const table of ["approvals", "metrics", "policies", "kb_notes", "profiles", "chat_sessions", "cards"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
    }
    this.db.prepare("DELETE FROM executions WHERE card_id IN (SELECT id FROM cards WHERE project_id = ?)").run(id);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
  markDeleted(id) {
    this.db.prepare("INSERT OR REPLACE INTO deleted_projects (id, deleted_at) VALUES (?, ?)").run(id, now());
  }
  isDeleted(id) {
    return this.db.prepare("SELECT 1 FROM deleted_projects WHERE id = ?").get(id) !== void 0;
  }
  projectExists(id) {
    return this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) !== void 0;
  }
  findArchivedProject(path) {
    const row = this.db.prepare("SELECT id, name, path, config_json, archived FROM projects WHERE archived = 1 AND path = ?").get(path);
    return row ? rowToProjectMeta(row) : void 0;
  }
  deleteProject(id) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
  // ---------- Card snapshots ----------
  upsertCard(c) {
    const t = now();
    this.db.prepare(
      `INSERT INTO cards (id, project_id, title, description, kind, milestone, criteria_json, deps_json, budget, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, description=excluded.description, kind=excluded.kind,
           milestone=excluded.milestone, criteria_json=excluded.criteria_json,
           deps_json=excluded.deps_json, budget=excluded.budget, updated_at=excluded.updated_at`
    ).run(c.id, c.project_id, c.title, c.description, c.kind, c.milestone, c.criteria ?? "[]", JSON.stringify(c.deps ?? []), c.budget ?? null, c.created_at, t);
  }
  loadCards(projectId) {
    return this.db.prepare("SELECT id, project_id, title, description, kind, milestone, criteria_json, deps_json, budget, created_at FROM cards WHERE project_id = ? ORDER BY created_at DESC").all(projectId).map((r) => rowToCard(r));
  }
  loadAllCards() {
    return this.db.prepare("SELECT id, project_id, title, description, kind, milestone, criteria_json, deps_json, budget, created_at FROM cards").all().map((r) => rowToCard(r));
  }
  getCard(id) {
    const row = this.db.prepare("SELECT id, project_id, title, description, kind, milestone, criteria_json, deps_json, budget, created_at FROM cards WHERE id = ?").get(id);
    return row ? rowToCard(row) : void 0;
  }
  // ---------- Execution snapshots ----------
  upsertExecution(e) {
    const t = now();
    this.db.prepare(
      `INSERT INTO executions (id, card_id, session_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           card_id=excluded.card_id, session_id=excluded.session_id, status=excluded.status,
           preset_json=excluded.preset_json, deps_json=excluded.deps_json,
           forked_from=excluded.forked_from, started_at=excluded.started_at,
           finished_at=excluded.finished_at, updated_at=excluded.updated_at`
    ).run(e.id, e.card_id, e.id, e.status, e.preset_json, e.deps_json, e.forked_from, e.started_at, e.finished_at, e.created_at, t);
  }
  loadExecutions(cardId) {
    return this.db.prepare(
      "SELECT id, card_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at, worktree_path, worktree_branch FROM executions WHERE card_id = ? ORDER BY created_at"
    ).all(cardId).map((r) => rowToExecution(r));
  }
  loadAllExecutions() {
    return this.db.prepare(
      "SELECT id, card_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at, worktree_path, worktree_branch FROM executions"
    ).all().map((r) => rowToExecution(r));
  }
  getExecutionBySession(sessionId) {
    const row = this.db.prepare(
      "SELECT id, card_id, status, preset_json, deps_json, forked_from, started_at, finished_at, created_at, worktree_path, worktree_branch FROM executions WHERE session_id = ?"
    ).get(sessionId);
    return row ? rowToExecution(row) : void 0;
  }
  setExecutionWorktree(id, path, branch) {
    this.db.prepare("UPDATE executions SET worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ?").run(path, branch, now(), id);
  }
  // ---------- Settings ----------
  setConfig(projectId, key, value) {
    this.db.prepare(
      "INSERT INTO settings (project_id, key, value) VALUES (?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value=excluded.value"
    ).run(projectId, key, value);
  }
  getConfig(projectId, key) {
    const row = this.db.prepare("SELECT value FROM settings WHERE project_id = ? AND key = ?").get(projectId, key);
    return row?.value;
  }
  projectConfig(id) {
    const row = this.db.prepare("SELECT config_json FROM projects WHERE id = ?").get(id);
    return row?.config_json;
  }
  // ---------- Knowledge base (M4) ----------
  upsertNote(n) {
    const t = Date.now();
    this.db.prepare(
      `INSERT INTO kb_notes (id, project_id, title, content_json, tags_json, keywords_json, summary,
           anti_patterns_json, applicability, links_json, source_kind, source_ref, valid_from, valid_until, invalidated_by, version, trust, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, content_json=excluded.content_json, tags_json=excluded.tags_json,
           keywords_json=excluded.keywords_json, summary=excluded.summary,
           anti_patterns_json=excluded.anti_patterns_json, applicability=excluded.applicability,
           links_json=excluded.links_json,
           valid_until=excluded.valid_until, invalidated_by=excluded.invalidated_by,
           version=excluded.version, trust=excluded.trust, updated_at=excluded.updated_at`
    ).run(
      n.id,
      n.project_id,
      n.title,
      JSON.stringify(n.content),
      JSON.stringify(n.tags),
      JSON.stringify(n.keywords),
      n.summary,
      JSON.stringify(n.antiPatterns ?? []),
      n.applicability ?? '',
      JSON.stringify(n.links),
      n.source.kind,
      n.source.ref,
      n.validFrom,
      n.validUntil ?? null,
      n.invalidatedBy ?? null,
      n.version,
      n.trust,
      n.createdAt,
      t
    );
  }
  /** Currently valid notes (bitemporal filter). */
  listNotes(projectId) {
    const rows = this.db.prepare("SELECT * FROM kb_notes WHERE project_id = ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY created_at DESC").all(projectId, Date.now());
    return rows.map(rowToNote);
  }
  /** All notes (including invalidated ones, for audit/evolution). */
  listAllNotes(projectId) {
    const rows = this.db.prepare("SELECT * FROM kb_notes WHERE project_id = ? ORDER BY created_at DESC").all(projectId);
    return rows.map(rowToNote);
  }
  getNote(id) {
    const row = this.db.prepare("SELECT * FROM kb_notes WHERE id = ?").get(id);
    return row ? rowToNote(row) : void 0;
  }
  /** Edge invalidation: mark id as superseded by newNoteId. */
  invalidateNote(id, newNoteId, at) {
    this.db.prepare("UPDATE kb_notes SET valid_until = ?, invalidated_by = ?, updated_at = ? WHERE id = ? AND valid_until IS NULL").run(at, newNoteId, at, id);
  }
  deleteNote(id) {
    this.db.prepare("DELETE FROM kb_notes WHERE id = ?").run(id);
  }
  // ---------- Metrics (M4 §5.2) ----------
  insertMetric(m) {
    this.db.prepare(
      `INSERT INTO metrics (project_id, task_id, brief_snapshot_json, outcome, cited_entries_json, turns, steps, group_tag, verified, cost, cache_hit, in_tokens, cache_tokens, out_tokens, reason_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      m.project_id,
      m.task_id,
      JSON.stringify(m.brief_snapshot),
      m.outcome,
      JSON.stringify(m.cited_entries),
      m.turns,
      m.steps,
      m.group_tag ?? null,
      m.verified === void 0 ? null : m.verified ? 1 : 0,
      m.cost,
      m.cache_hit,
      m.in_tokens,
      m.cache_tokens,
      m.out_tokens,
      m.reason_tokens,
      m.created_at
    );
  }
  listMetrics(projectId) {
    const rows = this.db.prepare("SELECT * FROM metrics WHERE project_id = ? ORDER BY created_at DESC LIMIT 200").all(projectId);
    return rows.map(rowToMetric);
  }
  // ---------- Approval queue (P0: first-class surface + single source of truth) ----------
  insertApproval(a) {
    const info = this.db.prepare(
      `INSERT INTO approvals (project_id, execution_id, kind, payload_json, reason, outcome, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(a.project_id, a.execution_id, a.kind, JSON.stringify(a.payload), a.reason ?? null, a.outcome ?? null, a.comment ?? null, a.created_at);
    return Number(info.lastInsertRowid);
  }
  /** Suspended approvals queue (per project; includes the waiting reason and suspended flag). */
  listSuspendedApprovals(projectId) {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE project_id = ? AND outcome = 'suspended' ORDER BY suspended_at").all(projectId);
    return rows.map(rowToApproval);
  }
  /** Resume a suspended approval (O5: the original session continues from the Waiting point without losing its mode) */
  resumeApproval(id) {
    const info = this.db.prepare("UPDATE approvals SET outcome = NULL, decided_at = NULL, suspended_at = NULL WHERE id = ? AND outcome = ?").run(id, "suspended");
    return info.changes > 0;
  }
  /** Bulk resume (O5: resume = all suspended items re-enter the queue) */
  resumeAllApprovals(projectId) {
    const info = this.db.prepare("UPDATE approvals SET outcome = NULL, decided_at = NULL, suspended_at = NULL WHERE project_id = ? AND outcome = ?").run(projectId, "suspended");
    return info.changes;
  }
  listPendingApprovals(projectId) {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE project_id = ? AND outcome IS NULL ORDER BY created_at").all(projectId);
    return rows.map(rowToApproval);
  }
  /** All approvals (including decided ones, for audit). */
  listApprovals(projectId, limit = 100) {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit);
    return rows.map(rowToApproval);
  }
  getApproval(id) {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? rowToApproval(row) : void 0;
  }
  /** Decide an approval: approve/reject + comment; returns whether it succeeded (already-decided ones are not changed). */
  decideApproval(id, outcome, comment) {
    const info = this.db.prepare(
      `UPDATE approvals SET outcome = ?, comment = ?, decided_at = ? WHERE id = ? AND outcome IS NULL`
    ).run(outcome, comment, Date.now(), id);
    return info.changes > 0;
  }
  /** Suspend: automatic suspension on timeout (O5: default 30 minutes; dangerous operations are never auto-approved). */
  suspendApproval(id) {
    const info = this.db.prepare("UPDATE approvals SET outcome = ?, suspended_at = ? WHERE id = ? AND outcome IS NULL").run("suspended", Date.now(), id);
    return info.changes > 0;
  }
  // ---------- Policy learning (P1 O6: approval → policy atom; rules can be viewed and deleted) ----------
  /** Learn one policy: accumulate count for the same (kind, scope, outcome); returns the latest rule. */
  learnPolicy(projectId, kind, scope, outcome) {
    const t = Date.now();
    this.db.prepare(
      `INSERT INTO policies (project_id, kind, scope, outcome, count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(project_id, kind, scope, outcome) DO UPDATE SET
           count = count + 1, updated_at = excluded.updated_at`
    ).run(projectId, kind, scope, outcome, t, t);
    return this.getPolicy(projectId, kind, scope, outcome);
  }
  getPolicy(projectId, kind, scope, outcome) {
    const row = this.db.prepare("SELECT * FROM policies WHERE project_id = ? AND kind = ? AND scope = ? AND outcome = ?").get(projectId, kind, scope, outcome);
    return row ? rowToPolicy(row) : void 0;
  }
  listPolicies(projectId) {
    const rows = this.db.prepare("SELECT * FROM policies WHERE project_id = ? ORDER BY updated_at DESC").all(projectId);
    return rows.map(rowToPolicy);
  }
  deletePolicy(id) {
    const info = this.db.prepare("DELETE FROM policies WHERE id = ?").run(id);
    return info.changes > 0;
  }
  // ---------- Simple chats (group A: chat persistence flag) ----------
  registerChat(sessionId, projectId) {
    this.db.prepare("INSERT OR IGNORE INTO chat_sessions (session_id, project_id, created_at) VALUES (?, ?, ?)").run(sessionId, projectId, Date.now());
  }
  isChat(sessionId) {
    return !!this.db.prepare("SELECT 1 FROM chat_sessions WHERE session_id = ?").get(sessionId);
  }
  /** Remove the chat flag after promotion to a task (chat becomes a card execution) */
  unregisterChat(sessionId) {
    this.db.prepare("DELETE FROM chat_sessions WHERE session_id = ?").run(sessionId);
  }
  listChats(projectId) {
    const rows = this.db.prepare("SELECT session_id FROM chat_sessions WHERE project_id = ?").all(projectId);
    return rows.map((r) => r.session_id);
  }
  // ---------- Preset profiles (P0 §2.6) ----------
  /** Seed the 4 built-in profiles (idempotent); the first one becomes the project default. Returns whether this was the first seeding. */
  seedProfiles(projectId) {
    const existing = this.db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE project_id = ?").get(projectId);
    if (existing.n > 0) return false;
    const t = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO profiles (id, project_id, name, is_builtin, mode, setting, approval, sandbox, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    BUILTIN_PROFILES.forEach((p, i) => {
      insert.run(p.id, projectId, p.name, 1, p.mode, p.setting, p.approval, p.sandbox, i === 0 ? 1 : 0, t, t);
    });
    return true;
  }
  listProfiles(projectId) {
    const rows = this.db.prepare("SELECT * FROM profiles WHERE project_id = ? ORDER BY is_default DESC, is_builtin DESC, created_at").all(projectId);
    return rows.map(rowToProfile);
  }
  getProfile(projectId, id) {
    const row = this.db.prepare("SELECT * FROM profiles WHERE project_id = ? AND id = ?").get(projectId, id);
    return row ? rowToProfile(row) : void 0;
  }
  defaultProfile(projectId) {
    const row = this.db.prepare("SELECT * FROM profiles WHERE project_id = ? AND is_default = 1").get(projectId);
    return row ? rowToProfile(row) : void 0;
  }
  /** Custom profile (copy an existing one and change the three axes); built-ins cannot be overwritten directly. */
  upsertProfile(projectId, p) {
    const t = Date.now();
    this.db.prepare(
      `INSERT INTO profiles (id, project_id, name, is_builtin, mode, setting, approval, sandbox, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, id) DO UPDATE SET
           name=excluded.name, mode=excluded.mode, setting=excluded.setting,
           approval=excluded.approval, sandbox=excluded.sandbox, updated_at=excluded.updated_at
           WHERE profiles.is_builtin = 0`
    ).run(p.id, projectId, p.name, p.is_builtin ? 1 : 0, p.mode, p.setting, p.approval, p.sandbox, p.is_default ? 1 : 0, t, t);
  }
  /** Set the project default (clear the old default, set the new one). */
  setDefaultProfile(projectId, id) {
    const p = this.getProfile(projectId, id);
    if (!p) return false;
    this.db.prepare("UPDATE profiles SET is_default = 0 WHERE project_id = ?").run(projectId);
    this.db.prepare("UPDATE profiles SET is_default = 1 WHERE project_id = ? AND id = ?").run(projectId, id);
    return true;
  }
  removeProfile(projectId, id) {
    const p = this.getProfile(projectId, id);
    if (!p || p.is_builtin) return false;
    const wasDefault = p.is_default;
    const info = this.db.prepare("DELETE FROM profiles WHERE project_id = ? AND id = ?").run(projectId, id);
    if (info.changes === 0) return false;
    if (wasDefault) {
      const rest = this.listProfiles(projectId);
      const next = rest.find((x) => x.id === BUILTIN_PROFILES[0].id) ?? rest.find((x) => x.is_builtin) ?? rest[0];
      if (next) this.setDefaultProfile(projectId, next.id);
    }
    return true;
  }
  close() {
    this.db.close();
  }
}
function rowToProjectMeta(r) {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    config_json: r.config_json,
    archived: r.archived !== 0
  };
}
function rowToCard(r) {
  return {
    id: r.id,
    project_id: r.project_id,
    title: r.title,
    description: r.description ?? "",
    kind: r.kind ?? "task",
    milestone: r.milestone ?? null,
    criteria: r.criteria_json && r.criteria_json !== "[]" ? r.criteria_json : null,
    deps: parseIdArray(r.deps_json),
    budget: r.budget == null ? null : r.budget,
    created_at: r.created_at
  };
}
function parseIdArray(json) {
  if (typeof json !== "string") return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function rowToExecution(r) {
  return {
    id: r.id,
    card_id: r.card_id,
    status: r.status,
    preset_json: r.preset_json ?? "{}",
    deps_json: r.deps_json ?? "[]",
    forked_from: r.forked_from ?? null,
    started_at: r.started_at ?? null,
    finished_at: r.finished_at ?? null,
    created_at: r.created_at,
    worktree_path: r.worktree_path ?? null,
    worktree_branch: r.worktree_branch ?? null
  };
}
function rowToNote(r) {
  const parse = (s) => {
    if (typeof s !== "string") return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    id: r.id,
    project_id: r.project_id,
    title: r.title,
    content: parse(r.content_json),
    tags: parse(r.tags_json),
    keywords: parse(r.keywords_json),
    summary: r.summary ?? "",
    antiPatterns: parse(r.anti_patterns_json),
    applicability: r.applicability ?? "",
    links: parse(r.links_json),
    source: { kind: r.source_kind, ref: r.source_ref },
    validFrom: r.valid_from,
    validUntil: r.valid_until ?? null,
    invalidatedBy: r.invalidated_by ?? void 0,
    version: r.version ?? 1,
    trust: r.trust ?? "unverified",
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
function rowToMetric(r) {
  const parseArr = (s) => {
    if (typeof s !== "string") return [];
    try {
      return JSON.parse(s);
    } catch {
      return [];
    }
  };
  const parseCited = (s) => {
    if (typeof s !== "string") return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    project_id: r.project_id,
    task_id: r.task_id,
    brief_snapshot: parseArr(r.brief_snapshot_json),
    outcome: r.outcome ?? "",
    cited_entries: parseCited(r.cited_entries_json),
    turns: r.turns ?? 0,
    steps: r.steps ?? 0,
    group_tag: r.group_tag ?? void 0,
    verified: r.verified === void 0 || r.verified === null ? void 0 : r.verified !== 0,
    cost: r.cost ?? 0,
    cache_hit: r.cache_hit ?? 0,
    in_tokens: r.in_tokens ?? 0,
    cache_tokens: r.cache_tokens ?? 0,
    out_tokens: r.out_tokens ?? 0,
    reason_tokens: r.reason_tokens ?? 0,
    created_at: r.created_at
  };
}
function rowToApproval(r) {
  let payload = {};
  try {
    payload = JSON.parse(r.payload_json ?? "{}");
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    project_id: r.project_id,
    execution_id: r.execution_id,
    kind: r.kind,
    payload,
    reason: r.reason ?? null,
    outcome: r.outcome ?? null,
    comment: r.comment ?? null,
    created_at: r.created_at,
    decided_at: r.decided_at ?? null,
    suspended_at: r.suspended_at ?? null
  };
}
const BUILTIN_PROFILES = [
  { id: "standard", name: "Standard", is_builtin: true, mode: "normal", setting: "balanced", approval: "ask", sandbox: "workspace-write" },
  { id: "cautious", name: "Cautious", is_builtin: true, mode: "plan", setting: "balanced", approval: "ask", sandbox: "read-only" },
  { id: "surfing", name: "Surfing", is_builtin: true, mode: "normal", setting: "light", approval: "auto", sandbox: "workspace-write" },
  { id: "delivery", name: "Delivery", is_builtin: true, mode: "normal", setting: "delivery", approval: "auto", sandbox: "workspace-write" }
];
function rowToProfile(r) {
  return {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    is_builtin: r.is_builtin !== 0,
    mode: r.mode,
    setting: r.setting,
    approval: r.approval,
    sandbox: r.sandbox,
    is_default: r.is_default !== 0,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}
function rowToPolicy(r) {
  return {
    id: r.id,
    project_id: r.project_id,
    kind: r.kind,
    scope: r.scope,
    outcome: r.outcome,
    count: r.count,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}
function policySuggestion(storage, projectId, kind, cardKind) {
  const scopes = [cardKind || "task", "global"];
  let best = null;
  for (const scope of scopes) {
    for (const outcome of ["approved", "rejected"]) {
      const p = storage.getPolicy(projectId, kind, scope, outcome);
      if (p && p.count >= 2 && (!best || p.count > best.count)) {
        best = { scope: p.scope, outcome: p.outcome, count: p.count };
      }
    }
  }
  return best;
}
export {
  BUILTIN_PROFILES,
  Storage,
  parseIdArray,
  policySuggestion
};
