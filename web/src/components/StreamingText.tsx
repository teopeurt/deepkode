// Responsibility: streaming text (port of Beautiful UI's "Streaming Text", MIT © Shane Levine) ——
//   streaming content + blinking cursor; when finished it can show inline sources, an action row (copy/retry) and follow-ups.
//   markdown mode: streaming content is rendered through Markdown in real time (code blocks/tables/bold are formatted as they type).
//   Display only: actions are passed up via callbacks.
import { useEffect, useState } from 'react';
import { Markdown } from './Markdown';

export interface StreamChip {
  id: string | number;
  label: string;
  onClick?: () => void;
}

interface Props {
  text?: string;
  streaming?: boolean;
  /** markdown mode: content is rendered through Markdown (formatted live while streaming) */
  markdown?: boolean;
  onCopy?: (text: string) => void;
  /** Content to copy; defaults to text. The raw text can still be copied when Markdown is shown above */
  copyValue?: string;
  onRetry?: () => void;
  sources?: StreamChip[];
  followups?: StreamChip[];
  className?: string;
}

export function StreamingText({
  text = '', streaming = false, markdown = false, onCopy, copyValue, onRetry, sources, followups, className = '',
}: Props) {
  const [copied, setCopied] = useState(false);
  const payload = copyValue ?? text;

  useEffect(() => setCopied(false), [payload]);

  const copy = () => {
    onCopy?.(payload);
    setCopied(true);
  };

  const showBody = !!text || streaming;
  const showActions = !streaming && ((!!onCopy && !!payload) || !!onRetry);
  const showSources = !streaming && !!sources && sources.length > 0;

  return (
    <div className={'stext' + (className ? ' ' + className : '')}>
      {showBody ? (
        markdown ? (
          <div className="stext-md">
            <Markdown text={text} />
            {streaming ? <span className="cursor" aria-hidden="true" /> : null}
          </div>
        ) : (
          <p>
            {text}
            {streaming ? <span className="cursor" aria-hidden="true" /> : null}
          </p>
        )
      ) : null}
      {showSources && sources ? (
        <div className="stext-sources">
          <span className="stext-src-n">{sources.length} sources</span>
          {sources.slice(0, 6).map((s) => (
            <button
              key={s.id}
              type="button"
              className="stext-src"
              onClick={s.onClick}
              disabled={!s.onClick}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
      {showActions ? (
        <div className="stext-actions">
          {onCopy && payload ? (
            <button
              type="button"
              className={'stext-act' + (copied ? ' copied' : '')}
              title={copied ? 'Copied' : 'Copy'}
              onClick={copy}
            >
              {copied ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="12" height="12" rx="2.5" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          ) : null}
          {onRetry ? (
            <button type="button" className="stext-act" title="Retry" onClick={onRetry}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
      {!streaming && followups && followups.length > 0 ? (
        <div className="stext-follow">
          <span className="stext-follow-lab">Follow-ups</span>
          {followups.map((f) => (
            <button key={f.id} type="button" className="stext-follow-btn" onClick={f.onClick}>{f.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
