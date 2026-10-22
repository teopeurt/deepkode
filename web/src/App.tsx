// Responsibility: App —— assembles the three-pane layout + hash routing (#pid=&view=&open=&tab=, contract matches the prototype) + WS subscription.
// Data flow: REST snapshot fetch → local projection → debounced refresh on WS events (incremental catch-up by last_seq); user actions POST → engine decides → events flow back.
import { useEffect, useRef, useState } from 'react';
import { ThemeProvider, useThemeStore } from './theme/ThemeProvider';
import { Atmosphere } from './theme/Atmosphere';
import { Sidebar } from './components/layout/Sidebar';
import { Topbar } from './components/layout/Topbar';
import { Statusbar } from './components/layout/Statusbar';
import { Toasts } from './components/Toast';
import { NewTaskModal } from './components/modals/NewTaskModal';
import { DirModal } from './components/modals/DirModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { HomeView } from './views/HomeView';
import { ProjectHomeView } from './views/ProjectHomeView';
import { KanbanView } from './views/KanbanView';
import { SessionView } from './views/SessionView';
import { SessionsView } from './views/SessionsView';
import { GraphView } from './views/GraphView';
import { KnowledgeBaseView } from './views/KnowledgeBaseView';
import { FilesView } from './views/FilesView';
import { TaskDetailDrawer } from './views/TaskDetailDrawer';
import { useUi, writeHash, type ViewId, type DrawerTab } from './store/ui';
import { useProjection, refreshTargets } from './store/projection';
import { EventsClient } from './api/events';
import type { IconName } from './components/icons';
import { Button } from './components/Button';
import { ExperimentView } from './views/ExperimentView';
import { MetricsView } from './views/MetricsView';
import { ApprovalsView } from './views/ApprovalsView';
import { SessionDetailView } from './views/SessionDetailView';

const VIEW_ITEMS: { id: ViewId; label: string; icon: IconName }[] = [
  { id: 'projhome', label: 'Home', icon: 'home' },
  { id: 'kanban', label: 'Board', icon: 'board' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'sessions', label: 'History', icon: 'chat' },
  { id: 'graph', label: 'Graph', icon: 'graph' },
  { id: 'kb', label: 'Knowledge', icon: 'kb' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'metrics', label: 'Metrics', icon: 'graph' },
  // Experiment (A/B control experiment) is hidden for now: the v2 migration shipped a simplified version (group B always empty, compare contract not aligned);
  // restore it once compareGroup/compareReport are completed —— just add this line back (the component/route/endpoint are all kept).
  // { id: 'experiment', label: 'Experiment', icon: 'graph' },
  { id: 'approvals', label: 'Approvals', icon: 'lock' },
];

/** Parse the hash (#pid=&view=&open=&tab= + theme, compatible with the prototype) */
function parseHash() {
  const h = (location.hash || '').slice(1);
  if (!h) return;
  const params: Record<string, string> = {};
  h.split('&').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  if (params.theme) useThemeStore.getState().setTheme(params.theme);
  const hashPid = params.pid;
  if (hashPid) {
    const view = params.view && VIEW_ITEMS.some((v) => v.id === params.view) ? (params.view as ViewId) : 'projhome';
    const tab = (['comments', 'brief', 'artifact', 'session', 'trajectory'].includes(params.tab || '')
      ? (params.tab === 'session' ? 'trajectory' : params.tab) : 'comments') as DrawerTab;
    useUi.getState().setRoute({ pid: hashPid, view, openId: params.open || null, tab, sessionId: params.t || null });
    const { pendingProjects } = useUi.getState();
    if (!pendingProjects[hashPid]) useProjection.getState().loadProject(hashPid);
  } else {
    useUi.getState().setRoute({ pid: null, view: 'home', openId: null, tab: 'comments', sessionId: null });
  }
}

