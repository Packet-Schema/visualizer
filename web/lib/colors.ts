// OKLch to sRGB conversion (CSS Color Module Level 4)
function oklchToRgb(oklch: string): string {
  const match = oklch.match(
    /oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/,
  );
  if (!match) return oklch;

  const L = parseFloat(match[1]) / 100;
  const C = parseFloat(match[2]);
  const H = parseFloat(match[3]) * (Math.PI / 180);
  const alpha = match[4] ? parseFloat(match[4]) : 1;

  const a = C * Math.cos(H);
  const b = C * Math.sin(H);

  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;

  const r = +4.0767416621 * l3 - 3.3077363322 * m3 + 0.2309101289 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193761 * s3;
  const b_ = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  const toLinear = (v: number) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const R = clamp(toLinear(r));
  const G = clamp(toLinear(g));
  const B = clamp(toLinear(b_));

  const toHex = (v: number) => v.toString(16).padStart(2, "0").toUpperCase();
  if (alpha < 1) {
    const alphaInt = Math.round(alpha * 255);
    return `#${toHex(R)}${toHex(G)}${toHex(B)}${toHex(alphaInt)}`;
  }
  return `#${toHex(R)}${toHex(G)}${toHex(B)}`;
}

export function convertOklchInString(value: string): string {
  return value.replace(
    /oklch\([\d.]+%\s+[\d.]+\s+[\d.]+(?:\s*\/\s*[\d.]+)?\)/g,
    oklchToRgb,
  );
}

export type DiagramTheme = {
  background: string;
  rowEven: string;
  rowOdd: string;
  rulerTick: string;
  rulerLabel: string;
  accent: string;
  fieldStroke: string;
  fieldLabel: string;
  fieldSublabel: string;
  fieldContinuation: string;
  markerAccent: string;
  markerAccentSoft: string;
  subfieldBackground: string;
  subfieldLabel: string;
  /** Pre-computed color (with alpha) for the encrypted-field diagonal stripe. */
  encryptedStripe: string;
  fieldFillOpacity: number;
  rulerMinorOpacity: number;
  subfieldBackgroundOpacity: number;
  fieldPalette: Record<string, string>;
};

export function createExportTheme(theme: DiagramTheme): DiagramTheme {
  return {
    background: oklchToRgb(theme.background),
    rowEven: oklchToRgb(theme.rowEven),
    rowOdd: oklchToRgb(theme.rowOdd),
    rulerTick: oklchToRgb(theme.rulerTick),
    rulerLabel: oklchToRgb(theme.rulerLabel),
    accent: oklchToRgb(theme.accent),
    fieldStroke: oklchToRgb(theme.fieldStroke),
    fieldLabel: oklchToRgb(theme.fieldLabel),
    fieldSublabel: oklchToRgb(theme.fieldSublabel),
    fieldContinuation: oklchToRgb(theme.fieldContinuation),
    markerAccent: oklchToRgb(theme.markerAccent),
    markerAccentSoft: oklchToRgb(theme.markerAccentSoft),
    subfieldBackground: oklchToRgb(theme.subfieldBackground),
    subfieldLabel: oklchToRgb(theme.subfieldLabel),
    encryptedStripe: oklchToRgb(theme.encryptedStripe),
    fieldFillOpacity: theme.fieldFillOpacity,
    rulerMinorOpacity: theme.rulerMinorOpacity,
    subfieldBackgroundOpacity: theme.subfieldBackgroundOpacity,
    fieldPalette: Object.fromEntries(
      Object.entries(theme.fieldPalette).map(([key, value]) => [
        key,
        oklchToRgb(value),
      ]),
    ),
  };
}
