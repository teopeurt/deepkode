// Responsibility: session history —— a list of every execution (= session) in the project, fixing the "black box": card title / status / time / model / turns / cost at a glance;
// click to open the detail drawer (trajectory tab by default). M2.3: executions hang off cards (1 card N executions); the list flattens all execution generations.
// SearchBox + Filter Table at the top (ported from Beautiful UI): after keyword filtering, the status chips regroup the table.
import { useState } from 'react';
import { useUi, writeHash, openSession } from '../store/ui';
import { useProjection, effectiveStatus, estCost, relTime, activityText, type TaskState } from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { EmptyState } from '../components/EmptyState';
import { SearchBox } from '../components/SearchBox';
import { FilterTable } from '../components/FilterTable';

type Row = { t: TaskState; cardId: string | null; cardTitle: string };

const CHIPS = [
  { id: 'all', label: 'All' },
  { id: 'Running', label: 'Running' },
  { id: 'Waiting', label: 'Awaiting approval' },
  { id: 'Pending', label: 'To do' },
  { id: 'Failed', label: 'Failed' },
  { id: 'Done', label: 'Done' },
  { id: 'Cancelled', label: 'Cancelled' },
];

export function SessionsView({ pid }: { pid: string }) {
  const cards = useProjection((s) => s.cards[pid] || {});
  const chats = useProjection((s) => s.chats[pid] || {});
  const usage = useProjection((s) => s.usage);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('all');

  // Flatten all sessions: card executions + simple chats (standalone, not on the board)
  const rows: Row[] = [];
  Object.values(cards).forEach((c) => {
    Object.values(c.executions).forEach((t) => rows.push({ t, cardId: c.id, cardTitle: c.title }));
  });
  Object.values(chats).forEach((t) => rows.push({ t, cardId: null, cardTitle: 'Simple chat' }));
  const list = rows.sort((a, b) => (b.t.started_at ?? 0) - (a.t.started_at ?? 0));

  const match = (row: Row, query: string): boolean => {
    const { t } = row;
    const hay = [
      row.cardTitle, t.title, t.model, effectiveStatus(t), t.id,
      t.activities.length ? activityText(t.activities[t.activities.length - 1]) : '',
    ].filter(Boolean).join(' ').toLowerCase();
    return query.toLowerCase().split(/\s+/).every((k) => hay.includes(k));
  };

  const searched = q.trim() ? list.filter((row) => match(row, q.trim())) : list;

  const open = (row: Row) => {
    if (!row.cardId) {
      openSession(pid, row.t.id, 'sessions', null);
      return;
    }
    useUi.getState().setRoute({ openId: row.cardId, tab: 'trajectory' });
    writeHash(pid, 'sessions', row.cardId, 'trajectory');
  };

  return (
    <div id="chatview" style={{ overflowY: 'auto', padding: '24px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div className="ph-head">
          <h1>Session history</h1>
          <div className="ph-path">All executions in this project (1 card N executions · a session is an execution) · {list.length} total</div>
        </div>

        <div style={{ marginTop: 16 }}>
          <SearchBox
            bare
            placeholder="Search sessions (title / model / status / session id)…"
            value={q}
            onValue={(v) => { setQ(v); setChip('all'); }}
          />
        </div>

        <div className="home-sec" style={{ marginTop: 16, padding: 0, overflow: 'hidden' }}>
          {list.length === 0 ? (
            <div style={{ padding: 16 }}>
              <EmptyState icon="chat" title="No sessions yet" desc="Creating a card (board → “+ New card”) creates its first execution, which the engine runs automatically; you can fork more generations" />
            </div>
          ) : (
            <FilterTable
              chips={CHIPS}
              value={chip}
              onChange={setChip}
              chipOf={(row) => effectiveStatus(row.t)}
              rows={searched}
              rowKey={(row) => row.t.id}
              onRow={open}
              empty={<EmptyState icon="search" title="No matching sessions" desc="Try a different keyword or status" />}
              columns={[
                {
                  key: 'name',
                  label: 'Task',
                  cell: (row) => (
                    <span className="ftable-name">{row.cardTitle || row.t.title || row.t.id.slice(0, 16)}</span>
                  ),
                },
                {
                  key: 'when',
                  label: 'Time',
                  width: '18%',
                  cell: (row) => relTime(row.t.started_at),
                },
                {
                  key: 'st',
                  label: 'Status',
                  width: '16%',
                  cell: (row) => <StatusPill status={effectiveStatus(row.t)} />,
                },
                {
                  key: 'meta',
                  label: 'Model',
                  width: '28%',
                  cell: (row) => {
                    const cost = estCost(usage[row.t.id], row.t.model);
                    return (
                      <span className="ftable-meta">
                        {row.t.model || '—'} · {row.t.turns} turns
                        {cost != null ? ` · ¥${cost.toFixed(4)}` : ''}
                      </span>
                    );
                  },
                },
              ]}
            />
          )}
        </div>
      </div>
    </div>
  );
}
