// Responsibility: approval queue (P0 first-class surface, §4) —— aggregates every Waiting in the project (plan/permission/acceptance/cost);
// each card (ApprovalCard, ported from Beautiful UI) shows "what it needs + why + how long it has been stuck";
// a decision (approve/reject) must carry a comment delivered to the agent; policy suggestions can be adopted in one click (this time only, never silently).
import { useEffect, useState } from 'react';
import { useUi } from '../store/ui';
import { listApprovals, decideApproval, listPolicies, deletePolicy, listSuspendedApprovals, resumeApproval, resumeAllApprovals, type ApprovalItem, type PolicyRow } from '../api/client';
import { ApprovalCard, KIND_LABEL } from '../components/ApprovalCard';

export function ApprovalsView({ pid }: { pid: string }) {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [showPolicies, setShowPolicies] = useState(false);
  const [suspended, setSuspended] = useState<ApprovalItem[]>([]);

  const load = async () => {
    try {
      setItems(await listApprovals(pid));
      setPolicies(await listPolicies(pid));
      setSuspended(await listSuspendedApprovals(pid));
    } catch {
      setItems([]);
      setPolicies([]);
      setSuspended([]);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [pid]);

  const toast = useUi((s) => s.toast);
  const decide = async (id: number, outcome: 'approved' | 'rejected', comment: string, remember: boolean) => {
    try {
      const ok = await decideApproval(id, outcome, comment, remember);
      if (ok) await load();
    } catch (e) {
      toast(`Decision failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  };

  const isEmpty = items.length === 0 && suspended.length === 0;

  // Empty state: when nothing is awaiting approval the whole view is blank —— you know at a glance there's nothing to decide; no title/hints are rendered.
  if (isEmpty) return <div id="apprview" />;

  return (
    <div id="apprview">
      <div className="panel">
        <h2>
          Approval queue <span className="muted">Items waiting for your confirmation</span>
          <button className="policy-toggle" onClick={() => setShowPolicies((v) => !v)}>
            🧠 Policy rules {policies.length ? `(${policies.length})` : ''}
          </button>
        </h2>
        {showPolicies && (
          <div className="policy-panel">
            {policies.length === 0 && <div className="muted" style={{ padding: '6px 0' }}>No policies yet —— checking "Remember this choice" when deciding captures a policy atom; once similar decisions reach count≥2, a suggestion is offered.</div>}
            {policies.map((p) => (
              <div key={p.id} className="policy-row">
                <span className="tag">{p.kind}</span>
                <span className="tag">{p.scope}</span>
                <span className={'policy-outcome ' + p.outcome}>{p.outcome === 'approved' ? 'Approved' : 'Rejected'} ×{p.count}</span>
                <span className="muted" style={{ fontSize: 10.5, fontFamily: 'var(--mono)' }}>{new Date(p.updated_at).toLocaleString()}</span>
                <button className="btn mini ghost" onClick={async () => { if (await deletePolicy(p.id)) void load(); }}>Delete</button>
              </div>
            ))}
          </div>
        )}
        {suspended.length > 0 ? (
          <div className="suspend-panel">
            <div className="suspend-head">
              <span>⏸ {suspended.length} suspended (a Waiting is suspended automatically after a 30-minute timeout · not a failure)</span>
              <button className="btn mini ghost" onClick={async () => { if (await resumeAllApprovals(pid)) void load(); }}>Resume all</button>
            </div>
            {suspended.map((a) => (
              <div key={a.id} className="suspend-row">
                <span className="tag">{KIND_LABEL[a.kind] ?? a.kind}</span>
                <span className="suspend-title">{a.task_title}</span>
                <span className="muted" style={{ fontSize: 10.5, fontFamily: 'var(--mono)' }}>#{a.id}</span>
                <button className="btn mini" onClick={async () => { if (await resumeApproval(a.id)) void load(); }}>Resume</button>
              </div>
            ))}
          </div>
        ) : null}
        {items.map((a) => (
          <ApprovalCard
            key={a.id}
            item={a}
            onDecide={(outcome, comment, remember) => void decide(a.id, outcome, comment, remember)}
          />
        ))}
      </div>
    </div>
  );
}
