// Responsibility: skin system (Skin System v2 lightweight model) —— skin pack data model, validation, persistence, injection.
// A skin pack = three optional files (at least one):
//   tokens?  a subset of the 25-key palette (the tokens field of theme.json) —— only overrides the keys the skin has; the rest fall back to the built-in theme
//   css?     theme.css, arbitrary CSS overrides (full makeovers rely on it)
//   bg?      background image (DataURL or URL)
// How it is applied: token overrides via CSSOM setProperty; css via a dynamic <style id="helmsman-skin"> injection;
//   background via body style; one-click restore = remove everything.
import { TK_MAP, type TokenKey } from './themes';

export interface UserSkin {
  id: string;
  name: string;
  /** Subset of the 25 tokens (the tokens field of theme.json; keys must be valid TokenKeys) */
  tokens?: Partial<Record<TokenKey, string>>;
  /** Raw theme.css */
  css?: string;
  /** Background image (DataURL / URL) */
  bg?: string;
  /** Background positioning parameters (optional, corresponding to art.focusX/Y + safeArea) */
  bgFocus?: { x: string; y: string };
  createdAt: number;
}

const LS_SKINS = 'helmsman-skins';
const LS_ACTIVE = 'helmsman-skin-active';

const STYLE_ID = 'helmsman-skin';

/** Read the user skin table (localStorage, tolerates corruption) */
export function loadSkins(): Record<string, UserSkin> {
  try {
    const raw = localStorage.getItem(LS_SKINS);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, UserSkin>;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveSkins(skins: Record<string, UserSkin>): void {
  try {
    localStorage.setItem(LS_SKINS, JSON.stringify(skins));
  } catch {
    // Fails silently when storage is full/disabled (the skin is not persisted but still works for this session)
  }
}

/** Read the active skin id (null if none = built-in theme) */
export function loadActiveSkinId(): string | null {
  try {
    return localStorage.getItem(LS_ACTIVE);
  } catch {
    return null;
  }
}

function saveActiveSkinId(id: string | null): void {
  try {
    if (id == null) localStorage.removeItem(LS_ACTIVE);
    else localStorage.setItem(LS_ACTIVE, id);
  } catch {
    // Same as above, silent
  }
}

/** Validate a skin name (uniqueness is guaranteed by the caller) */
export function validSkinName(name: string): boolean {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 40;
}

/** Validate a token override pack: keys must be in the 25-key allowlist, values must be valid CSS colors/strings. */
export function validateTokens(tokens: unknown): Partial<Record<TokenKey, string>> | null {
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return null;
  const out: Partial<Record<TokenKey, string>> = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (!(k in TK_MAP)) return null; // key outside the allowlist → reject the whole pack (guards against bad packs)
    if (typeof v !== 'string' || v.trim() === '') return null;
    out[k as TokenKey] = v;
  }
  return Object.keys(out).length > 0 ? out : null; // empty object = no valid overrides
}

/** Validate skin JSON text → UserSkin (an id is generated if missing). Returns null = bad pack. */
export function parseSkinJson(text: string): UserSkin | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const name = typeof p.name === 'string' && validSkinName(p.name) ? p.name.trim() : null;
  const tokens = p.tokens !== undefined ? validateTokens(p.tokens) : undefined;
  // tokens present but invalid (key outside the allowlist / bad value) → reject the whole pack
  if (p.tokens !== undefined && tokens === null) return null;
  const css = typeof p.css === 'string' && p.css.trim() ? p.css : undefined;
  const bg = typeof p.bg === 'string' && p.bg.startsWith('data:') ? p.bg : undefined;
  // At least one valid piece of content (name is only metadata and doesn't count)
  if (!tokens && !css && !bg) return null;
  return {
    id: typeof p.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(p.id) ? p.id : genSkinId(),
    name: name ?? 'Untitled skin',
    ...(tokens ? { tokens } : {}),
    ...(css ? { css } : {}),
    ...(bg ? { bg } : {}),
    createdAt: Date.now(),
  };
}

