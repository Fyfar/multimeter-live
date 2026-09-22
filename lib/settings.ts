// Pure settings model + localStorage persistence.
// Persistence is best-effort: every default reproduces prior behavior, so a missing or
// corrupt store, private mode, or SSR pre-render all degrade to defaults without throwing.
// capNoPartFloor is the only non-obvious knob: capacitance has no OL on lifted probes, so
// a magnitude below this (in nF) counts as "no part connected" and separates one part from
// the next. Floating probes read a clean 0.000 nF, which the Pass/Fail zero check already
// catches — this is a backstop for a small NON-zero stray.
//
// This module must stay free of React and of any component import: scripts/check-settings.mts
// loads it directly under Node's type stripping, with no DOM and no bundler. That is why the
// two valid-value lists below live HERE and are re-exported by the components that render
// them, rather than being imported up from Sidebar/RealtimeChart.

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200] as const;

export const TIME_RANGES = ['10s', '1m', '10m', '1h', 'all'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export type Settings = {
  stabilityCount: number;
  hysteresisPct: number;
  preserveOnModeChange: boolean;
  noDataWarning: boolean;
  noDataAudio: boolean;
  capNoPartFloor: number;
  verdictAudio: boolean;
  // Connection + presentation preferences. Persisted so a reload returns the operator to
  // the setup they were using; restoring them is presentational only and never starts a
  // session (see the session-continuity spec).
  baud: number;
  timeRange: TimeRange;
  autoScale: boolean;
  // Kept as the raw input strings, not numbers: these are free-text fields where '' means
  // "unset", so a half-typed bound round-trips exactly as the operator left it.
  rangeMin: string;
  rangeMax: string;
  stableOnly: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  stabilityCount: 2,
  hysteresisPct: 10,
  preserveOnModeChange: false,
  noDataWarning: true,
  noDataAudio: false,
  // 5 pF. Bench-derived: the nF range resolves to 1 pF and floating probes read a clean
  // 0.000 nF, so the zero check does the work. Kept LOW deliberately — meter accuracy here
  // is 5% + 20 counts, and the old 100 pF default rejected real 100 pF caps outright.
  capNoPartFloor: 0.005,
  verdictAudio: false,
  // These five reproduce the useState initial values app/page.tsx used before they were
  // persisted — a first visit must behave exactly as it did.
  baud: 115200,
  timeRange: '10s',
  autoScale: true,
  rangeMin: '',
  rangeMax: '',
  stableOnly: false,
};

// Bounds, also enforced by the UI inputs. A stability count below 2 cannot confirm a run;
// a hysteresis at/over 100% puts the release at or below zero, at/under 0% never releases.
export const MIN_STABILITY_COUNT = 2;
// Above this the run can never complete at the meter's sample rate, which silently
// stops Pass/Fail capturing and the stable-only filter logging, with no UI signal.
export const MAX_STABILITY_COUNT = 50;
export const MIN_HYSTERESIS_PCT = 1;
export const MAX_HYSTERESIS_PCT = 99;
// A no-part floor of 0 disables the feature (nothing is ever below it), which is a
// legitimate choice; the upper bound just stops a typo swallowing every real part.
export const MIN_NO_PART_FLOOR = 0;
// 10 nF is still 2000x the default — generous as a typo-stop, without the old 1 uF
// ceiling that would have treated every capacitor below 1 uF as "no part".
export const MAX_NO_PART_FLOOR = 10;

const STORAGE_KEY = 'multimeter-live:settings';
// Bumped to 3 when the connection/presentation preferences were added. A mismatch discards
// the whole blob (see loadSettings), so every operator's settings reset once on that deploy
// — accepted rather than carrying migration code in a client-only app.
const SCHEMA_VERSION = 3;

/** Clamp + round to an integer stability count >= MIN_STABILITY_COUNT. */
export const clampStabilityCount = (n: number): number =>
  Math.min(MAX_STABILITY_COUNT, Math.max(MIN_STABILITY_COUNT, Math.round(n)));

/** Clamp the hysteresis percent into the strictly-open (0, 100) band we allow. */
export const clampHysteresisPct = (n: number): number =>
  Math.min(MAX_HYSTERESIS_PCT, Math.max(MIN_HYSTERESIS_PCT, Math.round(n)));

/** Clamp the capacitance no-part floor (nF) into the allowed range. */
export const clampNoPartFloor = (n: number): number =>
  Math.min(MAX_NO_PART_FLOOR, Math.max(MIN_NO_PART_FLOOR, n));

// Validate one field of an untrusted parsed object: finite + in range, else default.
function readNumber(raw: unknown, fallback: number, clamp: (n: number) => number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw) : fallback;
}

