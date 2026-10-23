// Responsibility: new-project modal —— "Choose directory…" calls the server's POST /api/fs/pick (osascript opens the native "choose folder"
// dialog) and the server returns the absolute path directly → path + project name are filled in automatically → create. No enumeration, no reverse lookup, no browser-upload semantics.
// Path and project name can both be edited by hand (fallback); offline / failed registration falls back to pending (persisted).
import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { useUi, writeHash } from '../../store/ui';
import { useProjection } from '../../store/projection';
import { pickFs } from '../../api/client';
import { Icon } from '../icons';

function baseName(path: string): string {
  const p = path.trim().replace(/\/+$/, '');
  return p.split('/').filter(Boolean).pop() || p;
}

export function DirModal() {
  const open = useUi((s) => s.dirOpen);
  const setOpen = useUi((s) => s.setDirOpen);
  const addPending = useUi((s) => s.addPendingProject);
  const removePending = useUi((s) => s.removePendingProject);
  const pending = useUi((s) => s.pendingProjects);
  const toast = useUi((s) => s.toast);
  const registerProject = useProjection((s) => s.registerProject);
  const projects = useProjection((s) => s.projects);
  const conn = useProjection((s) => s.conn);

  const [pathInput, setPathInput] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [nameEdited, setNameEdited] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusy(false); setName(''); setPathInput(''); setNameEdited(false);
  }, [open]);

  // Native "choose folder" dialog (opened by the server, returns the absolute path directly)
  const pickDir = async () => {
    setPicking(true);
    try {
      const r = await pickFs();
      if (r.cancelled) return;
      if (r.path) {
        setPathInput(r.path);
        if (!nameEdited) setName(baseName(r.path));
        toast('Selected: ' + r.path);
      }
    } catch (e) {
      toast('Could not open the directory picker: ' + (e instanceof Error ? e.message : String(e)).slice(0, 80));
    } finally {
      setPicking(false);
    }
  };

  const enter = (id: string, n: string, p: string) => {
    setOpen(false);
    useUi.getState().setRoute({ pid: id, view: 'projhome', openId: null, tab: 'comments', sessionId: null });
    writeHash(id, 'projhome', null, 'comments');
    void n; void p;
  };

  const create = async () => {
    const p = pathInput.trim();
    const n = name.trim() || baseName(p);
    if (!p || busy) return;
    setBusy(true);

    const existing = Object.values(projects).find((x) => x.name === n || x.path === p);
    if (existing) {
      removePending(existing.id);
      setBusy(false);
      toast('Project already exists, opening it');
      enter(existing.id, existing.name, existing.path);
      return;
    }
    if (conn === 'online') {
      const proj = await registerProject(p, n);
      if (proj) {
        setBusy(false);
        removePending(proj.id);
        toast('Project created');
        enter(proj.id, proj.name, proj.path);
        return;
      }
    }
    const id = n.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, '-') || 'project';
    addPending(id, n, p);
    setBusy(false);
    toast(conn === 'online' ? 'Registration failed · saved as a project pending registration' : 'Offline · saved; it will be registered when you create a card');
    enter(id, n, p);
  };

  const existingIds = new Set(Object.values(projects).map((p) => p.id));
  const pendingList = Object.values(pending).filter((p) => !existingIds.has(p.id));

  return (
    <Modal open={open} onClose={() => setOpen(false)} wide>
      <div className="set-head">
        <h3>New project</h3>
        <Button variant="quiet" mini onClick={() => setOpen(false)}>Close</Button>
      </div>
      <div className="set-body">
        <div className="field">
          <label>Choose project directory</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="primary" onClick={() => void pickDir()} disabled={picking}>
              <Icon name="folder" size="sm" />{picking ? 'Waiting for selection…' : 'Choose directory…'}
            </Button>
            <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>Opens the native "choose folder" dialog</span>
          </div>
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <label>Directory path (filled in after choosing · editable)</label>
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="Filled in after choosing a directory, or type it manually"
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          />
        </div>
        <div className="field">
          <label>Project name (defaults to the directory name)</label>
          <input
            value={name}
            onChange={(e) => { setNameEdited(true); setName(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          />
        </div>
        {pendingList.length ? (
          <div className="note" style={{ marginTop: 8 }}>
            Pending registration: {pendingList.map((p) => <span key={p.id} className="linkchip" onClick={() => enter(p.id, p.name, p.path)}>{p.name}</span>)}
          </div>
        ) : null}
        <div className="modal-actions" style={{ marginTop: 14 }}>
          <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={!pathInput.trim() || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
