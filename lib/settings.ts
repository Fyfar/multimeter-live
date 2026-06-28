// Pure, framework-free settings model + localStorage persistence.
//
// User-tunable knobs:
//   - stabilityCount: consecutive equal readings to confirm "stable" (>= 2)
//   - hysteresisPct:  trigger auto-stop dead-band, percent below threshold (0 < p < 100)
//   - preserveOnModeChange: keep the recorded log across a meter mode/unit change
//   - noDataWarning: show the whole-page warning when connected but no data (default on)
//   - noDataAudio:   sound an audio alert while that warning shows (default off; only
//                    effective when noDataWarning is on)
//
// Persistence is best-effort: every default reproduces the app's prior behavior, so a
// missing/corrupt store, private-mode, or SSR (static export pre-render) all degrade
// gracefully to defaults without throwing.

export type Settings = {
  stabilityCount: number;
  hysteresisPct: number;
  preserveOnModeChange: boolean;
  noDataWarning: boolean;
  noDataAudio: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  stabilityCount: 2,
  hysteresisPct: 10,
  preserveOnModeChange: false,
  noDataWarning: true,
  noDataAudio: false,
};

// Bounds (also enforced by the UI inputs). A stability count below 2 is meaningless
// (you need two readings to confirm equality); a hysteresis at/over 100% would put the
// release level at or below zero, and at/under 0% it would never release.
export const MIN_STABILITY_COUNT = 2;
export const MIN_HYSTERESIS_PCT = 1;
export const MAX_HYSTERESIS_PCT = 99;

const STORAGE_KEY = 'multimeter-live:settings';
const SCHEMA_VERSION = 1;

/** Clamp + round to an integer stability count >= MIN_STABILITY_COUNT. */
export const clampStabilityCount = (n: number): number =>
  Math.max(MIN_STABILITY_COUNT, Math.round(n));

/** Clamp the hysteresis percent into the strictly-open (0, 100) band we allow. */
export const clampHysteresisPct = (n: number): number =>
  Math.min(MAX_HYSTERESIS_PCT, Math.max(MIN_HYSTERESIS_PCT, n));

// Validate one field of an untrusted parsed object: finite + in range, else default.
function readNumber(raw: unknown, fallback: number, clamp: (n: number) => number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw) : fallback;
}

/**
 * Read settings from localStorage, validating each field independently and falling
 * back to that field's default on anything unexpected. A version mismatch (or any
 * parse/read error) discards the whole blob and returns all defaults. Safe to call
 * during SSR / static export — returns defaults when `window` is absent.
 */
export function loadSettings(): Settings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings> & { version?: unknown };
    if (parsed.version !== SCHEMA_VERSION) return DEFAULT_SETTINGS;
    return {
      stabilityCount: readNumber(parsed.stabilityCount, DEFAULT_SETTINGS.stabilityCount, clampStabilityCount),
      hysteresisPct: readNumber(parsed.hysteresisPct, DEFAULT_SETTINGS.hysteresisPct, clampHysteresisPct),
      preserveOnModeChange:
        typeof parsed.preserveOnModeChange === 'boolean'
          ? parsed.preserveOnModeChange
          : DEFAULT_SETTINGS.preserveOnModeChange,
      noDataWarning:
        typeof parsed.noDataWarning === 'boolean'
          ? parsed.noDataWarning
          : DEFAULT_SETTINGS.noDataWarning,
      noDataAudio:
        typeof parsed.noDataAudio === 'boolean'
          ? parsed.noDataAudio
          : DEFAULT_SETTINGS.noDataAudio,
    };
  } catch {
    // Corrupt JSON, blocked storage (private mode), quota — never crash the app.
    return DEFAULT_SETTINGS;
  }
}

/** Persist settings (best-effort). No-ops during SSR or if storage is unavailable. */
export function saveSettings(settings: Settings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, ...settings }));
  } catch {
    // Best-effort: ignore quota / private-mode write failures.
  }
}
