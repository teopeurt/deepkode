// Responsibility: knowledge base —— records table + detail (knowledge debt: injected but unused / used but still failed).
// Records table: port of Beautiful UI's "Records Table" (MIT © Shane Levine) —— tags / sorting / relationship strength.
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';
import { Button } from '../components/Button';
import { RecordsTable } from '../components/RecordsTable';
import { Markdown } from '../components/Markdown';
import { LoadingState } from '../components/LoadingState';
import { invalidateKbNote, listKbNotes, searchKbNotes, setKbNoteStable, type DebtStatus, type KbNoteRow } from '../api/client';
import { relTime } from '../store/projection';

function isPinned(n: KbNoteRow): boolean {
  return (n.tags ?? []).some((t) => t.toLowerCase() === 'stable');
}

/** Friendly source labels (for the table column + detail) */
const SOURCE_LABEL: Record<string, string> = {
  task: 'Task capture',
  subagent: 'Subagent',
  human: 'Manual entry',
  project: 'Project',
};

const TRUST_LABEL: Record<KbNoteRow['trust'], string> = {
  'human-approved': 'Human-confirmed',
  'agent-generated': 'Auto-captured',
  unverified: 'Unverified',
};

const STRENGTH: Record<DebtStatus, { id: string; label: string }> = {
  useful: { id: 'strong', label: 'Strong' },
  idle: { id: 'weak', label: 'Observing' },
  unused: { id: 'none', label: 'Never cited' },
  toxic: { id: 'toxic', label: 'Harmful' },
};

/** Strength order (for sorting): never cited < harmful < observing < strong */
const STRENGTH_ORDER: Record<DebtStatus, number> = { unused: 0, toxic: 1, idle: 2, useful: 3 };

type Filter = 'valid' | 'unused' | 'toxic';

function strengthOf(n: KbNoteRow): { id: string; label: string } {
  return n.debt ? STRENGTH[n.debt.status] : { id: 'weak', label: '—' };
}

