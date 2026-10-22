// Responsibility: chat panel (port of Beautiful UI's "Chat", MIT © Shane Levine) ——
//   top tab bar + message stream + bottom composer. Reasoning/tools/streaming are passed in as children by the caller.
// The active tab has an action menu: rename (✎ or menu item) / fork chat / archive chat.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';

export interface ChatTab {
  id: string;
  label: string;
  /** Rename: submit from the input */
  onRename?: (id: string, title: string) => void;
  /** Fork the chat (copy history into a new session) */
  onFork?: (id: string) => void;
  /** Archive the chat (remove from list) */
  onArchive?: (id: string) => void;
}

interface Props {
  tabs?: ChatTab[];
  tab?: string;
  onTab?: (id: string) => void;
  children: ReactNode;
  footer: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
}

export function ChatPanel({ tabs, tab, onTab, children, footer, bodyRef }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Clicking outside closes the menu
  useEffect(() => {
    if (!menuId) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuId(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuId]);

  // Open the menu: record the button's viewport coordinates and position the menu fixed (escapes overflow clipping)
  // Boundary adaptation: switch to left alignment when right alignment would overflow the viewport's left edge; open upward when there isn't enough space below
  const openMenu = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (menuId === id) { setMenuId(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const MENU_W = 128;
    const MENU_H = 104;
    let x = rect.right - MENU_W; // right-aligned
    if (x < 4) x = rect.left;     // not enough room on the left → left-align
    if (x + MENU_W > window.innerWidth - 4) x = window.innerWidth - MENU_W - 4; // not enough room on the right
    let y = rect.bottom + 4;
    if (y + MENU_H > window.innerHeight - 4) y = rect.top - MENU_H - 4; // not enough room below → open upward
    setMenuPos({ x, y });
    setMenuId(id);
  };

  const commitRename = (id: string) => {
    const v = draft.trim();
    setRenamingId(null);
    if (!v) return;
    const t = tabs?.find((x) => x.id === id);
    t?.onRename?.(id, v);
  };

  return (
    <div className="chatpanel">
      {tabs && tabs.length > 0 ? (
        <div className="chatpanel-tabs">
          {tabs.map((t) => {
            const active = t.id === tab;
            const renaming = active && renamingId === t.id;
            return (
              <span key={t.id} className={'chatpanel-tab' + (active ? ' active' : '')}>
                {renaming ? (
                  <input
                    className="chatpanel-tab-edit"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(t.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={() => commitRename(t.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <button type="button" className="chatpanel-tab-label" onClick={() => onTab?.(t.id)}>
                      {t.label}
                    </button>
                    {active && (t.onRename || t.onFork || t.onArchive) ? (
                      <span className="chatpanel-tab-actions">
                        <button
                          type="button"
                          className={'chatpanel-tab-btn' + (menuId === t.id ? ' open' : '')}
                          title="More actions"
                          onClick={(e) => openMenu(t.id, e)}
                        >
                          ⋮
                        </button>
                      </span>
                    ) : null}
                  </>
                )}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="chatpanel-body" ref={bodyRef}>{children}</div>
      <div className="chatpanel-foot">{footer}</div>
      {menuId !== null && menuPos ? (
        <div
          className="chatpanel-tab-menu"
          ref={menuRef}
          style={{ position: 'fixed', left: menuPos.x, top: menuPos.y, right: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" className="chatpanel-tab-menu-item" onClick={() => { setMenuId(null); const t = tabs?.find((x) => x.id === menuId); if (t) { setDraft(t.label.replace(/…$/, '')); setRenamingId(t.id); } }}>
            Rename
          </button>
          <button
            type="button"
            className="chatpanel-tab-menu-item"
            onClick={() => { const t = tabs?.find((x) => x.id === menuId); setMenuId(null); t?.onFork?.(t.id); }}
          >
            Fork chat
          </button>
          <button
            type="button"
            className="chatpanel-tab-menu-item danger"
            onClick={() => { const t = tabs?.find((x) => x.id === menuId); setMenuId(null); t?.onArchive?.(t.id); }}
          >
            Archive chat
          </button>
        </div>
      ) : null}
    </div>
  );
}
