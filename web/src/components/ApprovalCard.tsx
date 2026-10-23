// Responsibility: approval card (port of Beautiful UI's "Approval Card", MIT © Shane Levine) ——
//   card-ifies "what it needs + why + how long it has been stuck"; a decision (approve/reject) carries a comment; the comment and "remember" are local component state, passed up via onDecide.
// Theme: reuses Helmsman's 25 semantic tokens (surface/line/text*/bg*/shadow-hover); no Tailwind, no new dependencies.
import { useState } from 'react';
import { Icon, type IconName } from './icons';
import { Markdown } from './Markdown';
import { AcceptanceEvidence } from './AcceptanceEvidence';
import { RecommendationCard } from './RecommendationCard';
import type { ApprovalItem } from '../api/client';

export const KIND_LABEL: Record<ApprovalItem['kind'], string> = {
  plan: 'Plan review',
  calibrate: 'Acceptance criteria proposal',
  checkpoint: 'Checkpoint review',
  permission: 'Permission request',
  acceptance: 'Acceptance',
  cost: 'Cost budget',
};

const KIND_ICON: Record<ApprovalItem['kind'], IconName> = {
  plan: 'doc', calibrate: 'doc', checkpoint: 'doc', permission: 'lock', acceptance: 'check', cost: 'warn',
};

/** How long it has been stuck (created_at epoch ms → relative duration, rendered with --fs-xs mono) */
export function approvalElapsed(createdAt: number): string {
  const s = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

export interface ApprovalCardProps {
  item: ApprovalItem;
  /** Decision passed up (outcome, comment, remember); when it returns a Promise the card debounces with its own pending state */
  onDecide: (outcome: 'approved' | 'rejected', comment: string, remember: boolean) => void | Promise<void>;
}

export function ApprovalCard({ item: a, onDecide }: ApprovalCardProps) {
  const [comment, setComment] = useState('');
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const decide = async (outcome: 'approved' | 'rejected', c = comment, r = remember) => {
    if (pending) return;
    setPending(true);
    try {
      await onDecide(outcome, c, r);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="appr-card">
      <div className="appr-card-head">
        <div className="appr-kick" data-kind={a.kind}>
          <span className="kicon"><Icon name={KIND_ICON[a.kind]} size="sm" /></span>
          <div className="kick-txt">
            <div className="kick-row">
              <span className="appr-kind">{KIND_LABEL[a.kind]}</span>
              <span className="appr-when">waiting {approvalElapsed(a.created_at)}</span>
            </div>
            <div className="appr-title" title={a.task_title ?? a.execution_id}>
              {a.task_title ?? a.execution_id.slice(0, 24)}
              <span className="appr-id"> · #{a.id}</span>
              {a.card_kind ? <span className="tag" style={{ marginLeft: 6 }}>{a.card_kind}</span> : null}
            </div>
          </div>
        </div>
      </div>

      <div className="appr-q">
        <div className="q-kicker">Why it is stuck</div>
        <div className="q-text">{a.reason || '(no reason given)'}</div>
      </div>

      {!dismissed && a.policy_suggestion ? (
        <div className="appr-payload" style={{ paddingTop: 10 }}>
          <RecommendationCard
            compact
            title={`Policy suggestion from history · ${a.policy_suggestion.scope === 'global' ? 'project' : a.policy_suggestion.scope} items were ${a.policy_suggestion.outcome === 'approved' ? 'approved' : 'rejected'} ${a.policy_suggestion.count} times`}
            description="Adopt in one click (this time only, never silently)"
            confidence={a.policy_suggestion.count >= 3 ? 'high' : a.policy_suggestion.count === 2 ? 'needs-review' : 'no-signal'}
            acceptLabel="Adopt"
            alternativeLabel="Don't adopt"
            onAccept={() => void decide(a.policy_suggestion!.outcome, 'Following the historical policy', true)}
            onAlternative={() => setDismissed(true)}
          />
        </div>
      ) : null}

      {a.kind === 'acceptance' ? <AcceptanceEvidence payload={a.payload} /> : null}

      <div className="appr-payload">
        {a.kind === 'acceptance'
          ? null
          : Object.entries(a.payload).map(([k, v]) => {
              if (k === 'plan' && typeof v === 'string' && v.length > 40) {
                return (
                  <details key={k} className="appr-plan" open>
                    <summary>📋 Plan</summary>
                    <div className="appr-plan-body"><Markdown text={v} /></div>
                  </details>
                );
              }
              if (k === 'criteria_proposal' && typeof v === 'string' && v.length > 20) {
                return (
                  <details key={k} className="appr-plan" open>
                    <summary>🧪 Acceptance criteria proposal (approve → written back to the card's acceptance criteria)</summary>
                    <div className="appr-plan-body"><Markdown text={v} /></div>
                  </details>
                );
              }
              if (k === 'summary' && typeof v === 'string' && v.length > 20) {
                return (
                  <details key={k} className="appr-plan" open>
                    <summary>📈 Checkpoint summary (goal-mode checkpoint)</summary>
                    <div className="appr-plan-body"><Markdown text={v} /></div>
                  </details>
                );
              }
              return <span key={k} className="tag">{k}: {String(v).slice(0, 60)}</span>;
            })}
      </div>

      <div className="appr-foot">
        <input
          className="appr-comment-input"
          placeholder="Decision comment (delivered to the agent)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          aria-label="Decision comment"
        />
        <label className="appr-remember" title="Capture as a policy atom: once similar decisions reach count≥2, a suggestion is offered">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember
        </label>
        <div className="appr-actions">
          <button className="btn primary" disabled={pending} onClick={() => void decide('approved')}>Approve</button>
          <button className="btn" disabled={pending} onClick={() => void decide('rejected')}>Reject</button>
        </div>
      </div>
    </div>
  );
}