function Toolbar({ pid }: { pid: string }) {
  const view = useUi((s) => s.view);
  const setView = (v: ViewId) => {
    useUi.getState().setRoute({ view: v, openId: null, tab: 'comments', sessionId: null });
    writeHash(pid, v, null, 'comments');
  };
  // Sliding pill indicator: measure the active button's position → absolutely positioned pill (CSS transition for an elastic slide)
  const listRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    const measure = () => {
      const list = listRef.current;
      const el = btnRefs.current[view];
      if (!list || !el) return;
      const lr = list.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      setPill({ left: er.left - lr.left, width: er.width });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (listRef.current) ro.observe(listRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [view]);
  return (
    <div className="toolbar">
      <div className="viewswitch" ref={listRef}>
        {pill ? (
          <span
            className="viewswitch-pill"
            style={{ left: pill.left, width: pill.width }}
            aria-hidden="true"
          />
        ) : null}
        {VIEW_ITEMS.map((v) => (
          <button
            key={v.id}
            ref={(el) => { btnRefs.current[v.id] = el; }}
            className={'btn' + (view === v.id ? ' active' : '')}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <span className="hint">Running / awaiting-confirmation cards are locked and can only be controlled through comments</span>
    </div>
  );
}

export default function App() {
  const sideOpen = useUi((s) => s.sideOpen);
  const pid = useUi((s) => s.pid);
  const view = useUi((s) => s.view);
  const openId = useUi((s) => s.openId);
  const sessionId = useUi((s) => s.sessionId);

  // Entering a project → fetch task details proactively (list/detail split: the list is lightweight; tasks load only for the active project)
  useEffect(() => {
    if (!pid) return;
    const { pendingProjects } = useUi.getState();
    if (!pendingProjects[pid]) useProjection.getState().loadProject(pid);
  }, [pid]);
  const revision = useProjection((s) => s.revision);
  const error = useProjection((s) => s.error);

  // Startup: initial fetch + direct hash navigation + WS subscription (exponential-backoff reconnect on disconnect; catch up by last_seq after reconnecting)
  useEffect(() => {
    const boot = async () => {
      await useProjection.getState().loadProjects();
      parseHash();
      const { pid: hp } = useUi.getState();
      if (hp) {
        const { pendingProjects } = useUi.getState();
        if (!pendingProjects[hp]) useProjection.getState().loadProject(hp);
      }
    };
    void boot();

    const client = new EventsClient({
      onEvent: (ev) => useProjection.getState().applyWsEvent(ev),
      onState: (s) => useProjection.getState().setConn(s),
      onReconnect: () => {
        const { pid: p2, openId: o2, view: v2 } = useUi.getState();
        refreshTargets(p2, o2, v2 === 'home');
        useUi.getState().toast('Reconnected · caught up via last_seq');
      },
    });
    client.connect();
    const onHash = () => parseHash();
    window.addEventListener('hashchange', onHash);
    return () => {
      client.close();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  // WS events (revision change) → debounced refresh of the current target (incremental catch-up; no loop: load* no longer bumps revision)
  useEffect(() => {
    if (revision === 0) return;
    const t = setTimeout(() => {
      const { pid: p2, openId: o2, view: v2 } = useUi.getState();
      refreshTargets(p2, o2, v2 === 'home');
    }, 400);
    return () => clearTimeout(t);
  }, [revision]);

  const home = view === 'home' || !pid;

  return (
    <ThemeProvider>
      <div className="app">
        <Atmosphere />
        <div id="approw" className={sideOpen ? '' : 'side-off'}>
          <Sidebar />
          <div id="stage">
            <Topbar />
            {pid ? <Toolbar pid={pid} /> : null}
            {error ? (
              <div className="toolbar" style={{ paddingTop: 0 }}>
                <div className="banner err" style={{ marginBottom: 0, flex: 1 }}>
                  {error}
                  <Button mini onClick={() => useProjection.getState().bump()} style={{ marginLeft: 10 }}>Retry</Button>
                </div>
              </div>
            ) : null}
            <main className="stage-main">
              {pid && sessionId ? <SessionDetailView pid={pid} sid={sessionId} /> : null}
              {!sessionId && home ? <HomeView /> : null}
              {!sessionId && pid && view === 'projhome' ? <ProjectHomeView pid={pid} /> : null}
              {!sessionId && pid && view === 'kanban' ? <KanbanView key={pid} pid={pid} /> : null}
              {!sessionId && pid && view === 'chat' ? <SessionView pid={pid} /> : null}
              {!sessionId && pid && view === 'sessions' ? <SessionsView pid={pid} /> : null}
              {!sessionId && pid && view === 'graph' ? <GraphView pid={pid} /> : null}
              {!sessionId && pid && view === 'kb' ? <KnowledgeBaseView pid={pid} /> : null}
              {pid && view === 'files' ? <FilesView pid={pid} /> : null}
              {pid && view === 'metrics' ? <MetricsView pid={pid} /> : null}
              {pid && view === 'experiment' ? <ExperimentView pid={pid} /> : null}
              {pid && view === 'approvals' ? <ApprovalsView pid={pid} /> : null}
              {openId && pid ? <TaskDetailDrawer pid={pid} cardId={openId} /> : null}
            </main>
          </div>
        </div>
        <Statusbar />
        <NewTaskModal />
        <DirModal />
        <SettingsModal />
        <Toasts />
      </div>
    </ThemeProvider>
  );
}