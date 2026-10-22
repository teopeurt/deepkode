// Responsibility: collapsible tool-call strip (port of Beautiful UI's "Tool Chips", MIT © Shane Levine) ——
//   collapsed header "N tool calls · M messages" + expanded chips (tool name + success + duration).
//   Used to compress a run of tool calls into one small strip so it doesn't interrupt the reading flow in a chat.
import { useState } from 'react';

export interface ToolChip {
  id: string | number;
  name: string;
  ok?: boolean;
  ms?: number;
}

interface Props {
  calls: ToolChip[];
  /** Number of related messages ("· N messages"); only the call count is shown if not passed */
  messages?: number;
  defaultOpen?: boolean;
}

export function ToolChips({ calls, messages, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const okCount = calls.filter((c) => c.ok !== false).length;

  return (
    <div className={'toolchips' + (open ? ' open' : '')}>
      <button
        type="button"
        className="toolchips-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span><b>{calls.length}</b> tool calls</span>
        {messages != null ? <span>· {messages} messages</span> : null}
        <span className="toolchip-count">{okCount}/{calls.length} ok</span>
      </button>
      <div className="toolchips-body">
        <div className="toolchips-body-inner">
          {calls.length ? (
            <div className="toolchips-list">
              {calls.map((c) => (
                <span key={c.id} className="toolchip" title={c.name}>
                  <span className="tn">{c.name}</span>
                  <span className={c.ok === false ? 'err' : 'ok'}>{c.ok === false ? 'failed' : 'ok'}</span>
                  {c.ms != null ? <span className="ms">{c.ms} ms</span> : null}
                </span>
              ))}
            </div>
          ) : (
            <div className="think-empty">(empty)</div>
          )}
        </div>
      </div>
    </div>
  );
}
