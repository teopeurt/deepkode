// Responsibility: Topbar —— sidebar collapse button + logo + breadcrumbs + connection dot + new card / run all (inside a project).
// Connection dot: online green / disconnected·reconnecting orange (blinking) / offline gray; control actions (new card) are disabled while disconnected.
import { useUi, writeHash } from '../../store/ui';
import { useProjection } from '../../store/projection';
import { Icon } from '../icons';
import { Button } from '../Button';

const VIEW_LABEL: Record<string, string> = {
  projhome: 'Home', kanban: 'Board', chat: 'Chat',
  sessions: 'History', graph: 'Graph', kb: 'Knowledge', files: 'Files', metrics: 'Metrics',
};

export function Topbar() {
  const pid = useUi((s) => s.pid);
  const view = useUi((s) => s.view);
  const toggleSide = useUi((s) => s.toggleSide);
  const setNewTaskOpen = useUi((s) => s.setNewTaskOpen);
  const projects = useProjection((s) => s.projects);
  const conn = useProjection((s) => s.conn);
  const pending = useUi((s) => s.pendingProjects);
  const toast = useUi((s) => s.toast);

  const inProject = !!pid;
  const proj = pid ? projects[pid] ?? pending[pid] : null;
  const online = conn === 'online';

  const connText = conn === 'online' ? `Service online · ${Object.keys(projects).length} projects` : conn === 'reconnect' ? 'Disconnected · reconnecting' : 'Service unreachable';

  const breadcrumb = !inProject ? (
    <b>Workspace</b>
  ) : (
    <>
      <a
        onClick={() => {
          useUi.getState().setRoute({ pid: null, view: 'home', openId: null, tab: 'comments', sessionId: null });
          writeHash(null, 'home', null, 'comments');
        }}
      >
        Projects
      </a>
      <span className="sep">/</span>
      <b>{proj?.name ?? pid}</b>
      {view !== 'projhome' && view !== 'home' ? (
        <>
          <span className="sep">/</span>
          <span>{VIEW_LABEL[view]}</span>
        </>
      ) : null}
    </>
  );

  return (
    <header className="topbar">
      <Button variant="icon" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={toggleSide}>
        <Icon name="side" size="sm" />
      </Button>
      {/* No logo inside a project: the breadcrumb's "Projects" already returns to the workspace, so logo and breadcrumb don't duplicate each other */}
      <div id="breadcrumb">{breadcrumb}</div>
      <div className="spacer" />
      <div id="conn" data-state={conn}>
        <span className="dot" />
        <span id="conn-text">{connText}</span>
      </div>
      {inProject ? (
        <>
          <Button
            className={inProject ? '' : 'hidden'}
            disabled={!online}
            title={online ? undefined : 'Control actions are disabled while disconnected'}
            onClick={() => {
              if (!pid) return;
              useUi.getState().setRoute({ openId: null, sessionId: null });
              setNewTaskOpen(true);
            }}
          >
            <Icon name="plus" size="sm" />New card
          </Button>
          <Button variant="primary" className={inProject ? '' : 'hidden'} disabled={!online} onClick={() => {
            toast('New tasks run automatically on creation; click here to refresh if there are no new tasks');
            useProjection.getState().bump();
          }}>
            <Icon name="play" size="sm" />Run all
          </Button>
        </>
      ) : null}
    </header>
  );
}