// Responsibility: new-card modal (M2.3, O1=B) —— card = asset: goal (one sentence) + type (requirement/defect/task) +
// requirement description (card description) + milestone (attribute, P1 filtering) + notes + preset profile (three-axis combination) +
// dependencies (target contract taskgraph: cards that must be completed before this one).
// POST /api/projects/:pid/cards {title, description, kind, milestone, preset_id, deps}: creating a card automatically runs its first execution.
import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { useUi } from '../../store/ui';
import { useProjection, cardStatus, latestExecution, isPeakHour } from '../../store/projection';
import { listProfiles, MODE_LABEL, SETTING_LABEL, APPROVAL_LABEL, SANDBOX_LABEL, type Profile } from '../../api/client';
import { StatusPill } from '../StatusPill';

const KINDS: { value: string; label: string }[] = [
  { value: 'requirement', label: 'Requirement' },
  { value: 'bug', label: 'Defect' },
  { value: 'task', label: 'Task' },
];

export function NewTaskModal() {
  const open = useUi((s) => s.newTaskOpen);
  const setOpen = useUi((s) => s.setNewTaskOpen);
  const pid = useUi((s) => s.pid);
  const toast = useUi((s) => s.toast);
  const createCard = useProjection((s) => s.createCard);

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('task');
  const [presetId, setPresetId] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [description, setDescription] = useState('');
  const [milestone, setMilestone] = useState('');
  const [note, setNote] = useState('');
  const [depIds, setDepIds] = useState<string[]>([]);
  const [calibrate, setCalibrate] = useState(false);
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const peak = isPeakHour();
  const cards = useProjection((s) => (pid ? s.cards[pid] || {} : {}));
  // Completed cards don't block starting; checking them has no scheduling meaning, so they are left out of the list.
  const depOptions = Object.values(cards)
    .filter((c) => { const st = cardStatus(c); return st !== 'Done' && st !== 'Cancelled'; })
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  // §2.1 scheduling gate: if a selected dependency is unfinished → the card will be "waiting on upstream" and won't run automatically (it starts automatically once unblocked)
  const hasUnmetDep = depIds.some((d) => {
    const dc = cards[d];
    const le = dc ? latestExecution(dc) : null;
    return !le || cardStatus(dc) !== 'Done';
  });

  // Load the project's profiles when opening (the default is pre-selected —— visible to the user, §2.6 "pre-filled at card creation")
  useEffect(() => {
    if (!open || !pid) return;
    void listProfiles(pid).then((ps) => {
      setProfiles(ps);
      const def = ps.find((p) => p.is_default);
      setPresetId(def ? def.id : '');
    }).catch(() => setProfiles([]));
  }, [open, pid]);

  const submit = async () => {
    if (!pid || !title.trim() || busy) return;
    setBusy(true);
    // Notes are merged into the description (first context; card = asset, description = requirement description)
    const desc = note.trim() ? (description.trim() ? `${description.trim()}

Notes: ${note.trim()}` : `Notes: ${note.trim()}`) : description.trim();
    const cardId = await createCard(pid, {
      title: title.trim(),
      description: desc,
      kind,
      milestone: milestone.trim() || undefined,
      preset: presetId || undefined,
      deps: depIds.length ? depIds : undefined,
      calibrate: calibrate || undefined,
      budget: budget.trim() && Number(budget) > 0 ? Number(budget) : undefined,
    });
    setBusy(false);
    if (cardId) {
      toast(calibrate ? 'Card created; running requirement calibration first (AI proposes acceptance criteria → you confirm → then it runs)' : 'Card created; the engine runs its first execution automatically');
      setOpen(false);
      setTitle('');
      setKind('task');
      setDescription('');
      setMilestone('');
      setNote('');
      setDepIds([]);
      setCalibrate(false);
      setBudget('');
    } else {
      toast('Creation failed, see the error banner');
    }
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)}>
      <h3>New card (asset)</h3>
      <div className="field">
        <label>Goal</label>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Describe the requirement/defect in one sentence"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) submit(); }}
        />
      </div>
      <div className="field">
        <label>Type</label>
        <div className="kind-opts">
          {KINDS.map((k) => (
            <span
              key={k.value}
              className={'kind-opt' + (kind === k.value ? ' active' : '')}
              onClick={() => setKind(k.value)}
            >{k.label}</span>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Milestone (optional · P1 filter dimension; the attribute is stored now)</label>
        <input
          value={milestone}
          onChange={(e) => setMilestone(e.target.value)}
          placeholder="e.g. v0.2"
        />
      </div>
      <div className="field">
        <label>Preset profile (three-axis combination · policy is visible)</label>
        <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id} title={`${MODE_LABEL[p.mode]} · ${SETTING_LABEL[p.setting]} · ${APPROVAL_LABEL[p.approval]} · sandbox ${SANDBOX_LABEL[p.sandbox]}`}>
              {p.name}{p.is_default ? ' (default)' : ''}
            </option>
          ))}
        </select>
        <div className="ph-hint2" style={{ marginTop: 4 }}>Preset = collaboration mode × execution setting × approval posture · sandbox (hover an option for details; snapshotted when the execution starts and not changed).</div>
      </div>
      <div className="field">
        <label>Upstream (optional · which cards must finish before this one starts)</label>
        {depOptions.length === 0 ? (
          <div className="ph-hint2" style={{ padding: '6px 0' }}>
            {Object.keys(cards).length === 0
              ? 'The project has no cards yet —— create one first so later cards can wait on it.'
              : 'All existing cards are done; there is no upstream to wait on.'}
          </div>
        ) : (
          <div className="dep-pick">
            {depOptions.map((c) => {
              const st = cardStatus(c);
              const checked = depIds.includes(c.id);
              const name = (c.title || '').trim() || 'Untitled';
              const kind = KINDS.find((k) => k.value === c.kind)?.label ?? c.kind ?? 'Task';
              const blurb = (c.description || '').replace(/\s+/g, ' ').trim();
              return (
                <div
                  key={c.id}
                  className={'dep-pick-row' + (checked ? ' on' : '')}
                  onClick={() => setDepIds((prev) => (checked ? prev.filter((d) => d !== c.id) : [...prev, c.id]))}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    readOnly
                    tabIndex={-1}
                  />
                  <span className="dep-pick-text">
                    {name}
                    {c.milestone ? <span className="milestone-chip">{c.milestone}</span> : null}
                    <span className="dep-pick-meta"> · {kind}{blurb ? ` · ${blurb}` : ''}</span>
                  </span>
                  <StatusPill status={st as never} />
                </div>
              );
            })}
          </div>
        )}
        {hasUnmetDep ? (
          <div className="ph-hint2" style={{ marginTop: 4, color: 'var(--yellow)' }}>
            ⏳ A selected dependency is unfinished —— the card will be "waiting on upstream" and won't run automatically; it starts automatically when the upstream completes.
          </div>
        ) : null}
      </div>
      <div className="field">
        <label>Requirement description</label>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional: acceptance criteria / constraints / context (check calibration below to have the AI propose acceptance criteria)" />
      </div>
      <label className="calibrate-opt" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, margin: '4px 0 10px', cursor: 'pointer' }}>
        <input type="checkbox" checked={calibrate} onChange={(e) => setCalibrate(e.target.checked)} />
        <span>Calibrate the requirement first (D1.7): the AI explores and proposes acceptance criteria → you confirm → written back automatically → then it runs</span>
      </label>
      <div className="field">
        <label>Execution budget ¥ (optional · opt-in budget gate; overspending suspends it awaiting approval)</label>
        <input
          type="number" min="0" step="0.1"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="e.g. 1 (¥) —— overspend → Waiting{cost}; approve = accept the cost / reject = stop"
        />
        {peak ? (
          <div className="ph-hint2" style={{ marginTop: 4, color: 'var(--yellow)' }}>
            ⏰ It is currently peak hours (Beijing 9-12 / 14-18) —— cost ×2. If it isn't urgent, wait for off-peak hours.
          </div>
        ) : null}
      </div>
      <div className="field">
        <label>Notes (used as the first execution context)</label>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </div>
      <div className="modal-actions">
        <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" disabled={!title.trim() || busy} onClick={submit}>Create and run</Button>
      </div>
    </Modal>
  );
}
