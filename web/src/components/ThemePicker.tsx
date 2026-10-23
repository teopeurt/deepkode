// Responsibility: ThemePicker —— every theme in one grid (built-in + imported custom), with a tag for the source; selecting one applies it.
// Concept: there is no second category called "skin" —— an imported theme is just a theme with a different source (built-in/imported).
// Interaction: click any theme card → apply; built-in themes cannot be deleted, imported ones can; a theme and a custom theme are mutually exclusive (pick one).
// Secondary: UI fine-tuning (radius/atmosphere) applies to the current theme, see FineTuneCard.
import { useRef, useState } from 'react';
import { THEMES, SYSTEM_THEME_ID, TK_MAP, type TokenKey, type Theme } from '../theme/themes';
import { useThemeStore } from '../theme/ThemeProvider';
import { activateSkin } from '../theme/ThemeProvider';
import {
  loadSkins, parseSkinJson, parseSkinZip, saveSkin, deleteSkin, loadActiveSkinId,
  type UserSkin,
} from '../theme/skin';
import { FineTuneCard } from './FineTuneCard';
import { WHALE_SKIN, PAPER_SKIN } from '../theme/demo-skins';

/** Custom theme → grid display shape (reuses the Theme visuals, tag=custom) */
function skinToTheme(s: UserSkin): Theme {
  return {
    id: s.id,
    name: s.name,
    en: [s.tokens ? `tokens ${Object.keys(s.tokens).length}` : '', s.css ? 'css' : '', s.bg ? 'background' : ''].filter(Boolean).join(' · ') || 'custom',
    sw: [
      s.tokens?.canvas ?? s.tokens?.surface ?? '#888',
      s.tokens?.surface ?? s.tokens?.canvas ?? '#888',
      s.tokens?.blue ?? '#888',
    ],
    tag: 'custom',
  };
}

export function ThemePicker() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const [skins, setSkins] = useState<Record<string, UserSkin>>(() => loadSkins());
  const [activeSkinId, setActiveSkinId] = useState<string | null>(() => loadActiveSkinId());
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    setSkins(loadSkins());
    setActiveSkinId(loadActiveSkinId());
  };

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 3000);
  };

  /** Pick a built-in theme → disable the custom theme (mutually exclusive) */
  const pickTheme = (id: string) => {
    if (activeSkinId) {
      activateSkin(null);
      setActiveSkinId(null);
    }
    setTheme(id);
  };

  /** Pick a custom theme → activate it */
  const pickSkin = (id: string) => {
    activateSkin(id);
    refresh();
  };

  /** Export the current look → download theme.json */
  const exportTheme = () => {
    const r = document.documentElement.style;
    const tokens: Partial<Record<TokenKey, string>> = {};
    (Object.keys(TK_MAP) as TokenKey[]).forEach((k) => {
      const v = r.getPropertyValue(TK_MAP[k]).trim();
      if (v) tokens[k] = v;
    });
    const data = {
      id: 'export-' + Date.now().toString(36),
      name: 'Theme export ' + new Date().toLocaleDateString(),
      tokens,
      css: '',
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'helmsman-theme.json';
    a.click();
    URL.revokeObjectURL(a.href);
    flash('Exported theme.json; it can be imported as a custom theme');
  };

  /** Import a theme (.json or .zip) → validate → store → activate */
  const importSkin = async (f: File) => {
    let skin: UserSkin | null = null;
    if (f.name.endsWith('.zip')) {
      skin = await parseSkinZip(f);
      if (!skin) { flash('Bad zip: it must contain theme.css or theme.json (css ≤ 512KiB, zip ≤ 2MiB)'); return; }
    } else if (f.name.endsWith('.json')) {
      const text = await f.text();
      skin = parseSkinJson(text);
      if (!skin) { flash('Bad json: must be { name?, tokens?, css?, bg? }; token keys are limited to the 25-key allowlist'); return; }
    } else {
      flash('Only .json / .zip are supported');
      return;
    }
    const all = loadSkins();
    // Same name overwrites (update), a new id is appended
    const existing = Object.values(all).find((s) => s.name === skin!.name);
    const id = existing ? existing.id : skin.id;
    saveSkin({ ...skin, id });
    activateSkin(id);
    refresh();
    flash(`Imported and applied "${skin.name}"`);
  };

  const removeSkin = (id: string) => {
    deleteSkin(id);
    refresh();
    flash('Theme deleted');
  };

  /** Add and apply a sample theme in one click */
  const applyDemo = (demo: UserSkin) => {
    saveSkin({ ...demo, createdAt: Date.now() });
    activateSkin(demo.id);
    refresh();
    flash(`Applied "${demo.name}"`);
  };

  const customThemes = Object.values(skins).map(skinToTheme);
  const allThemes: Array<Theme & { isCustom: boolean }> = [
    ...THEMES.map((t) => ({ ...t, isCustom: false })),
    ...customThemes.map((t) => ({ ...t, isCustom: true })),
  ];
  const systemSelected = !activeSkinId && themeId === SYSTEM_THEME_ID;

  return (
    <>
      <div className="set-row">
        <div className="lbl">
          Theme
          <div className="desc">Built-in and imported themes are all here; selecting one applies it</div>
        </div>
      </div>

      <div className="theme-grid">
        {allThemes.map((t) => {
          const selected = t.isCustom ? activeSkinId === t.id : !activeSkinId && themeId === t.id;
          return (
            <button
              key={t.id}
              className={'theme-card' + (selected ? ' sel' : '')}
              onClick={() => (t.isCustom ? pickSkin(t.id) : pickTheme(t.id))}
              title={t.isCustom ? 'Click to apply (imported theme)' : 'Click to apply (built-in theme)'}
            >
              <span className="swatches">
                {t.sw.map((c) => <i key={c} style={{ background: c }} />)}
              </span>
              <span className="tn">{t.name}</span>
              <span className="en">{t.en}</span>
              <span className={'tag theme-tag ' + (t.isCustom ? 'custom' : 'builtin')}>
                {t.isCustom ? 'Imported' : 'Built-in'}
              </span>
              {t.isCustom ? (
                <span className="theme-del" onClick={(e) => { e.stopPropagation(); removeSkin(t.id); }} title="Delete theme">×</span>
              ) : null}
            </button>
          );
        })}
        <button className={'theme-card' + (systemSelected ? ' sel' : '')} onClick={() => pickTheme(SYSTEM_THEME_ID)}>
          <span className="swatches">
            <i style={{ background: '#F7F6F3' }} />
            <i style={{ background: '#151412' }} />
          </span>
          <span className="tn">Follow system</span>
          <span className="en">system</span>
          <span className="tag theme-tag builtin">Built-in</span>
        </button>
      </div>

      <div className="skin-actions">
        <button className="btn mini" onClick={() => fileRef.current?.click()}>+ Import theme (json/zip)</button>
        <button className="btn mini ghost" onClick={() => applyDemo(WHALE_SKIN)}>+ Sample · Whale</button>
        <button className="btn mini ghost" onClick={() => applyDemo(PAPER_SKIN)}>+ Sample · Rice-paper makeover</button>
        <button className="btn mini ghost" onClick={exportTheme}>Export current</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importSkin(f);
            e.target.value = '';
          }}
        />
        {msg ? <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>{msg}</span> : null}
      </div>

      <div style={{ marginTop: 14 }}>
        <FineTuneCard />
      </div>
    </>
  );
}
