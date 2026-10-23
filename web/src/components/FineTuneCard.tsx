// Responsibility: fine-tune card (port of Beautiful UI's "Fine-tune Card", MIT © Shane Levine) ——
//   tweaks to the current theme: corner radius / atmosphere opacity. Everything is written to the ThemeStore (localStorage) —— not fake sliders.
//   Theme selection has been merged into the ThemePicker grid (built-in + imported in one list), so the "type" dropdown is no longer repeated here.
import { useThemeStore, type AtmoLevel } from '../theme/ThemeProvider';

const ATMO: { v: AtmoLevel; n: number; label: string }[] = [
  { v: 'off', n: 0, label: 'Off' },
  { v: 'soft', n: 33, label: 'Soft' },
  { v: 'on', n: 66, label: 'Standard' },
  { v: 'strong', n: 100, label: 'Strong' },
];

function atmoOf(n: number): AtmoLevel {
  if (n < 17) return 'off';
  if (n < 50) return 'soft';
  if (n < 83) return 'on';
  return 'strong';
}

export function FineTuneCard() {
  const atmo = useThemeStore((s) => s.atmo);
  const setAtmo = useThemeStore((s) => s.setAtmo);
  const radius = useThemeStore((s) => s.radius);
  const setRadius = useThemeStore((s) => s.setRadius);
  const atmoN = ATMO.find((x) => x.v === atmo)?.n ?? 66;

  return (
    <div className="ftune">
      <div className="ftune-head">
        <span className="ftune-title">Fine-tune the current theme</span>
        <span className="ftune-adj">Radius · atmosphere</span>
      </div>
      <div className="ftune-body">
        <div className="ftune-row">
          <span className="ftune-k">Radius</span>
          <input
            type="range"
            min={4}
            max={16}
            value={radius}
            aria-label="Corner radius"
            onChange={(e) => setRadius(Number(e.target.value))}
          />
          <span className="ftune-n">{radius}</span>
        </div>
        <div className="ftune-row">
          <span className="ftune-k">Atmosphere</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={atmoN}
            aria-label="Atmosphere intensity"
            onChange={(e) => setAtmo(atmoOf(Number(e.target.value)))}
          />
          <span className="ftune-n">{ATMO.find((x) => x.v === atmo)?.label}</span>
        </div>
      </div>
    </div>
  );
}
