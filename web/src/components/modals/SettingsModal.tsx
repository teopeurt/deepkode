// Responsibility: settings modal —— general (theme) / presets (three-axis profile management, real API) / model / plugins / MCP / Skills.
// The presets tab really takes effect (listProfiles / setDefaultProfile / createProfile); the other tabs are read-only demos.
import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Switch } from '../Switch';
import { ThemePicker } from '../ThemePicker';
import { useUi } from '../../store/ui';
import {
  listProfiles, setDefaultProfile, createProfile, deleteProfile, profileSummary,
  MODE_LABEL, SETTING_LABEL, APPROVAL_LABEL, SANDBOX_LABEL,
  type Profile,
} from '../../api/client';

type TabId = 'general' | 'presets' | 'model' | 'plugins' | 'mcp' | 'skills';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'presets', label: 'Presets' },
  { id: 'model', label: 'Model' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
];

function SettingRow({ label, desc, children }: { label: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="lbl">{label}{desc ? <div className="desc">{desc}</div> : null}</div>
      {children}
    </div>
  );
}

/** Project settings tab (hot update): retrieval threshold / brief entry count —— written to storage for real, effective on the next assembly (no engine restart needed). */
function ProjectSettingsTab({ pid }: { pid: string }) {
  const toast = useUi((s) => s.toast);
  const [threshold, setThreshold] = useState<number>(0.15);
  const [entries, setEntries] = useState<number>(5);
  const [loaded, setLoaded] = useState(false);

  const load = () => {
    setLoaded(false);
    fetch(`/api/projects/${encodeURIComponent(pid)}/settings`)
      .then((r) => r.json())
      .then((d: { retrieval_threshold: number; brief_entries: number }) => {
        setThreshold(d.retrieval_threshold);
        setEntries(d.brief_entries);
        setLoaded(true);
      })
      .catch(() => { setLoaded(true); toast('Failed to read settings'); });
  };
  useEffect(load, [pid]);

  const save = async () => {
    const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retrieval_threshold: threshold, brief_entries: entries }),
    });
    toast(r.ok ? 'Saved · effective on the next task assembly (hot update, no restart needed)' : `Save failed (${r.status})`);
  };

  return (
    <div style={{ marginTop: 4 }}>
      <SettingRow label="Retrieval threshold" desc={`Knowledge-retrieval hit threshold (${threshold.toFixed(2)}) —— higher is stricter`}>
        <input
          type="range" min={0.05} max={0.9} step={0.05} value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          style={{ width: 140 }}
        />
        <span className="set-badge">{threshold.toFixed(2)}</span>
      </SettingRow>
      <SettingRow label="Brief entries" desc={`Maximum knowledge entries assembled into the brief (${entries}) —— more gives fuller context but costs more`}>
        <input
          type="range" min={1} max={10} step={1} value={entries}
          onChange={(e) => setEntries(Number(e.target.value))}
          style={{ width: 140 }}
        />
        <span className="set-badge">{entries}</span>
      </SettingRow>
      <div style={{ marginTop: 10 }}>
        <Button variant="primary" mini disabled={!loaded} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}

