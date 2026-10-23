// Responsibility: Statusbar —— connection dot · project path · running/awaiting confirmation/failed · session cost · average cache hit (all derived from real data).
// M2.3: counts are by each card's latest execution status; cost/cache are aggregated from execution (session) usage.
import { useUi } from '../../store/ui';
import { useProjection, estCost, avgCacheHit, cardStatus, latestExecution } from '../../store/projection';

export function Statusbar() {
  const pid = useUi((s) => s.pid);
  const view = useUi((s) => s.view);
  const projects = useProjection((s) => s.projects);
  const cards = useProjection((s) => s.cards);
  const usage = useProjection((s) => s.usage);
  const conn = useProjection((s) => s.conn);
  const pending = useUi((s) => s.pendingProjects);

  const home = !pid || view === 'home';

  if (home) {
    const allCards = Object.values(cards).flatMap((m) => Object.values(m));
    const execs = allCards.map((c) => latestExecution(c)).filter((t): t is NonNullable<typeof t> => !!t);
    const cost = execs.reduce((sum, t) => sum + (estCost(usage[t.id], t.model) ?? 0), 0);
    const hit = avgCacheHit(execs, usage);
    const counts = cardCounts(allCards);
    return (
      <footer id="statusbar">
        <div className="sb-left">
          <span className={'dot' + (conn === 'online' ? ' ok' : conn === 'reconnect' ? ' warn' : '')} />
          <span>Helmsman · Workspace</span>
        </div>
        <div className="spacer" />
        <div className="sb-right">
          <span><b>{Object.keys(projects).length + Object.keys(pending).length}</b> projects</span>
          {counts.Running ? <span>Running <b>{counts.Running}</b></span> : null}
          {counts.Failed ? <span>Failed <b>{counts.Failed}</b></span> : null}
          <span>Session cost ¥{cost.toFixed(4)}</span>
          <span>Avg cache {hit == null ? '—' : Math.round(hit * 100) + '%'}</span>
        </div>
      </footer>
    );
  }

  const proj = projects[pid ?? ''] ?? pending[pid ?? ''];
  const projCards = Object.values(cards[pid ?? ''] || {});
  const execs = projCards.map((c) => latestExecution(c)).filter((t): t is NonNullable<typeof t> => !!t);
  const c = cardCounts(projCards);
  const cost = execs.reduce((sum, t) => sum + (estCost(usage[t.id], t.model) ?? 0), 0);
  const hit = avgCacheHit(execs, usage);
  const parts: string[] = [];
  if (c.Running) parts.push(`Running <b>${c.Running}</b>`);
  if (c.Failed) parts.push(`Failed <b>${c.Failed}</b>`);
  if (c.Pending) parts.push(`Awaiting confirmation <b>${c.Pending}</b>`);

  return (
    <footer id="statusbar">
      <div className="sb-left">
        <span className={'dot' + (conn === 'online' ? ' ok' : conn === 'reconnect' ? ' warn' : '')} />
        <span>Helmsman · {proj?.path ?? pid}</span>
      </div>
      <div className="spacer" />
      <div className="sb-right">
        {parts.length ? <span dangerouslySetInnerHTML={{ __html: parts.join(' · ') }} /> : null}
        <span>Session cost ¥{cost.toFixed(4)}</span>
        <span>Avg cache {hit == null ? '—' : Math.round(hit * 100) + '%'}</span>
      </div>
    </footer>
  );
}

/** Card counts (by each card's latest execution status; no execution = Pending) */
function cardCounts(cards: import('../../store/projection').CardState[]): Record<string, number> {
  const out: Record<string, number> = { Pending: 0, Running: 0, Done: 0, Failed: 0, Cancelled: 0, Waiting: 0 };
  cards.forEach((c) => { out[cardStatus(c)] += 1; });
  return out;
}
