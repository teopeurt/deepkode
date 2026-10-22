// Responsibility: workspace home page —— project list + lightweight metrics (all from the status counts that GET /api/projects already includes;
// task details are not loaded). The list is just a list: tasks are fetched only when you enter a project (board / history / home details).
// Metrics: total tasks / running / failed / completion rate (aggregated counts).
import { useUi, writeHash } from '../store/ui';
import { useProjection } from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { BrandMark } from '../components/BrandMark';
import { RemoveProjectModal } from '../components/modals/RemoveProjectModal';
import { useState } from 'react';

interface Agg { total: number; pending: number; running: number; done: number; failed: number; cancelled: number }

export function HomeView() {
  const projects = useProjection((s) => s.projects);
  const loading = useProjection((s) => s.loading);
  const setDirOpen = useUi((s) => s.setDirOpen);
  // Project pending removal (projects can also be removed from the HomeView home page; the modal is shared with ProjectHomeView)
  const [removeTarget, setRemoveTarget] = useState<{ pid: string; name: string } | null>(null);

  const all = Object.values(projects);
  const agg: Agg = all.reduce(
    (a, p) => {
      const c = p.counts ?? [0, 0, 0, 0, 0];
      return {
        total: a.total + (c[0] + c[1] + c[2] + c[3] + c[4]),
        pending: a.pending + c[0], running: a.running + c[1],
        done: a.done + c[2], failed: a.failed + c[3], cancelled: a.cancelled + c[4],
      };
    },
    { total: 0, pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
  );
  const rate = agg.done + agg.failed ? Math.round((agg.done / (agg.done + agg.failed)) * 100) : 100;

  const enter = (pid: string) => {
    useUi.getState().setRoute({ pid, view: 'projhome', openId: null, tab: 'comments' });
    writeHash(pid, 'projhome', null, 'comments');
  };

  if (loading && !all.length) {
    return (
      <div id="home">
        <div className="home-hero"><div><div className="title">Workspace</div><div className="sub">Cross-project overview</div></div></div>
        <div className="home-grid">
          <div className="home-col"><Skeleton height={120} /><Skeleton height={120} /></div>
          <div className="home-col"><Skeleton height={120} /><Skeleton height={120} /></div>
        </div>
      </div>
    );
  }

  return (
    <div id="home">
      <div className="home-hero">
        <div>
          <div className="title"><BrandMark size={30} className="brand-mark" />Workspace</div>
          <div className="sub">
            <span>{all.length} projects</span> · <span>{agg.running} running</span> ·{' '}
            <span className="hot">{agg.failed ? agg.failed + ' failed, awaiting attention' : 'Nothing needs your attention'}</span>
          </div>
        </div>
        <div className="actions">
          <Button variant="primary" onClick={() => setDirOpen(true)}>New project</Button>
        </div>
      </div>

      <div className="home-sec home-metrics">
        <div className="home-sec-t">Project metrics</div>
        <div className="metric-grid">
          <div className="metric" style={{ ['--i' as string]: 0 }}>
            <div className="ml">Task completion rate</div>
            <div className="mv">{rate}%</div>
            <div className="ms">Done {agg.done} · Failed {agg.failed}</div>
          </div>
          <div className="metric" style={{ ['--i' as string]: 1 }}>
            <div className="ml">Running</div>
            <div className="mv">{agg.running}</div>
            <div className="ms">To do {agg.pending} · Cancelled {agg.cancelled}</div>
          </div>
          <div className="metric" style={{ ['--i' as string]: 2 }}>
            <div className="ml">Total tasks</div>
            <div className="mv">{agg.total}</div>
            <div className="ms">Across {all.length} projects</div>
          </div>
          <div className="metric" style={{ ['--i' as string]: 3 }}>
            <div className="ml">Knowledge captured</div>
            <div className="mv">—</div>
            <div className="ms">Cross-project totals not wired up yet (see the knowledge view)</div>
          </div>
        </div>
      </div>

      <div className="home-grid">
        <div className="home-col">
          <div className="home-sec">
            <div className="home-sec-t">Projects</div>
            {all.map((p, k) => {
              const c = p.counts ?? [0, 0, 0, 0, 0];
              const has = (i: number) => c[i] > 0;
              return (
                <div key={p.id} className="home-project" style={{ ['--i' as string]: k }} onClick={() => enter(p.id)}>
                  <div className="row1">
                    <span className="pname">{p.name}</span>
                    <span className="pillrow">
                      {has(1) ? <StatusPill status="Running" label={'Running ' + c[1]} /> : null}
                      {has(3) ? <StatusPill status="Failed" label={'Failed ' + c[3]} /> : null}
                      {has(0) ? <StatusPill status="Pending" label={'To do ' + c[0]} /> : null}
                      {has(2) ? <StatusPill status="Done" label={'Done ' + c[2]} /> : null}
                      {has(4) ? <StatusPill status="Cancelled" label={'Cancelled ' + c[4]} /> : null}
                    </span>
                    <Button
                      variant="quiet"
                      mini
                      className="home-project-rm"
                      title="Remove project"
                      aria-label={'Remove project ' + p.name}
                      onClick={(e) => { e.stopPropagation(); setRemoveTarget({ pid: p.id, name: p.name }); }}
                    >
                      ✕
                    </Button>
                  </div>
                  <div className="pm">{p.path} · {p.card_count} cards</div>
                </div>
              );
            })}
            {!all.length && (
              <EmptyState icon="folder" title="No projects yet" desc="Pick a directory to import, or a project is registered automatically when you create its first task card" />
            )}
          </div>
          <div className="home-sec">
            <div className="home-sec-t">Happening now</div>
            <div className="ph-empty">{agg.running ? agg.running + ' tasks running (enter the project for details)' : 'No tasks are running'}</div>
            <div className="ph-hint2">Task details load once you enter a project (lightweight list · details fetched on activation)</div>
          </div>
        </div>
      </div>
      {removeTarget ? (
        <RemoveProjectModal pid={removeTarget.pid} name={removeTarget.name} onClose={() => setRemoveTarget(null)} />
      ) : null}
    </div>
  );
}
