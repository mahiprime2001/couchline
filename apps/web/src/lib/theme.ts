export type Theme = 'dark' | 'light';

export const ACCENTS = ['#7c5cff', '#3b82f6', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#a855f7'] as const;
const DEFAULT_ACCENT = '#7c5cff';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function getTheme(): Theme {
  const t = read('wp-theme');
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function getAccent(): string {
  const a = read('wp-accent');
  return a && /^#[0-9a-f]{6}$/i.test(a) ? a : DEFAULT_ACCENT;
}

/** Black or white, whichever is readable on top of the accent colour. */
function onAccent(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  return lum > 0.4 ? '#111111' : '#ffffff';
}

export function applyTheme(theme: Theme = getTheme(), accent: string = getAccent()): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-2', `color-mix(in srgb, ${accent} 70%, white)`); // the lighter shade used for links and the logo
  root.style.setProperty('--on-accent', onAccent(accent));
}

export function saveTheme(theme: Theme, accent: string): void {
  try {
    localStorage.setItem('wp-theme', theme);
    localStorage.setItem('wp-accent', accent);
  } catch {
    /* private mode: the choice just lasts for this visit */
  }
  applyTheme(theme, accent);
}
