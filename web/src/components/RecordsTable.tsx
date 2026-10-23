// Responsibility: records table (port of Beautiful UI's "Records Table", MIT © Shane Levine) ——
//   CRM-style grid: sortable columns + tags + selected row. Display only; sorting lives in the component, row clicks are passed up.
import { useMemo, useState, type ReactNode } from 'react';

export interface RecordsCol<T> {
  key: string;
  label: string;
  width?: string;
  /** If provided, the column header can be clicked to sort */
  sort?: (a: T, b: T) => number;
  cell: (row: T) => ReactNode;
}

interface Props<T> {
  columns: RecordsCol<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selectedKey?: string | null;
  onRow?: (row: T) => void;
  footer?: ReactNode;
  empty?: ReactNode;
}

export function RecordsTable<T>({ columns, rows, rowKey, selectedKey, onRow, footer, empty }: Props<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);

  const shown = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return rows;
    const copy = [...rows];
    copy.sort((a, b) => col.sort!(a, b) * dir);
    return copy;
  }, [rows, columns, sortKey, dir]);

  const toggle = (key: string, sortable: boolean) => {
    if (!sortable) return;
    if (sortKey === key) setDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setDir(1); }
  };

  return (
    <div className="rtable">
      <table>
        <colgroup>
          {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.sort ? 'sort' : undefined}
                aria-sort={sortKey === c.key ? (dir === 1 ? 'ascending' : 'descending') : undefined}
                onClick={() => toggle(c.key, !!c.sort)}
              >
                {c.label}
                {c.sort ? <span className="rtable-caret">{sortKey === c.key ? (dir === 1 ? '↑' : '↓') : ''}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="rtable-empty">{empty ?? 'No records'}</td>
            </tr>
          ) : shown.map((row) => {
            const id = rowKey(row);
            return (
              <tr
                key={id}
                className={(onRow ? 'hit' : '') + (selectedKey === id ? ' sel' : '')}
                onClick={onRow ? () => onRow(row) : undefined}
              >
                {columns.map((c) => <td key={c.key}>{c.cell(row)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {footer ? <div className="rtable-foot">{footer}</div> : null}
    </div>
  );
}
