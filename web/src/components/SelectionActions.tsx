// Responsibility: text-selection action bar (port of Beautiful UI's "Selection Actions", MIT © Shane Levine) ——
//   after selecting some text, Explain / Improve / Shorten / Tone / Grammar float up and hand the selection to the agent.
//   Pure UI: actions are passed up via onAction, and the caller fills them into the PromptBar (not sent automatically).
import { useEffect, useRef, useState, type ReactNode } from 'react';

export const SELECT_ACTIONS = [
  { id: 'explain', label: 'Explain' },
  { id: 'improve', label: 'Improve' },
  { id: 'shorten', label: 'Shorten' },
  { id: 'tone', label: 'Tone' },
  { id: 'grammar', label: 'Grammar' },
] as const;

export type SelectActionId = (typeof SELECT_ACTIONS)[number]['id'];

export function promptFromSelection(kind: SelectActionId, text: string): string {
  const q = text.trim();
  switch (kind) {
    case 'explain': return `Please explain this:\n\n> ${q}`;
    case 'improve': return `Please improve this:\n\n> ${q}`;
    case 'shorten': return `Please shorten this, keeping the key points:\n\n> ${q}`;
    case 'tone': return `Please adjust the tone of this to be clearer and more professional:\n\n> ${q}`;
    case 'grammar': return `Please fix the grammar and wording of this:\n\n> ${q}`;
  }
}

interface Props {
  children: ReactNode;
  onAction: (kind: SelectActionId, text: string) => void;
  disabled?: boolean;
}

export function SelectionActions({ children, onAction, disabled }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ top: number; left: number; text: string } | null>(null);

  const hide = () => setBar(null);

  useEffect(() => {
    if (disabled) { hide(); return; }
    const root = rootRef.current;
    if (!root) return;

    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode)) {
        hide();
        return;
      }
      const text = sel.toString();
      if (text.trim().length < 2) { hide(); return; }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      setBar({
        top: rect.top - box.top - 40,
        left: rect.left - box.left + rect.width / 2,
        text,
      });
    };

    const onScroll = () => hide();
    document.addEventListener('mouseup', onUp);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [disabled]);

  return (
    <div className="selact" ref={rootRef}>
      {children}
      {bar && !disabled ? (
        <div
          className="selact-bar"
          style={{ top: Math.max(0, bar.top), left: bar.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {SELECT_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              className="selact-btn"
              onClick={() => { onAction(a.id, bar.text); hide(); window.getSelection()?.removeAllRanges(); }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
