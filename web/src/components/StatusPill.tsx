// Responsibility: status pill (pastel background + dark text, dot + label) —— semantic colors only express status.
import type { TaskStatus } from '../store/projection';

export type PillStatus = TaskStatus | 'Waiting';

export const ST_LABEL: Record<PillStatus, string> = {
  Pending: 'To do',
  Running: 'Running',
  Waiting: 'Awaiting approval',
  Done: 'Done',
  Failed: 'Failed',
  Cancelled: 'Cancelled',
};

export function StatusPill({ status, label }: { status: PillStatus; label?: string }) {
  return <span className={'pill pill-' + status}>{label ?? ST_LABEL[status]}</span>;
}
