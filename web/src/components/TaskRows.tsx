// Responsibility: task rows (port of Beautiful UI's "Task Rows", MIT © Shane Levine) ——
//   live status rows: status icon (done = check / running = spinning progress ring + number / failed = cross) + title + secondary info + status pill + expandable details.
//   Clicking the row header: expands/collapses if there are details; otherwise triggers onClick (e.g. opens the detail drawer).
import { useState } from 'react';

export type TaskRowStatus = 'running' | 'failed' | 'completed';

export interface TaskRowDetail {
  label: string;
  value: string;
}

export interface TaskRowItem {
  id: string | number;
  title: string;
  status: TaskRowStatus;
  /** Secondary info on the right (e.g. execution count / vendor count) */
  meta?: string;
  /** Status pill text; defaults by status (Running / Failed / Done) */
  pill?: string;
  /** Number in the center of the running ring (e.g. steps used) */
  progress?: number;
  /** Expandable details (clicking the row header = expand/collapse) */
  detail?: TaskRowDetail[];
  onClick?: () => void;
}

const PILL_CLS: Record<TaskRowStatus, string> = { running: 'Running', failed: 'Failed', completed: 'Done' };
const PILL_LABEL: Record<TaskRowStatus, string> = { running: 'Running', failed: 'Failed', completed: 'Done' };

function StatusIcon({ status, progress }: { status: TaskRowStatus; progress?: number }) {
  if (status === 'completed') {
    return (
      <span className="taskrow-ic done">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="taskrow-ic fail">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </span>
    );
  }
  return (
    <span className="taskrow-ic run">
      <span className="ring">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="none" stroke="var(--line)" strokeWidth="2" />
          <circle cx="12" cy="12" r="11" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeDasharray="19 50" />
        </svg>
        <b>{progress ?? '…'}</b>
      </span>
    </span>
  );
}

export function TaskRows({ items }: { items: TaskRowItem[] }) {
  return (
    <div className="taskrows">
      {items.map((it) => (
        <TaskRow key={it.id} item={it} />
      ))}
    </div>
  );
}

function TaskRow({ item: it }: { item: TaskRowItem }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!it.detail?.length;
  return (
    <div className={'taskrow' + (open ? ' open' : '')}>
      <button
        type="button"
        className="taskrow-head"
        aria-expanded={hasDetail ? open : undefined}
        onClick={() => (hasDetail ? setOpen((v) => !v) : it.onClick?.())}
      >
        <StatusIcon status={it.status} progress={it.progress} />
        <span className="taskrow-title" title={it.title}>{it.title}</span>
        {it.meta ? <span className="taskrow-meta">{it.meta}</span> : null}
        <span className={'pill pill-' + PILL_CLS[it.status]}>{it.pill ?? PILL_LABEL[it.status]}</span>
        <svg className="taskrow-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {hasDetail ? (
        <div className="taskrow-body">
          <div className="taskrow-body-inner">
            <div className="taskrow-detail">
              <span className="line" />
              <div className="items">
                {it.detail!.map((d) => (
                  <div key={d.label} className="di">
                    <span>{d.label}</span>
                    <b>{d.value}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