/** Generate a skin id (timestamp + random) */
export function genSkinId(): string {
  return 'skin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/** Parse a zip skin pack (theme.css + optional theme.json/background). Minimal zip parsing (no dependencies). */
export async function parseSkinZip(file: File): Promise<UserSkin | null> {
  const MAX_ZIP = 2 * 1024 * 1024; // zip ≤ 2 MiB
  const MAX_CSS = 512 * 1024; // css ≤ 512 KiB
  if (file.size > MAX_ZIP) return null;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const entries = parseZipEntries(buf);
    const themeJson = entries.find((e) => e.name.endsWith('theme.json'));
    const themeCss = entries.find((e) => e.name.endsWith('theme.css'));
    const bg = entries.find((e) => e.name.match(/background\.(png|jpe?g|gif|webp)$/i));
    if (!themeJson && !themeCss && !bg) return null;
    let meta: Record<string, unknown> = {};
    if (themeJson) {
      try {
        meta = JSON.parse(decoder.decode(themeJson.data)) as Record<string, unknown>;
      } catch {
        return null; // bad theme.json → reject the pack
      }
    }
    const tokens = meta.tokens !== undefined ? validateTokens(meta.tokens) : undefined;
    if (meta.tokens !== undefined && tokens === null) return null; // bad tokens → reject the pack
    const name = typeof meta.name === 'string' && validSkinName(meta.name) ? meta.name.trim() : 'zip skin';
    let css: string | undefined;
    if (themeCss) {
      if (themeCss.data.length > MAX_CSS) return null;
      css = decoder.decode(themeCss.data);
      if (!css.trim()) css = undefined;
    }
    let bgData: string | undefined;
    if (bg) {
      bgData = toDataUrl(bg.name, bg.data);
      if (!bgData) return null;
    }
    if (!tokens && !css && !bgData) return null;
    return {
      id: typeof meta.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(meta.id) ? meta.id : genSkinId(),
      name,
      ...(tokens ? { tokens } : {}),
      ...(css ? { css } : {}),
      ...(bgData ? { bg: bgData } : {}),
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}

const decoder = new TextDecoder('utf-8');

/** Minimal zip entry parsing: find local file headers (PK\x03\x04) and advance by each entry's data length (store/uncompressed only). */
function parseZipEntries(buf: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const out: Array<{ name: string; data: Uint8Array }> = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  while (i + 30 <= buf.length) {
    if (view.getUint32(i, true) !== 0x04034b50) break; // local file header signature
    const method = view.getUint16(i + 8, true); // 0 = store (uncompressed)
    const compSize = view.getUint32(i + 18, true);
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const name = decoder.decode(buf.subarray(i + 30, i + 30 + nameLen));
    const dataStart = i + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (method === 0 && dataEnd <= buf.length) {
      out.push({ name, data: buf.subarray(dataStart, dataEnd) });
    }
    i = dataEnd > i ? dataEnd : i + 1;
  }
  return out;
}

function toDataUrl(name: string, data: Uint8Array): string | null {
  const mime = name.match(/\.(png)$/i) ? 'image/png'
    : name.match(/\.(jpe?g)$/i) ? 'image/jpeg'
    : name.match(/\.(gif)$/i) ? 'image/gif'
    : name.match(/\.(webp)$/i) ? 'image/webp'
    : null;
  if (!mime) return null;
  let bin = '';
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
  return 'data:' + mime + ';base64,' + btoa(bin);
}

// ---------- Injection / restore ----------

/** Apply a skin: token overrides (CSSOM) + css (<style> injection) + background (body). */
export function applySkin(skin: UserSkin): void {
  const doc = document.documentElement;
  const r = doc.style;
  // 1) token overrides: only set the keys the skin has (the rest fall back to the values the built-in theme already set)
  if (skin.tokens) {
    for (const [k, v] of Object.entries(skin.tokens)) {
      const varName = TK_MAP[k as TokenKey];
      if (varName) r.setProperty(varName, v);
    }
  }
  // 2) theme.css: dynamic <style> injection (replaced as a whole)
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (skin.css) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = skin.css;
  } else if (styleEl) {
    styleEl.remove();
  }
  // 3) Background
  const body = document.body;
  if (skin.bg) {
    const pos = skin.bgFocus ? `${skin.bgFocus.x} ${skin.bgFocus.y}` : '50% 0%';
    body.style.backgroundImage = `url("${skin.bg}")`;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = pos;
    body.style.backgroundAttachment = 'fixed';
  } else {
    body.style.backgroundImage = '';
    body.style.backgroundSize = '';
    body.style.backgroundPosition = '';
    body.style.backgroundAttachment = '';
  }
  doc.dataset.skin = skin.id;
}

/** One-click restore: remove the skin injection (tokens are re-set by the built-in theme, coordinated by ThemeProvider). */
export function clearSkin(): void {
  const styleEl = document.getElementById(STYLE_ID);
  if (styleEl) styleEl.remove();
  const body = document.body;
  body.style.backgroundImage = '';
  body.style.backgroundSize = '';
  body.style.backgroundPosition = '';
  body.style.backgroundAttachment = '';
  delete document.documentElement.dataset.skin;
}

// ---------- Skin table management ----------

export function saveSkin(skin: UserSkin): void {
  const skins = loadSkins();
  skins[skin.id] = skin;
  saveSkins(skins);
}

export function deleteSkin(id: string): void {
  const skins = loadSkins();
  delete skins[id];
  saveSkins(skins);
  if (loadActiveSkinId() === id) {
    saveActiveSkinId(null);
    clearSkin();
  }
}

export function getActiveSkin(): UserSkin | null {
  const id = loadActiveSkinId();
  if (!id) return null;
  return loadSkins()[id] ?? null;
}

export function setActiveSkin(id: string | null): void {
  saveActiveSkinId(id);
}
