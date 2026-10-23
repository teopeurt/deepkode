// Responsibility: recommendation card (port of Beautiful UI's "Recommendation Card", MIT © Shane Levine) ——
//   agent suggestion + three-level confidence meter (high confidence = 3 green / needs review = 2 yellow / no signal = 0 gray) + optional alternatives + Accept/Alternatives.
//   compact variant: a one-line suggestion (meter + text + adopt/don't adopt), for embedding inside approval cards.
import { useState, type ReactNode } from 'react';

export type Confidence = 'high' | 'needs-review' | 'no-signal';

export const CONF_LABEL: Record<Confidence, string> = {
  high: 'High confidence',
  'needs-review': 'Needs review',
  'no-signal': 'No signal',
};

/** Number of lit meter bars (high=3 / needs-review=2 / no-signal=0) */
const CONF_METER: Record<Confidence, number> = { high: 3, 'needs-review': 2, 'no-signal': 0 };

export interface RecOption {
  id: string;
  label: string;
  confidence?: Confidence;
}

interface Props {
  title: string;
  description?: ReactNode;
  confidence?: Confidence;
  /** Alternative options (expandable) */
  options?: RecOption[];
  /** Compact one-line variant (no expandable options, no separate footer) */
  compact?: boolean;
  acceptLabel?: string;
  alternativeLabel?: string;
  onAccept?: () => void;
  onAlternative?: () => void;
}

export function Meter({ confidence = 'high' }: { confidence?: Confidence }) {
  const n = CONF_METER[confidence];
  return (
    <span className="rec-meter" data-conf={confidence} aria-label={CONF_LABEL[confidence]}>
      {[0, 1, 2].map((i) => <i key={i} className={i < n ? 'on' : ''} />)}
    </span>
  );
}

export function RecommendationCard({
  title,
  description,
  confidence = 'high',
  options,
  compact = false,
  acceptLabel = 'Accept',
  alternativeLabel = 'Alternatives',
  onAccept,
  onAlternative,
}: Props) {
  const [showOptions, setShowOptions] = useState(false);

  if (compact) {
    return (
      <div className="rec" data-compact>
        <div className="rec-pad" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Meter confidence={confidence} />
          <span className="rec-title" style={{ fontSize: 12.5 }}>{title}</span>
          {description ? <span className="rec-desc" style={{ marginTop: 0, marginLeft: 'auto', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{description}</span> : null}
          <span className="rec-actions" style={{ marginLeft: 0 }}>
            {onAlternative ? <button className="btn mini ghost" onClick={onAlternative}>{alternativeLabel}</button> : null}
            {onAccept ? <button className="btn mini primary" onClick={onAccept}>{acceptLabel}</button> : null}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rec">
      <div className="rec-pad">
        <div className="rec-title">{title}</div>
        {description ? <div className="rec-desc">{description}</div> : null}
      </div>
      {options && options.length > 0 && showOptions ? (
        <div className="rec-options">
          <div className="rec-opt-head">Alternatives</div>
          {options.map((o) => (
            <button key={o.id} type="button" className="rec-opt">
              <Meter confidence={o.confidence ?? 'no-signal'} />
              <span className="ol">{o.label}</span>
              {o.confidence ? <span className="ot">{CONF_LABEL[o.confidence]}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rec-footer">
        <span className="rec-conf">
          <Meter confidence={confidence} />
          <b>{CONF_LABEL[confidence]}</b>
        </span>
        <span className="rec-actions">
          {options && options.length > 0 ? (
            <button className="btn" onClick={() => setShowOptions((v) => !v)}>{alternativeLabel}</button>
          ) : onAlternative ? (
            <button className="btn" onClick={onAlternative}>{alternativeLabel}</button>
          ) : null}
          {onAccept ? <button className="btn primary" onClick={onAccept}>{acceptLabel}</button> : null}
        </span>
      </div>
    </div>
  );
}
