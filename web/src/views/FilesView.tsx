// Responsibility: files view —— project workspace file tree (live state fetched on demand) + file content preview (P2: the read endpoint is available).
// Tree: GET /api/projects/:pid/files (server-side safety filtering); preview: GET /api/projects/:pid/files/read?path= (traversal-protected within the workspace).
// Text uses CodeBlock (line numbers + diff detection); binary / oversized files get a notice.
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';
import { LoadingState } from '../components/LoadingState';
import { CodeBlock } from '../components/CodeBlock';
import { Markdown } from '../components/Markdown';

interface FNode { name: string; type: 'file' | 'dir'; children?: FNode[] }

interface Preview {
  path: string;
  name: string;
  size: number;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export function FilesView({ pid }: { pid: string }) {
  const [tree, setTree] = useState<FNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pLoading, setPLoading] = useState(false);
  const [pErr, setPErr] = useState('');
  // Set of collapsed directory paths (clicking a directory toggles expand/collapse)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch('/api/projects/' + encodeURIComponent(pid) + '/files')
      .then((r) => r.json())
      .then((root: FNode) => { if (alive) setTree(root); })
      .catch(() => { if (alive) setTree(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [pid]);

  const openFile = async (path: string) => {
    setSel(path);
    setPLoading(true);
    setPErr('');
    setPreview(null);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/files/read?path=${encodeURIComponent(path)}`);
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(body.slice(0, 120) || `Read failed (${r.status})`);
      }
      setPreview((await r.json()) as Preview);
    } catch (e) {
      setPErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPLoading(false);
    }
  };

  const renderNode = (n: FNode, path: string): React.ReactNode => {
    const isDir = n.type === 'dir';
    const isCollapsed = isDir && collapsed.has(path);
    return (
      <div key={path}>
        <button
          className={'fx-node ' + n.type + (sel === path ? ' sel' : '')}
          onClick={() => {
            if (isDir) {
              // Directory: toggle expand/collapse
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path); else next.add(path);
                return next;
              });
            } else {
              void openFile(path);
            }
          }}
        >
          {isDir ? <span className="fx-caret">{isCollapsed ? '▸' : '▾'}</span> : <span className="fx-caret" />}
          <Icon name={isDir ? 'folder' : 'doc'} size="sm" />
          {n.name}
        </button>
        {n.children?.length ? (
          <div className={'fx-children' + (isCollapsed ? ' collapsed' : '')}>
            {n.children.map((c) => renderNode(c, path ? path + '/' + c.name : c.name))}
          </div>
        ) : null}
      </div>
    );
  };

  const ext = preview?.name.includes('.') ? preview.name.split('.').pop()! : '';
  const isMd = ext === 'md' || ext === 'markdown' || ext === 'mdown';
  const renderBody = (): React.ReactNode => {
    if (isMd) return <div className="fx-preview"><div className="md"><Markdown text={preview!.content} /></div></div>;
    return (
      <div className="fx-preview">
        <CodeBlock code={preview!.content} info={ext} />
      </div>
    );
  };

  return (
    <div id="filesview">
      <div className="fx-side">
        <div className="fx-tree">
          {loading ? (
            <div className="empty-state"><LoadingState variant="dots" label="Loading file tree…" /></div>
          ) : tree ? renderNode(tree, '') : (
            <div className="empty-state">
              <Icon name="folder" />
              <div className="t">File tree unavailable</div>
              <div className="d">Failed to read the workspace (the directory does not exist or is unreadable)</div>
            </div>
          )}
        </div>
      </div>
      <div className="fx-main">
        {pLoading ? (
          <div className="empty-state"><LoadingState label="Reading file…" /></div>
        ) : pErr ? (
          <div className="empty-state">
            <Icon name="warn" />
            <div className="t">Read failed</div>
            <div className="d">{pErr}</div>
          </div>
        ) : preview ? (
          <>
            <div className="fname">
              {preview.name}
              <span className="muted" style={{ marginLeft: 10 }}>{preview.size.toLocaleString()} B{preview.truncated ? ' · larger than 256KB, truncated' : ''}</span>
            </div>
            <div className="fmeta">{preview.path}</div>
            {preview.binary ? (
              <div className="note" style={{ marginTop: 12 }}>Binary file (no content preview)</div>
            ) : preview.content ? (
              renderBody()
            ) : (
              <div className="note" style={{ marginTop: 12 }}>{preview.truncated ? 'File too large; content not read' : 'Empty file'}</div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <Icon name="folder" />
            <div className="t">No file selected</div>
            <div className="d">Pick a file on the left to preview its content</div>
          </div>
        )}
      </div>
      <span className="hidden">{pid}</span>
    </div>
  );
}