const readBoolean = (raw: unknown, fallback: boolean): boolean =>
  typeof raw === 'boolean' ? raw : fallback;

const readString = (raw: unknown, fallback: string): string =>
  typeof raw === 'string' ? raw : fallback;

// Membership test against a fixed list — the right shape for a value whose validity is
// "one of these", not "within a range". An unknown member falls back rather than clamping,
// because there is no meaningful nearest neighbour for an enum.
function readOneOf<T>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/**
 * Read settings from localStorage, validating each field independently and falling back
 * to that field's default. A version mismatch or any parse error discards the whole blob.
 * SSR-safe.
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
      preserveOnModeChange: readBoolean(parsed.preserveOnModeChange, DEFAULT_SETTINGS.preserveOnModeChange),
      noDataWarning: readBoolean(parsed.noDataWarning, DEFAULT_SETTINGS.noDataWarning),
      noDataAudio: readBoolean(parsed.noDataAudio, DEFAULT_SETTINGS.noDataAudio),
      capNoPartFloor: readNumber(
        parsed.capNoPartFloor,
        DEFAULT_SETTINGS.capNoPartFloor,
        clampNoPartFloor,
      ),
      verdictAudio: readBoolean(parsed.verdictAudio, DEFAULT_SETTINGS.verdictAudio),
      baud: readOneOf(parsed.baud, BAUD_RATES, DEFAULT_SETTINGS.baud),
      timeRange: readOneOf(parsed.timeRange, TIME_RANGES, DEFAULT_SETTINGS.timeRange),
      autoScale: readBoolean(parsed.autoScale, DEFAULT_SETTINGS.autoScale),
      rangeMin: readString(parsed.rangeMin, DEFAULT_SETTINGS.rangeMin),
      rangeMax: readString(parsed.rangeMax, DEFAULT_SETTINGS.rangeMax),
      stableOnly: readBoolean(parsed.stableOnly, DEFAULT_SETTINGS.stableOnly),
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

// --- Last-used serial port ---------------------------------------------------------
// A device reference, never measurement data. Kept under its own key rather than inside
// Settings so it is not tied to the settings schema version and never surfaces in the
// Settings UI. Web Serial exposes nothing else identifying — no serial number, no path —
// so VID/PID is the whole of the identity available to us.

const PORT_KEY = 'multimeter-live:port';

export type PortRecord = { usbVendorId: number; usbProductId: number; baudRate: number };

/** Read the last-used port record, or null if absent, partial, or malformed. */
export function loadPortRecord(): PortRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PORT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PortRecord>;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (!ok(p.usbVendorId) || !ok(p.usbProductId) || !ok(p.baudRate)) return null;
    return { usbVendorId: p.usbVendorId, usbProductId: p.usbProductId, baudRate: p.baudRate };
  } catch {
    return null;
  }
}

/** Forget the last-used port, so the next load does not auto-reconnect. Best-effort. */
export function clearPortRecord(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PORT_KEY);
  } catch {
    /* best-effort */
  }
}

/** Persist the last-used port record (best-effort). */
export function savePortRecord(record: PortRecord): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PORT_KEY, JSON.stringify(record));
  } catch {
    /* best-effort */
  }
}
