// A plugin's palette guardrails — the same code as the app's PluginPalette.kt (thresholds from contract.json).
import { contract } from "./contract.mjs";

const T = () => contract.manifest.theme;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

export function luminance(hex) {
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
function lab(hex) {
  const [r, g, b] = rgb(hex).map(lin);
  const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE between two #RRGGBB colors (D65). */
export function deltaE(a, b) {
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Floored to one decimal with integer arithmetic only: the same text as the app's formatRatio. */
export function formatRatio(x) {
  const n = Math.floor(x * 10);
  return `${Math.floor(n / 10)},${n % 10}`;
}
const ratio = formatRatio;

const INVALID = (token, tail) => `theme.${token}: no es un color #RRGGBB válido${tail}`;

/** { accent, onAccent, background, surface, highlight, kept, warnings } — exactly what the app's resolve gives. Never throws. */
export function resolvePalette(theme) {
  const t = T();
  const nearRed = (c) => deltaE(c, t.brandRed) < t.minBrandDeltaE;
  const src = theme && typeof theme === "object" && !Array.isArray(theme) ? theme : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  // Valid colors come back uppercased; a declared-but-malformed one is null; an undeclared one is undefined.
  const get = (k) => (!has(k) ? undefined : typeof src[k] === "string" && HEX.test(src[k]) ? src[k].toUpperCase() : null);
  const warnings = [];
  const kept = [];
  const out = { ...t.defaults };
  const bg = get("background");
  if (bg !== undefined) {
    if (bg === null) warnings.push(INVALID("background", "; se usa el de Kino"));
    else if (nearRed(bg)) warnings.push("theme.background: se parece demasiado al rojo de Kino; se usa el de Kino");
    else if (luminance(bg) > t.maxBackgroundLuminance) warnings.push("theme.background: es demasiado claro (el fondo debe ser oscuro); se usa el de Kino");
    else { out.background = bg; kept.push("background"); }
  }
  const sf = get("surface");
  if (sf !== undefined) {
    if (sf === null) warnings.push(INVALID("surface", "; se usa el de Kino"));
    else if (nearRed(sf)) warnings.push("theme.surface: se parece demasiado al rojo de Kino; se usa el de Kino");
    else if (luminance(sf) > t.maxSurfaceLuminance) warnings.push("theme.surface: es demasiado claro; se usa el de Kino");
    else if (contrast(sf, out.background) < t.minSurfaceContrast) warnings.push(`theme.surface: no se distingue del fondo (contraste ${ratio(contrast(sf, out.background))}:1, mínimo 1,05:1); se usa el de Kino`);
    else { out.surface = sf; kept.push("surface"); }
  }
  const rawA = get("accent");
  const rawOn = get("onAccent");
  if (rawA !== undefined || rawOn !== undefined) {
    const a = rawA || t.defaults.accent;
    const on = rawOn || t.defaults.onAccent;
    let problem = null;
    if (rawA === null) problem = INVALID("accent", "");
    else if (rawOn === null) problem = INVALID("onAccent", "");
    else if (rawA !== undefined && nearRed(a)) problem = "theme.accent: se parece demasiado al rojo de Kino";
    else if (rawOn !== undefined && nearRed(on)) problem = "theme.onAccent: se parece demasiado al rojo de Kino";
    else if (contrast(a, out.background) < t.minUiContrast) problem = `theme.accent: no se distingue sobre el fondo (contraste ${ratio(contrast(a, out.background))}:1, mínimo 3:1)`;
    else if (contrast(on, a) < t.minTextContrast) problem = `theme.onAccent: no se lee sobre accent (contraste ${ratio(contrast(on, a))}:1, mínimo 4,5:1)`;
    if (problem) warnings.push(`${problem}; se usan los colores de Kino para accent y onAccent`);
    else {
      out.accent = a;
      out.onAccent = on;
      if (rawA !== undefined) kept.push("accent");
      if (rawOn !== undefined) kept.push("onAccent");
    }
  }
  const hl = get("highlight");
  if (hl !== undefined) {
    if (hl === null) warnings.push(INVALID("highlight", "; se usa el de Kino"));
    else if (nearRed(hl)) warnings.push("theme.highlight: se parece demasiado al rojo de Kino; se usa el de Kino");
    else if (contrast(hl, out.background) < t.minTextContrast) warnings.push(`theme.highlight: no se lee sobre el fondo (contraste ${ratio(contrast(hl, out.background))}:1, mínimo 4,5:1); se usa el de Kino`);
    else { out.highlight = hl; kept.push("highlight"); }
  }
  return { ...out, kept, warnings };
}