export function KnowledgeBaseView({ pid }: { pid: string }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('valid');
  const [notes, setNotes] = useState<KbNoteRow[]>([]);
  const [selected, setSelected] = useState<KbNoteRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      // M4: search uses server-side fused retrieval (keyword/summary/tag hits + ranking + debt demotion), no client-side substring fallback
      if (query && query.trim()) {
        setNotes(await searchKbNotes(pid, query.trim()));
      } else {
        setNotes(await listKbNotes(pid));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [pid]);

  useEffect(() => {
    const t = setTimeout(() => void load(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const unusedCount = notes.filter((n) => n.debt?.status === 'unused').length;
  const toxicCount = notes.filter((n) => n.debt?.status === 'toxic').length;
  // Overview stats at the top
  const totalCount = notes.length;
  const pinnedCount = notes.filter(isPinned).length;
  const srcCounts = notes.reduce<Record<string, number>>((acc, n) => {
    acc[n.source.kind] = (acc[n.source.kind] ?? 0) + 1;
    return acc;
  }, {});
  const visible = notes.filter((n) => {
    if (n.validUntil !== null) return false;
    if (filter === 'unused') return n.debt?.status === 'unused';
    if (filter === 'toxic') return n.debt?.status === 'toxic';
    return true;
  });

  const mute = async (id: string) => {
    setBusy(true);
    try {
      if (await invalidateKbNote(id)) {
        setSelected(null);
        await load(q);
      }
    } finally {
      setBusy(false);
    }
  };

  const pin = async (n: KbNoteRow, pinned: boolean) => {
    setBusy(true);
    try {
      const updated = await setKbNoteStable(n.id, pinned);
      if (updated) {
        setSelected({ ...n, ...updated, debt: n.debt });
        await load(q);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="kbview">
      <div className="ph-head">
        <h1>Knowledge base</h1>
        <div className="ph-path">
          Automatic task capture · manual entry · stable prefix · invalidation audit —— bitemporal evolution (version / valid_until)
        </div>
      </div>
      <div className="kb-bar">
        <div className="search">
          <Icon name="search" size="sm" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the knowledge base…" aria-label="Search the knowledge base" />
        </div>
        <div className="filters">
          <button className={'chip' + (filter === 'valid' ? ' active' : '')} onClick={() => setFilter('valid')}>Valid</button>
          <button className={'chip' + (filter === 'unused' ? ' active' : '')} onClick={() => setFilter('unused')}>Never cited{unusedCount ? ` ${unusedCount}` : ''}</button>
          <button className={'chip' + (filter === 'toxic' ? ' active' : '')} onClick={() => setFilter('toxic')}>Possibly toxic{toxicCount ? ` ${toxicCount}` : ''}</button>
        </div>
        <div className="kb-stats">
          <span className="kb-stat">{totalCount} entries</span>
          <span className="kb-stat">📌 {pinnedCount}</span>
          {Object.entries(srcCounts).map(([k, c]) => (
            <span key={k} className="kb-stat muted">{SOURCE_LABEL[k] ?? k} {c}</span>
          ))}
        </div>
      </div>
      <div className="kb-body">
        <div className="kb-grid">
          {error ? (
            <div className="empty-state"><div className="t">Failed to load</div><div className="d">{error}</div></div>
          ) : loading && notes.length === 0 ? (
            <div className="empty-state"><LoadingState variant="surfer" label="Loading knowledge base…" /></div>
          ) : (
            <RecordsTable
              rows={visible}
              rowKey={(n) => n.id}
              selectedKey={selected?.id}
              onRow={setSelected}
              empty={(
                <div className="empty-state">
                  <Icon name="kb" />
                  <div className="t">{filter === 'valid' ? 'The knowledge base is empty' : 'No notes of this kind'}</div>
                  <div className="d">{filter === 'valid' ? 'When tasks complete, their conclusions are captured here automatically. To put something at the start of every card, open the note and click "Pin to stable prefix".' : 'Debt only shows up after a note has been assembled a few times'}</div>
                </div>
              )}
              footer={<>{visible.length} entries · {unusedCount} never cited · {toxicCount} possibly toxic</>}
              columns={[
                {
                  key: 'title',
                  label: 'Note',
                  width: '28%',
                  sort: (a, b) => a.title.localeCompare(b.title, 'zh'),
                  cell: (n) => <span className="rtable-name">{n.title}</span>,
                },
                {
                  key: 'tags',
                  label: 'Tags',
                  width: '22%',
                  cell: (n) => (
                    <span className="rtable-tags">
                      <span className={'trust trust-' + n.trust}>{TRUST_LABEL[n.trust]}</span>
                      {isPinned(n) && <span className="trust trust-human-approved">Stable prefix</span>}
                      {n.tags.slice(0, 3).map((t) => <span key={t} className="tag">#{t}</span>)}
                    </span>
                  ),
                },
                {
                  key: 'when',
                  label: 'Recent',
                  width: '14%',
                  sort: (a, b) => a.validFrom - b.validFrom,
                  cell: (n) => relTime(n.validFrom),
                },
                {
                  key: 'str',
                  label: 'Strength',
                  width: '14%',
                  sort: (a, b) => (a.debt ? STRENGTH_ORDER[a.debt.status] : 2) - (b.debt ? STRENGTH_ORDER[b.debt.status] : 2),
                  cell: (n) => {
                    const s = strengthOf(n);
                    return <span className={'rtable-str ' + s.id}>{s.label}</span>;
                  },
                },
                {
                  key: 'src',
                  label: 'Source',
                  width: '22%',
                  cell: (n) => (
                    <span className="rtable-src">
                      {SOURCE_LABEL[n.source.kind] ?? n.source.kind}
                      {n.source.ref && n.source.ref !== n.source.kind ? ` · ${n.source.ref}` : ''}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </div>
        {selected && (
        <div className="kb-main">
            <div className="note">
              <h3>{selected.title}</h3>
              <div className="note-meta">
                <span className={'trust trust-' + selected.trust}>{TRUST_LABEL[selected.trust]}</span>
                {isPinned(selected) && <span className="trust trust-human-approved">Stable prefix</span>}
                <span className="muted">Source: {SOURCE_LABEL[selected.source.kind] ?? selected.source.kind} · {new Date(selected.validFrom).toLocaleString()}</span>
              </div>
              {selected.debt && (
                <div className={'banner' + (selected.debt.status === 'toxic' ? ' warn' : selected.debt.status === 'unused' ? '' : ' ok')} style={{ marginTop: 12 }}>
                  Assembled {selected.debt.injected} times · cited {selected.debt.cited} times
                  {selected.debt.failedWhenCited > 0 ? ` · failed after citing ${selected.debt.failedWhenCited}` : ''}
                  {selected.debt.status === 'unused' ? ' —— it was injected but no tool/output ever touched it' : ''}
                  {selected.debt.status === 'toxic' ? ' —— tasks fail more often after using it' : ''}
                </div>
              )}
              <div className="note-content"><Markdown text={selected.content.join('\n\n')} /></div>
              {selected.keywords.length > 0 && (
                <div className="note-keywords">{selected.keywords.map((k) => <span key={k} className="tag">{k}</span>)}</div>
              )}
              {selected.applicability ? (
                <div className="note-applicability">Applies when: {selected.applicability}</div>
              ) : null}
              {selected.antiPatterns && selected.antiPatterns.length > 0 ? (
                <div className="note-antipatterns">
                  <div className="t">Avoid / anti-patterns</div>
                  <ul>{selected.antiPatterns.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </div>
              ) : null}
              {selected.validUntil === null && (
                <div style={{ marginTop: 18, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="ghost" mini disabled={busy} onClick={() => void pin(selected, !isPinned(selected))}>
                    {isPinned(selected) ? 'Unpin from stable prefix' : 'Pin to stable prefix'}
                  </Button>
                  <Button variant="plain" mini disabled={busy} onClick={() => void mute(selected.id)}>
                    Stop assembling
                  </Button>
                </div>
              )}
            </div>
        </div>
        )}
      </div>
    </div>
  );
}
