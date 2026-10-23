// Responsibility: remove-project confirmation dialog —— two levels: remove only (recoverable; sessions archived + restored on re-import) /
// full cleanup (deletes helmsman-side sessions and records). The user's project directory/files are never touched in either mode.
import { useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { useUi, writeHash } from '../../store/ui';
import { useProjection } from '../../store/projection';

export function RemoveProjectModal({ pid, name, onClose }: { pid: string; name: string; onClose: () => void }) {
  const removeProject = useProjection((s) => s.removeProject);
  const removePending = useUi((s) => s.removePendingProject);
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState<'archive' | 'purge' | null>(null);

  const doRemove = async (mode: 'archive' | 'purge') => {
    if (busy) return;
    setBusy(mode);
    const ok = await removeProject(pid, mode);
    setBusy(null);
    if (ok) {
      removePending(pid);
      toast(mode === 'archive' ? 'Removed (recoverable) · re-import the same directory to get it back' : 'Fully cleaned up');
      onClose();
      useUi.getState().setRoute({ pid: null, view: 'home', openId: null, tab: 'comments', sessionId: null });
      writeHash(null, 'home', null, 'comments');
    } else {
      toast('Removal failed');
    }
  };

  return (
    <Modal open onClose={onClose} wide>
      <div className="set-head">
        <h3>Remove project · {name}</h3>
        <Button variant="quiet" mini onClick={onClose}>Cancel</Button>
      </div>
      <div className="set-body">
        <div className="note" style={{ marginBottom: 12 }}>
          Neither mode <b>deletes your project directory or files</b>; only helmsman-side data (task records, session logs, settings) is affected.
        </div>
        <div className="set-row">
          <div className="lbl">
            Remove only (recoverable)
            <div className="desc">Removed from the workspace; task sessions are archived and kept, and re-importing the same directory later restores them automatically</div>
          </div>
          <Button variant="primary" mini disabled={busy !== null} onClick={() => void doRemove('archive')}>
            {busy === 'archive' ? 'Removing…' : 'Remove only'}
          </Button>
        </div>
        <div className="set-row">
          <div className="lbl">
            Full cleanup
            <div className="desc">Deletes helmsman-side session logs and records; cannot be undone</div>
          </div>
          <Button variant="ghost" mini disabled={busy !== null} onClick={() => void doRemove('purge')} style={{ color: 'var(--red)' }}>
            {busy === 'purge' ? 'Cleaning up…' : 'Full cleanup'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
