// Responsibility: UI routing/navigation store —— three-pane navigation state + modal toggles + toasts.
// The hash-routing contract matches the prototype: #pid=&view=&open=&tab= (view: home|projhome|kanban|chat|graph|kb|files).
import { create } from 'zustand';

export type ViewId = 'home' | 'projhome' | 'kanban' | 'chat' | 'sessions' | 'graph' | 'kb' | 'files' | 'metrics' | 'experiment' | 'approvals';
export type DrawerTab = 'comments' | 'brief' | 'artifact' | 'trajectory';

interface ToastItem {
  id: number;
  msg: string;
}

interface UiState {
  pid: string | null;
  view: ViewId;
  openId: string | null;
  tab: DrawerTab;
  /** Session drill-in full-screen page: session id (hash `t=` param; non-null = render SessionDetailView) */
  sessionId: string | null;
  sideOpen: boolean;
  sideQ: string;
  settingsOpen: boolean;
  newTaskOpen: boolean;
  dirOpen: boolean;
  /** Local projects pending registration (offline fallback; persisted across reloads. Removed once the server registers them explicitly) */
  pendingProjects: Record<string, { id: string; name: string; path: string }>;
  toasts: ToastItem[];
  setRoute: (p: Partial<Pick<UiState, 'pid' | 'view' | 'openId' | 'tab' | 'sessionId'>>) => void;
  toggleSide: () => void;
  setSideQ: (q: string) => void;
  setSettingsOpen: (v: boolean) => void;
  setNewTaskOpen: (v: boolean) => void;
  setDirOpen: (v: boolean) => void;
  addPendingProject: (id: string, name: string, path: string) => void;
  removePendingProject: (id: string) => void;
  openDetail: (sid: string, tab?: DrawerTab) => void;
  closeDetail: () => void;
  toast: (msg: string) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useUi = create<UiState>((set, get) => ({
  pid: null,
  view: 'home',
  openId: null,
  tab: 'comments',
  sessionId: null,
  sideOpen: (() => { try { return localStorage.getItem('helmsman-side') !== '0'; } catch { return true; } })(),
  sideQ: '',
  settingsOpen: false,
  newTaskOpen: false,
  dirOpen: false,
  pendingProjects: (() => {
    try { return JSON.parse(localStorage.getItem('helmsman-pending') || '{}'); } catch { return {}; }
  })(),
  toasts: [],

  setRoute: (p) => set((s) => ({ ...s, ...p })),
  toggleSide: () => {
    const v = !get().sideOpen;
    try { localStorage.setItem('helmsman-side', v ? '1' : '0'); } catch { /* ignore */ }
    set({ sideOpen: v });
  },
  setSideQ: (q) => set({ sideQ: q }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setNewTaskOpen: (v) => set({ newTaskOpen: v }),
  setDirOpen: (v) => set({ dirOpen: v }),
  addPendingProject: (id, name, path) => set((s) => {
    const pendingProjects = { ...s.pendingProjects, [id]: { id, name, path } };
    try { localStorage.setItem('helmsman-pending', JSON.stringify(pendingProjects)); } catch { /* ignore */ }
    return { pendingProjects };
  }),
  removePendingProject: (id) => set((s) => {
    const pendingProjects = { ...s.pendingProjects };
    delete pendingProjects[id];
    try { localStorage.setItem('helmsman-pending', JSON.stringify(pendingProjects)); } catch { /* ignore */ }
    return { pendingProjects };
  }),
  openDetail: (sid, tab) => set({ openId: sid, tab: tab || 'comments' }),
  closeDetail: () => set({ openId: null }),
  toast: (msg) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, msg }] }));
    setTimeout(() => get().dismissToast(id), 2800);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Write the current route into the hash (contract: #pid=&view=&open=&tab=&t=) */
export function writeHash(pid: string | null, view: ViewId, openId: string | null, tab: DrawerTab, sessionId?: string | null) {
  const params: string[] = [];
  if (pid) params.push('pid=' + encodeURIComponent(pid));
  if (view && view !== 'home') params.push('view=' + view);
  if (openId) params.push('open=' + encodeURIComponent(openId));
  if (tab && tab !== 'comments') params.push('tab=' + tab);
  if (sessionId) params.push('t=' + encodeURIComponent(sessionId));
  const h = params.length ? '#' + params.join('&') : '#';
  // Must trigger hashchange (App listens for it: parseHash → update the store → re-render):
  // history.replaceState only changes the address bar without firing the event, which was the root cause of "clicking back does nothing".
  if (location.hash !== h) location.hash = h;
}

/** Jump to the session drill-in full-screen page: #pid=&t=<sid> (keeps view so we can go back)
 *  Clear openId when entering a session: the drawer closes automatically and the session is full-screen on its own —— no more "session + drawer stacked",
 *  and the drawer's × no longer closes the session along with it. */
export function openSession(pid: string, sid: string, view: ViewId, cardId: string | null) {
  useUi.getState().setRoute({ sessionId: sid, openId: null, pid });
  writeHash(pid, view, null, 'comments', sid);
}