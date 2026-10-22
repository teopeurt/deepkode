// Responsibility: prompt bar (port of Beautiful UI's "Prompt Bar", MIT © Shane Levine) ——
//   auto-growing input + @ source mentions + / slash commands + model chip + voice input + send.
//   A pure display/input component: search, commands and sending are all passed up via callbacks; the model chip only shows the current model (no fake dropdown without a switching API).
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react';

export interface MentionItem {
  id: string | number;
  title: string;
  sub?: string;
}

export interface SlashCommand {
  id: string;
  label: string;
  hint?: string;
  /** Replace /cmd with this text */
  insert?: string;
  /** Run immediately (the component clears /cmd) */
  run?: () => void;
}

export interface PromptBarHandle {
  focus: () => void;
}

interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function speechCtor(): (new () => SpeechRec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Mode chip cursor icon (InputBar style) */
function CursorIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
    </svg>
  );
}

/** Dropdown chevron icon */
function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pbar-chip-chev" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** The unclosed @query before the cursor (ignores completed @[title]) */
export function mentionAt(text: string, caret: number): { start: number; q: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|[\s])@([^\s[\]]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, q: m[1] };
}

/** Leading /cmd */
export function slashAt(text: string, caret: number): { start: number; q: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\n)\/([^\s]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, q: m[1] };
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  mentions?: MentionItem[];
  /** Passed up when the @query changes; the caller is responsible for searching */
  onMentionQuery?: (q: string) => void;
  mentionEmpty?: string;
  commands?: SlashCommand[];
  /** Current model name (display only; no fake picker without a switching API) */
  model?: string;
  /** Available models (shown in the model menu) */
  models?: string[];
  /** Model selection callback (the caller persists it + it takes effect next turn) */
  onModelChange?: (model: string) => void;
  /** Collaboration mode name (Agent / Auto etc., display only) */
  mode?: string;
  /** Extra actions on the left of the toolbar (promote to task etc.) */
  actions?: ReactNode;
  /** Extra content below the bar (promotion form etc.) */
  extra?: ReactNode;
  variant?: 'rounded' | 'pill';
}

