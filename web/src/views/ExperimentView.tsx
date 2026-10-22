// Responsibility: control-experiment panel (§6C experiment A) —— run the same task set twice (A with assembly vs B bare run),
// comparing success rate / turns / cost / brief hit rate to answer "does assembly actually help".
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';

interface GroupCompare {
  group: string;
  name: string;
  total: number;
  done: number;
  failed: number;
  successRate: number;
  avgTurns: number;
  avgSteps: number;
  avgCost: number;
  avgCacheCost: number;
  briefHitRate: number;
  avgBriefEntries: number;
  verifyRate: number;
  verifiedTasks: number;
}

interface CompareReport {
  groups: [GroupCompare, GroupCompare];
  delta: { successRate: number; verifyRate: number; avgTurns: number; avgCost: number; briefHitRate: number; avgSteps: number };
  verdict: string;
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

export function ExperimentView({ pid }: { pid: string }) {
  const [report, setReport] = useState<CompareReport | null>(null);
  const [tasksText, setTasksText] = useState(
    'transfer.go lock race fix: briefly describe the deadlock root cause and the fix direction\n' +
    'transfer.go lock ordering: what happens when concurrent paths acquire locks in inconsistent order',
  );
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');

  const load = async () => {
    const r = await fetch(`/api/experiments/compare?project=${encodeURIComponent(pid)}`);
    setReport((await r.json()) as CompareReport);
  };

  useEffect(() => {
    void load();
  }, [pid]);

  const run = async (brief: boolean) => {
    setRunning(true);
    setMsg(brief ? 'Group A (with assembly) started; tasks are queued and run one by one…' : 'Group B (bare run) started; tasks are queued and run one by one…');
    try {
      const tasks = tasksText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          // One task per line: title: description || acceptance command (the acceptance command follows ||; exit code 0 = passed)
          const [taskPart, acceptance] = line.split('||').map((s) => s.trim());
          const [title, ...rest] = taskPart.split(/[\uFF1A:]/); // ASCII or full-width colon
          return {
            title: title.trim(),
            description: rest.join(': ').trim(),
            ...(acceptance ? { acceptance } : {}),
          };
        });
      const r = await fetch('/api/experiments/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: pid, brief, tasks, name: 'Control experiment' }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 200));
      const d = (await r.json()) as { group: string; created: unknown[] };
      setMsg(`✅ Group ${d.group} created ${d.created.length} tasks. Refresh the comparison once they finish.`);
      setTimeout(() => void load(), 2000);
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div id="expview">
      <div className="panel">
        <h2>Control experiment <span className="muted">A with assembly vs B bare run (§6C experiment A)</span></h2>
        <div className="exp-setup">
          <textarea
            value={tasksText}
            onChange={(e) => setTasksText(e.target.value)}
            rows={4}
            placeholder={'One task per line: title: description || acceptance command\nExample: generate lock_order.txt: write locking advice || test -s /tmp/x.txt\n(acceptance command exit code 0 = passed; both groups share the same task set)'}
          />
          <div className="exp-actions">
            <button className="btn primary" disabled={running} onClick={() => void run(true)}>
              <Icon name="play" size="sm" /> Run group A (with assembly)
            </button>
            <button className="btn" disabled={running} onClick={() => void run(false)}>
              <Icon name="play" size="sm" /> Run group B (bare run)
            </button>
            <button className="btn" onClick={() => void load()}>Refresh comparison</button>
          </div>
          {msg && <p className="exp-msg">{msg}</p>}
        </div>

        {report && (
          <div className="exp-compare">
            <table className="exp-table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Samples</th>
                  <th>Completion rate</th>
                  <th>Acceptance pass rate</th>
                  <th>Avg turns</th>
                  <th>Avg steps</th>
                  <th>Avg cost ¥</th>
                  <th>Cache cost</th>
                  <th>Brief hits</th>
                </tr>
              </thead>
              <tbody>
                {report.groups.map((g) => (
                  <tr key={g.group}>
                    <td><strong>{g.name}</strong></td>
                    <td>{g.total}</td>
                    <td>{pct(g.successRate)}</td>
                    <td title={`${g.verifiedTasks} tasks with acceptance criteria`}>
                      {g.verifiedTasks > 0 ? pct(g.verifyRate) : <span className="muted">no acceptance</span>}
                    </td>
                    <td>{g.avgTurns}</td>
                    <td>{g.avgSteps}</td>
                    <td>{g.avgCost.toFixed(4)}</td>
                    <td title="Cache-hit lever (assembled stable prefix → KV cache reads)">{g.avgCacheCost.toFixed(4)}</td>
                    <td>{pct(g.briefHitRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="exp-delta">
              <div>Δ completion rate: <strong>{report.delta.successRate > 0 ? '+' : ''}{pct(report.delta.successRate)}</strong></div>
              <div>Δ acceptance pass rate: <strong>{report.delta.verifyRate > 0 ? '+' : ''}{pct(report.delta.verifyRate)}</strong></div>
              <div>Δ brief hits: <strong>{report.delta.briefHitRate > 0 ? '+' : ''}{pct(report.delta.briefHitRate)}</strong></div>
              <div>Δ turns: <strong>{report.delta.avgTurns > 0 ? '+' : ''}{report.delta.avgTurns}</strong></div>
              <div>Δ steps: <strong>{report.delta.avgSteps > 0 ? '+' : ''}{report.delta.avgSteps}</strong></div>
              <div>Δ cost: <strong>{report.delta.avgCost > 0 ? '+' : ''}{report.delta.avgCost.toFixed(4)}</strong></div>
            </div>
            <p className="verdict">📋 {report.verdict}</p>
          </div>
        )}
      </div>
    </div>
  );
}
