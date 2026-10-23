// Responsibility: cheap acceptance evidence —— git change snapshot + acceptance command result. Shared by the approval queue and the drawer.
// diff.stat (git diff --stat) is parsed into a DiffTable (ported from Beautiful UI): file | lines | +added | -removed.
import { DiffTable, parseDiffStat } from './DiffTable'
export function AcceptanceEvidence({ payload }: { payload: Record<string, unknown> }) {
  const criteria = typeof payload.criteria === 'string' && payload.criteria.trim() ? payload.criteria : null
  const verify = asVerify(payload.verify)
  const diff = asDiff(payload.diff)
  const worktree = asWorktree(payload.worktree)
  const mergeErr = payload.merge && typeof payload.merge === 'object'
    ? String((payload.merge as { error?: unknown }).error ?? '')
    : ''
  if (!criteria && !verify && !diff && !worktree && !mergeErr) return null

  const verdict = verify?.verified === true
    ? 'pass'
    : verify?.verified === false
      ? 'fail'
      : verify
        ? 'skip'
        : null

  return (
    <div className="ev-block">
      {worktree ? (
        <div className="ev-section">
          <div className="ev-head">
            <span>Isolated workspace</span>
            <span className="tag">{worktree.branch}</span>
          </div>
          <div className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)' }}>{worktree.path}</div>
        </div>
      ) : null}
      {mergeErr ? <div className="ev-err">{mergeErr}</div> : null}
      {verify || criteria ? (
        <div className="ev-section">
          <div className="ev-head">
            <span>Acceptance command</span>
            {verdict === 'pass' ? <span className="tag ev-pass">passed</span> : null}
            {verdict === 'fail' ? <span className="tag ev-fail">failed</span> : null}
            {verdict === 'skip' ? <span className="tag">undecided</span> : null}
            {verify && verify.durationMs >= 0 ? <span className="muted">{verify.durationMs}ms</span> : null}
            {verify?.exitCode != null ? <span className="muted">exit {verify.exitCode}</span> : null}
          </div>
          {criteria ? <pre className="ev-pre">{criteria}</pre> : null}
          {verify?.error ? <div className="ev-err">{verify.error}</div> : null}
          {verify?.outputTail ? (
            <details className="appr-plan">
              <summary>Command output (tail)</summary>
              <pre className="ev-pre">{verify.outputTail}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {diff ? (
        <div className="ev-section">
          <div className="ev-head">
            <span>Workspace changes</span>
            {diff.error ? <span className="tag ev-fail">diff unavailable</span> : null}
            {!diff.error && diff.dirty ? <span className="tag">{diff.files.length} files</span> : null}
            {!diff.error && !diff.dirty ? <span className="tag ev-pass">clean</span> : null}
          </div>
          {diff.error ? <div className="ev-err">{diff.error}</div> : null}
          {!diff.error && diff.stat ? renderDiffStat(diff.stat) : null}
          {!diff.error && diff.files.length > 0 ? (
            <ul className="ev-files">
              {diff.files.map((f) => <li key={f}>{f}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** diffstat → DiffTable (falls back to the raw text if parsing fails) */
function renderDiffStat(stat: string) {
  const parsed = parseDiffStat(stat)
  if (parsed.rows.length === 0) return <pre className="ev-pre">{stat}</pre>
  return (
    <div style={{ marginTop: 8 }}>
      <DiffTable
        columns={[
          { key: 'file', label: 'File', width: '52%' },
          { key: 'count', label: 'Lines', width: '16%' },
          { key: 'add', label: '+ Added', width: '16%' },
          { key: 'del', label: '- Removed', width: '16%' },
        ]}
        rows={parsed.rows}
        footer={parsed.footer}
      />
    </div>
  )
}

function asVerify(v: unknown): {
  verified: boolean | null
  exitCode: number | null
  durationMs: number
  outputTail: string
  error?: string
} | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!('verified' in o) && !('outputTail' in o)) return null
  return {
    verified: o.verified === true ? true : o.verified === false ? false : null,
    exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : 0,
    outputTail: typeof o.outputTail === 'string' ? o.outputTail : '',
    error: typeof o.error === 'string' ? o.error : undefined,
  }
}

function asWorktree(v: unknown): { path: string; branch: string } | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.branch !== 'string' || typeof o.path !== 'string') return null
  return { path: o.path, branch: o.branch }
}

function asDiff(v: unknown): {
  dirty: boolean
  files: string[]
  stat: string
  error?: string
} | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.files) && typeof o.stat !== 'string') return null
  return {
    dirty: o.dirty === true,
    files: Array.isArray(o.files) ? o.files.filter((x): x is string => typeof x === 'string') : [],
    stat: typeof o.stat === 'string' ? o.stat : '',
    error: typeof o.error === 'string' ? o.error : undefined,
  }
}