/** Preset management tab: profile list + three axes + set default + custom (§2.6 per-project management). */
function PresetTab({ pid }: { pid: string | null }) {
  const toast = useUi((s) => s.toast);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<Profile['mode']>('normal');
  const [setting, setSetting] = useState<Profile['setting']>('balanced');
  const [approval, setApproval] = useState<Profile['approval']>('ask');
  const [sandbox, setSandbox] = useState<Profile['sandbox']>('workspace-write');

  const load = () => {
    if (!pid) {
      setProfiles([]);
      return;
    }
    void listProfiles(pid).then(setProfiles).catch((e) => {
      setProfiles([]);
      toast(`Failed to load presets: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  useEffect(load, [pid]);

  const makeDefault = async (id: string) => {
    if (!pid) return;
    const ok = await setDefaultProfile(pid, id);
    toast(ok ? `Set "${profiles.find((p) => p.id === id)?.name ?? id}" as the project default` : 'Failed to set default');
    if (ok) load();
  };

  const create = async () => {
    if (!pid || !newId.trim() || !newName.trim()) { toast('id and name are required'); return; }
    const p = await createProfile(pid, { id: newId.trim(), name: newName.trim(), mode, setting, approval, sandbox });
    toast(p ? `Created preset "${p.name}"` : 'Creation failed (id conflict or bad format)');
    if (p) { setNewId(''); setNewName(''); load(); }
  };

  const remove = async (id: string, name: string) => {
    if (!pid) return;
    const ok = await deleteProfile(pid, id);
    toast(ok ? `Deleted "${name}"` : 'Delete failed (built-ins cannot be deleted)');
    if (ok) load();
  };

  return (
    <>
      <SettingRow label="Project presets (profiles)" desc="Three-axis combination = named preset; the first preset = the project default (§2.6)" />
      {!pid && <div className="desc" style={{ padding: '8px 0' }}>Open a project first; presets are stored per project.</div>}
      {pid && profiles.length === 0 && <div className="desc" style={{ padding: '8px 0' }}>This project has no presets yet (the four built-ins are written the first time it is opened).</div>}
      {profiles.map((p) => (
        <SettingRow key={p.id} label={`${p.name}${p.is_default ? ' ★' : ''}${p.is_builtin ? ' · built-in' : ''}`} desc={profileSummary(p)}>
          <span style={{ display: 'flex', gap: 6 }}>
            <Button mini variant="ghost" disabled={p.is_default} onClick={() => void makeDefault(p.id)} title={`Set "${p.name}" as default`}>Set default</Button>
            {!p.is_builtin && (
              <Button mini variant="ghost" onClick={() => void remove(p.id, p.name)} title={`Delete "${p.name}"`}>Delete</Button>
            )}
          </span>
        </SettingRow>
      ))}
      <div className="preset-custom">
        <div className="preset-custom-head">
          <span className="lbl">Custom preset</span>
          <span className="desc">Copy an existing three-axis combination into a new preset (built-ins cannot be overwritten; use a new id)</span>
        </div>
        <div className="preset-form">
          <div className="preset-form-row">
            <input placeholder="id (lowercase with hyphens, e.g. my-plan)" value={newId} onChange={(e) => setNewId(e.target.value)} />
            <input placeholder="Display name (e.g. My planning flow)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <div className="preset-axes">
            <select value={mode} onChange={(e) => setMode(e.target.value as Profile['mode'])} title="Collaboration mode">
              {(Object.keys(MODE_LABEL) as Profile['mode'][]).map((k) => <option key={k} value={k}>Mode · {MODE_LABEL[k]}</option>)}
            </select>
            <select value={setting} onChange={(e) => setSetting(e.target.value as Profile['setting'])} title="Execution setting">
              {(Object.keys(SETTING_LABEL) as Profile['setting'][]).map((k) => <option key={k} value={k}>Setting · {SETTING_LABEL[k]}</option>)}
            </select>
            <select value={approval} onChange={(e) => setApproval(e.target.value as Profile['approval'])} title="Approval posture">
              {(Object.keys(APPROVAL_LABEL) as Profile['approval'][]).map((k) => <option key={k} value={k}>Approval · {APPROVAL_LABEL[k]}</option>)}
            </select>
            <select value={sandbox} onChange={(e) => setSandbox(e.target.value as Profile['sandbox'])} title="Sandbox">
              {(Object.keys(SANDBOX_LABEL) as Profile['sandbox'][]).map((k) => <option key={k} value={k}>Sandbox · {SANDBOX_LABEL[k]}</option>)}
            </select>
            <Button mini variant="primary" onClick={() => void create()}>Create preset</Button>
          </div>
        </div>
      </div>
    </>
  );
}

export function SettingsModal() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const pid = useUi((s) => s.pid);
  const toast = useUi((s) => s.toast);
  const [tab, setTab] = useState<TabId>('general');

  const body = (() => {
    if (tab === 'general') return (
      <>
        <ThemePicker />
        {pid ? (
          <div className="set-row" style={{ marginTop: 14, display: 'block' }}>
            <div className="lbl">Project settings<div className="desc">Retrieval and assembly (hot update · per project)</div></div>
            <ProjectSettingsTab pid={pid} />
          </div>
        ) : null}
      </>
    );
    if (tab === 'presets') return <PresetTab pid={pid} />;
    if (tab === 'model') return (
      <>
        <SettingRow label="Default tiering" desc="Hard turns are upgraded to pro automatically (§6.3 · target contract)">
          <select defaultValue="auto"><option>flash</option><option>auto</option><option>pro</option></select>
        </SettingRow>
        <SettingRow label="Upgrade threshold" desc="Upgrade the remaining turns after ≥ N failure signals">
          <input type="number" defaultValue={3} min={1} max={10} />
        </SettingRow>
        <SettingRow label="Price table (peak/off-peak)" desc="Peak (Beijing 9-12/14-18) Flash input ¥3 / output ¥9 / cache hit ¥0.1 · off-peak half price (per M tokens)" />
      </>
    );
    if (tab === 'plugins') return (
      <>
        {[
          ['Knowledge base', 'SQLite bitemporal edge invalidation + retrieval'],
          ['Task orchestration', 'DAG scheduling · topological execution · partial reruns'],
          ['Execution economics', 'cache-first prefix partitioning · cost metering'],
          ['Tool repair', 'scavenge / truncation / flatten'],
        ].map(([name, desc]) => (
          <SettingRow key={name} label={name} desc={desc}>
            <Switch checked onChange={() => toast('Plugin toggles are a target contract (not enabled in P0)')} />
          </SettingRow>
        ))}
      </>
    );
    if (tab === 'mcp') return (
      <>
        {([
          ['github', 'Repository and PR operations', 12],
          ['filesystem', 'Local file read/write', 8],
        ] as [string, string, number][]).map(([name, desc, n]) => (
          <SettingRow key={name} label={name} desc={desc}>
            <span className={'set-badge ' + (n ? 'on' : 'off')}>{n} tools</span>
          </SettingRow>
        ))}
        <div className="set-add">
          <Button mini onClick={() => toast('Adding an MCP server = target contract (not enabled in P0)')}>Add MCP server</Button>
        </div>
      </>
    );
    return (
      <>
        {['find-skills', 'gitnexus-cli', 'dsh-prose-standard'].map((name) => (
          <SettingRow key={name} label={name} desc="Target contract · not enabled in P0">
            <Switch checked onChange={() => toast('Skills toggles are a target contract (not enabled in P0)')} />
          </SettingRow>
        ))}
      </>
    );
  })();

  return (
    <Modal open={open} onClose={() => setOpen(false)} wide>
      <div className="set-head">
        <h3>Settings</h3>
        <Button variant="quiet" mini onClick={() => setOpen(false)}>Close</Button>
      </div>
      <div className="set-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={'set-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="set-body">{body}</div>
    </Modal>
  );
}