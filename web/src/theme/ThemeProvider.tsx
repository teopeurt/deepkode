// Responsibility: theme state (selection / atmosphere level, persisted in localStorage) + ThemeProvider —— injects all semantic tokens via the CSSOM.
// Injection logic matches taskboard-v9 applyTheme: documentElement.style.setProperty key by key;
// 'system' follows prefers-color-scheme (listens for changes); persistence keys match the prototype (helmsman-theme / helmsman-atmo).
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { TK_MAP, findTheme, SYSTEM_THEME_ID, type Theme } from './themes';
import { applySkin, clearSkin, getActiveSkin, loadActiveSkinId, setActiveSkin, type UserSkin } from './skin';

export type AtmoLevel = 'off' | 'soft' | 'on' | 'strong';

const LS_THEME = 'helmsman-theme';
const LS_ATMO = 'helmsman-atmo';
const LS_RADIUS = 'helmsman-radius';

function readLS(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function readRadius(): number {
  const n = Number(readLS(LS_RADIUS, '8'));
  return Number.isFinite(n) ? Math.min(16, Math.max(4, Math.round(n))) : 8;
}

export function applyRadius(n: number) {
  const r = document.documentElement.style;
  r.setProperty('--r-sm', Math.max(4, n - 2) + 'px');
  r.setProperty('--r-md', n + 'px');
  r.setProperty('--r-lg', n + 4 + 'px');
}

interface ThemeState {
  themeId: string; // 'mist' | 'night' | ... | 'system'
  atmo: AtmoLevel;
  /** --r-md base (px), with --r-sm / --r-lg derived from it */
  radius: number;
  setTheme: (id: string) => void;
  setAtmo: (level: AtmoLevel) => void;
  setRadius: (n: number) => void;
}
export const useThemeStore = create<ThemeState>((set) => ({
  themeId: readLS(LS_THEME, 'mist'),
  atmo: (readLS(LS_ATMO, 'on') as AtmoLevel) || 'on',
  radius: readRadius(),
  setTheme: (id) => {
    localStorage.setItem(LS_THEME, id);
    set({ themeId: id });
  },
  setAtmo: (level) => {
    localStorage.setItem(LS_ATMO, level);
    set({ atmo: level });
  },
  setRadius: (n) => {
    const radius = Math.min(16, Math.max(4, Math.round(n)));
    localStorage.setItem(LS_RADIUS, String(radius));
    applyRadius(radius);
    set({ radius });
  },
}));

/** Inject all tokens of a theme into documentElement (CSSOM) and set the data-theme marker */
export function applyTokens(th: Theme) {
  const r = document.documentElement.style;
  (Object.keys(TK_MAP) as (keyof typeof TK_MAP)[]).forEach((k) => {
    r.setProperty(TK_MAP[k], th.tokens[k]);
  });
  document.documentElement.dataset.theme = th.id;
}

/** Resolve the currently effective theme (including following the system) */
function resolveTheme(themeId: string): Theme {
  return findTheme(themeId);
}

const Ctx = createContext<{ theme: Theme; themeId: string }>({ theme: findTheme('mist'), themeId: 'mist' });
export const useThemeCtx = () => useContext(Ctx);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const themeId = useThemeStore((s) => s.themeId);
  const radius = useThemeStore((s) => s.radius);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(themeId));
  const [skin, setSkin] = useState<UserSkin | null>(() => getActiveSkin());

  // Built-in theme token injection (base layer; skin tokens are layered on top, see applySkin below)
  useEffect(() => {
    applyTokens(theme);
  }, [theme]);

  // Skin injection: token overrides + css + background. While a skin is active it is reapplied on every theme/skin change
  // (skin tokens must sit on top of the latest built-in theme; css/background are independent of the built-in theme).
  // On restore (skin=null), clear the skin injection first, then replay the built-in theme tokens (keys the skin overrode are restored).
  useEffect(() => {
    if (skin) {
      applyTokens(theme);
      applySkin(skin);
    } else {
      clearSkin();
      applyTokens(theme);
    }
  }, [skin, theme]);

  // External skin switching (ThemePicker calls setSkin, exposed by this component, after import/selection)
  useEffect(() => {
    const onStorage = () => setSkin(getActiveSkin());
    window.addEventListener('helmsman-skin-changed', onStorage);
    return () => window.removeEventListener('helmsman-skin-changed', onStorage);
  }, []);

  useEffect(() => {
    applyRadius(radius);
  }, [radius]);

  useEffect(() => {
    setTheme(resolveTheme(themeId));
  }, [themeId]);

  // The system theme follows the OS light/dark switch
  useEffect(() => {
    if (themeId !== SYSTEM_THEME_ID) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(resolveTheme(themeId));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themeId]);

  const value = useMemo(() => ({ theme, themeId }), [theme, themeId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Activate/deactivate a skin (used by ThemePicker; fires helmsman-skin-changed so the Provider applies it). */
export function activateSkin(id: string | null): void {
  setActiveSkin(id);
  window.dispatchEvent(new Event('helmsman-skin-changed'));
}