export const PromptBar = forwardRef<PromptBarHandle, Props>(function PromptBar({
  value,
  onChange,
  onSend,
  placeholder = 'Ask something…',
  disabled = false,
  busy = false,
  mentions = [],
  onMentionQuery,
  mentionEmpty = 'No matches',
  commands = [],
  model,
  models = ['deepseek-v4-flash', 'deepseek-v4-pro'],
  onModelChange,
  mode = 'Agent',
  actions,
  extra,
  variant = 'rounded',
}, ref) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rowsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const recRef = useRef<SpeechRec | null>(null);
  const dictBase = useRef('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);
  const [listening, setListening] = useState(false);
  const canSpeak = useMemo(() => speechCtor() != null, []);
  // Mode/model dropdown menu (which one is open; null = all closed). The engine does not support per-session switching,
  // so clicking an option only hints "cannot switch" (no fake features) and highlights the current value.
  const [openMenu, setOpenMenu] = useState<'mode' | 'model' | null>(null);
  const chipWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (chipWrapRef.current && !chipWrapRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
  }, [openMenu]);

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  const grow = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, []);

  useLayoutEffect(() => { grow(); }, [value, grow]);

  const markCaret = () => {
    const el = taRef.current;
    if (el) setCaret(el.selectionStart);
  };

  const mention = mentionAt(value, caret);
  const slash = slashAt(value, caret);

  useEffect(() => {
    if (mention) onMentionQuery?.(mention.q);
  }, [mention?.q]); // eslint-disable-line react-hooks/exhaustive-deps

  const menuItems = (() => {
    if (slash && commands.length) {
      const q = slash.q.toLowerCase();
      return commands
        .filter((c) => !q || c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
        .map((c) => ({ key: c.id, title: '/' + c.id, sub: c.hint ?? c.label, kind: 'slash' as const, cmd: c }));
    }
    if (mention) {
      return mentions.map((m) => ({ key: String(m.id), title: m.title, sub: m.sub, kind: 'mention' as const, item: m }));
    }
    return [];
  })();

  const menuOpen = slash && commands.length ? true : !!mention;
  const shown = menuItems;

  const glide = (i: number) => {
    const el = rowsRef.current[i];
    if (el) {
      setHl({ top: el.offsetTop, height: el.offsetHeight });
      setActive(i);
    } else {
      setHl(null);
      setActive(0);
    }
  };

  useLayoutEffect(() => {
    if (!menuOpen) { setHl(null); setActive(0); return; }
    glide(Math.min(active, Math.max(0, shown.length - 1)));
    // Only reposition when the menu content changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, shown.length, mention?.q, slash?.q]);

  const replaceRange = (start: number, end: number, insert: string) => {
    const next = value.slice(0, start) + insert + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      const pos = start + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const pick = (i: number) => {
    const row = shown[i];
    if (!row) return;
    if (row.kind === 'mention' && mention) {
      replaceRange(mention.start, caret, '@[' + row.item.title + '] ');
      return;
    }
    if (row.kind === 'slash' && slash) {
      if (row.cmd.run) {
        replaceRange(slash.start, caret, '');
        row.cmd.run();
      } else if (row.cmd.insert) {
        replaceRange(slash.start, caret, row.cmd.insert);
      }
    }
  };

  const insertToken = (token: string) => {
    const el = taRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const needsSpace = start > 0 && !/\s$/.test(value.slice(0, start));
    replaceRange(start, end, (needsSpace ? ' ' : '') + token);
  };

  const startDict = () => {
    const Ctor = speechCtor();
    if (!Ctor || listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    dictBase.current = value;
    rec.onresult = (ev) => {
      let full = '';
      for (let i = 0; i < ev.results.length; i++) full += ev.results[i][0].transcript;
      const base = dictBase.current;
      onChange((base && !/\s$/.test(base) ? base + ' ' : base) + full);
    };
    rec.onerror = () => { setListening(false); recRef.current = null; };
    rec.onend = () => { setListening(false); recRef.current = null; };
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  useEffect(() => () => { recRef.current?.abort(); }, []);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && shown.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        glide(Math.min(active + 1, shown.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        glide(Math.max(active - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        pick(active);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (mention) replaceRange(mention.start, caret, '');
        else if (slash) replaceRange(slash.start, caret, '');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      recRef.current?.stop();
      if (!disabled && !busy && value.trim()) onSend();
    }
  };

  const sendOk = !disabled && !busy && !!value.trim();

  return (
    <div className={'pbar' + (variant === 'pill' ? ' pill' : '')} data-listening={listening || undefined}>
      {menuOpen ? (
        <div className="pbar-menu" role="listbox">
          {hl ? <span className="pbar-glide" style={{ top: hl.top, height: hl.height, opacity: 1 }} /> : null}
          {shown.map((row, i) => (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={i === active}
              ref={(el) => { rowsRef.current[i] = el; }}
              className="pbar-row"
              onMouseEnter={() => glide(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="pbar-row-t">{row.title}</span>
              {row.sub ? <span className="pbar-row-s">{row.sub}</span> : null}
            </button>
          ))}
          {mention && shown.length === 0 ? (
            <div className="pbar-empty">{mention.q ? mentionEmpty : 'Type keywords to search the knowledge base'}</div>
          ) : null}
          {slash && shown.length === 0 ? <div className="pbar-empty">No matching commands</div> : null}
        </div>
      ) : null}

      <textarea
        ref={taRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={1}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart); }}
        onKeyDown={onKey}
        onKeyUp={markCaret}
        onClick={markCaret}
        onSelect={markCaret}
      />

      <div className="pbar-rowbar">
        <button
          type="button"
          className="pbar-tool"
          title="@ cite a source"
          disabled={disabled}
          onClick={() => { insertToken('@'); }}
        >
          @
        </button>
        {commands.length > 0 ? (
          <button
            type="button"
            className="pbar-tool"
            title="/ commands"
            disabled={disabled}
            onClick={() => {
              const el = taRef.current;
              const pos = el?.selectionStart ?? value.length;
              const atLine = pos === 0 || value[pos - 1] === '\n';
              insertToken(atLine ? '/' : '\n/');
            }}
          >
            /
          </button>
        ) : null}
        {actions}
        <span className="pbar-spacer" />
        {/* Mode + model dropdown chips (InputBar style: click to open the menu) */}
        <div className="pbar-chips" ref={chipWrapRef}>
          <button
            type="button"
            className={'pbar-chip' + (openMenu === 'mode' ? ' open' : '')}
            title="Collaboration mode"
            onClick={() => setOpenMenu(openMenu === 'mode' ? null : 'mode')}
          >
            <CursorIcon />
            <span>{mode}</span>
            <ChevronIcon />
          </button>
          {openMenu === 'mode' ? (
            <div className="pbar-dropdown" role="menu">
              {['Agent', 'Auto', 'Yolo'].map((m) => (
                <button
                  key={m}
                  type="button"
                  role="menuitem"
                  className={'pbar-dd-item' + (m === mode ? ' cur' : '')}
                  onClick={() => setOpenMenu(null)}
                >
                  <span>{m}</span>
                  {m === mode ? <span className="pbar-dd-check">✓</span> : null}
                </button>
              ))}
              <div className="pbar-dd-note">The mode is the card's profile setting chosen at creation (collaboration mode) and cannot be switched within a session</div>
            </div>
          ) : null}
          <button
            type="button"
            className={'pbar-chip' + (openMenu === 'model' ? ' open' : '')}
            title="Current model"
            onClick={() => setOpenMenu(openMenu === 'model' ? null : 'model')}
          >
            <span className="pbar-chip-model">{model || 'deepseek-v4-flash'}</span>
            <ChevronIcon />
          </button>
          {openMenu === 'model' ? (
            <div className="pbar-dropdown" role="menu">
              {models.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="menuitem"
                  className={'pbar-dd-item' + (m === (model || 'deepseek-v4-flash') ? ' cur' : '')}
                  onClick={() => {
                    setOpenMenu(null);
                    if (m !== (model || 'deepseek-v4-flash')) onModelChange?.(m);
                  }}
                >
                  <span>{m}</span>
                  {(m === (model || 'deepseek-v4-flash')) ? <span className="pbar-dd-check">✓</span> : null}
                </button>
              ))}
              <div className="pbar-dd-note">Takes effect from the next turn after switching (no new session needed)</div>
            </div>
          ) : null}
        </div>
        {/* Voice button hidden for now: the browser's native speech recognition is unreliable for Chinese/technical terms, so an unfinished feature gets no entry point
            (the code is kept; set it back to true once reliable recognition is wired in) */}
        {false && canSpeak ? (
          <button
            type="button"
            className={'pbar-tool' + (listening ? ' on' : '')}
            title={listening ? 'Stop voice input' : 'Voice input'}
            disabled={disabled}
            aria-pressed={listening}
            onClick={startDict}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          className={'pbar-send' + (sendOk ? ' on' : '')}
          disabled={!sendOk}
          title="Send"
          aria-label="Send"
          onClick={() => { recRef.current?.stop(); onSend(); }}
        >
          {busy ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="8" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          )}
        </button>
      </div>
      {extra}
    </div>
  );
});
