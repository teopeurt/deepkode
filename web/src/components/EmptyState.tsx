// Responsibility: EmptyState —— icon + title + guidance text + optional action.
import type { ReactNode } from 'react';
import type { IconName } from './icons';
import { Icon } from './icons';

export function EmptyState({
  icon,
  title,
  desc,
  actions,
  style,
}: {
  icon: IconName;
  title: string;
  desc?: string;
  actions?: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="empty-state" style={style}>
      <Icon name={icon} />
      <div className="t">{title}</div>
      {desc ? <div className="d">{desc}</div> : null}
      {actions ? <div className="a">{actions}</div> : null}
    </div>
  );
}
