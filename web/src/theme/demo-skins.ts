// Responsibility: sample skin packs (Skin System v2 demo) —— showcase two kinds of makeover:
//   1. "Whale": a token-override skin (deep-sea blue and gold, echoing the 🐳 brand) —— only changes the palette, a few lines of data
//   2. "Rice paper": a full makeover (theme.css) —— changes fonts / radius / sidebar / cards, visibly "a different product"
// Usage: Settings → Theme → import skin (files under web/src/theme/demo-skins/), or use the JSON below directly.
import type { UserSkin } from './skin';

export const WHALE_SKIN: UserSkin = {
  id: 'demo-whale',
  name: 'Whale · Deep-sea blue & gold',
  tokens: {
    canvas: '#0A1424',
    surface: '#101D33',
    surface2: '#16243E',
    line: '#1F3050',
    line2: '#2E4470',
    text: '#E8EEF8',
    text2: '#9FB3D0',
    text3: '#6C82A6',
    ink: '#F4F8FF',
    blue: '#4FA3E8',
    green: '#5BC8A8',
    yellow: '#E8C15A',
    red: '#F0806E',
    gray: '#9FB3D0',
    bgBlue: 'rgba(60,120,210,.24)',
    bgGreen: 'rgba(60,160,130,.22)',
    bgYellow: 'rgba(190,150,50,.22)',
    bgRed: 'rgba(190,70,60,.24)',
    bgGray: 'rgba(255,255,255,.06)',
    onPrimary: '#0A1424',
    toastBg: '#1F3050',
    toastFg: '#E8EEF8',
    shimmer: 'rgba(255,255,255,.06)',
    shadowHover: '0 2px 10px rgba(0,0,0,.3)',
    shadowFloat: '0 12px 32px rgba(0,0,0,.42)',
  },
  createdAt: 0,
};

export const PAPER_SKIN: UserSkin = {
  id: 'demo-paper',
  name: 'Rice paper · Full makeover',
  css: `
/* Rice-paper skin: a full-makeover demo of fonts + radius + sidebar + cards */
:root {
  --font: "Songti SC", "STSong", "Noto Serif SC", Georgia, serif;
  --mono: "SF Mono", "Songti SC", monospace;
  --r-sm: 2px; --r-md: 4px; --r-lg: 8px;
}
body { letter-spacing: .01em; }
#app .sidebar,
.app-sidebar,
aside, nav[class*="side"] {
  background: linear-gradient(180deg, var(--canvas), var(--surface)) !important;
  border-right: 1px solid var(--line) !important;
}
.kcard, .panel, .appr-card, .task-card {
  border-radius: var(--r-lg) !important;
  box-shadow: none !important;
  border: 1px solid var(--line) !important;
}
h1, h2, h3, .kt, .appr-title { font-weight: 600 !important; }
`,
  createdAt: 0,
};

/** Sample skin JSON (can be saved directly as theme.json and imported) */
export const DEMO_JSON = (skin: UserSkin): string => JSON.stringify({
  id: skin.id,
  name: skin.name,
  tokens: skin.tokens,
  css: skin.css ?? '',
}, null, 2);
