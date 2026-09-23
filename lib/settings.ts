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

// What each range MEANS, kept beside the list of ranges so one module owns it.
export const TIME_RANGE_MS: Record<TimeRange, number> = {
  '10s': 10_000,
  '1m': 60_000,
  '10m': 600_000,
  '1h': 3_600_000,
  // Infinity disables the chart's window filter so every buffered point is plotted.
  all: Infinity,
};

// Tick spacing per range. With the x-axis pinned (see resolveTimeWindow) Chart.js would
// otherwise place ticks on round EPOCH values, whose offsets from the present are
// arbitrary — '-3587s' instead of '-3600s'. A fixed step makes every label a round
// multiple of the step away from the present AND puts one label on the present itself.
// Each divides its range into 5-6 intervals, under the chart's maxTicksLimit of 9.
// 'all' has no fixed window, so Chart.js keeps choosing.
export const TIME_RANGE_STEP_MS: Record<TimeRange, number | undefined> = {
  '10s': 2_000,
  '1m': 10_000,
  '10m': 120_000,
  '1h': 600_000,
  all: undefined,
};

/** The line chart's x-axis range. Every field undefined => let the axis fit the data. */
export type TimeWindow = { min?: number; max?: number; stepSize?: number };

/**
 * Resolve the chart's x-axis range for `range`, given when the session started and what
 * time it is now.
 *
 * A bounded range spans exactly its window, so pixels-per-second is a CONSTANT and two
 * equal durations occupy equal width. While the session is younger than the window the
 * span is anchored at its start — the trace fills from the left and nothing already
 * drawn moves; after that it rolls with the clock, newest at the right edge. Those are
 * the two arms of one `max()`, so the handover is continuous: at elapsed === windowMs
 * both arms give the same span, with no jump to hide.
 *
 * The anchor is the SESSION start, never the oldest buffered point. The buffer is trimmed,
 * so its oldest point describes retention, not the session. It did once diverge outright:
 * a 3600-sample cap held only 20 minutes at 3 samples/second, so the oldest point at '1h'
 * was permanently newer than `now - 1h` and the window would have stayed in its filling
 * phase forever, with a dead band on the right that never closed. Retention is stated in
 * time now (BUFFER_RETENTION_MS) and the two agree — keep them separate anyway, so that
 * changing retention cannot silently move the anchor.
 *
 * 'all' has no fixed duration to pin to, so it returns nothing set and the axis fits the
 * data. It is the one range whose scale is not constant, which is inherent: an unbounded
 * span in a fixed width has no constant scale.
 */
/**
 * How much history the chart buffer keeps while a bounded range is active: the longest
 * bounded window, so every bounded view is complete by construction and none can be short
 * of data through trimming.
 *
 * Derived from TIME_RANGE_MS rather than written as a literal. The bug this replaces was a
 * sample COUNT (3600) sized on an assumed ~1 sample/second; the meter delivers 3, so it
 * retained 20 minutes and the '1h' view could never be whole. A count cannot know the packet
 * rate. Deriving the span also means adding a range cannot desynchronize retention from what
 * the views need — though it does make adding a long range a memory decision.
 */
export const BUFFER_RETENTION_MS: number = Math.max(
  ...Object.values(TIME_RANGE_MS).filter((ms) => Number.isFinite(ms)),
);

/**
 * Index of the first point at or after `fromX`, by binary search. The chart buffer is
 * appended in timestamp order, so the visible window is a tail slice and finding where it
 * starts costs O(log n) instead of a scan — and, since the buffer is already in the chart's
 * shape, the slice IS the dataset rather than a per-sample rebuild of it.
 *
 * Returns `points.length` when every point is older than `fromX` (an empty window).
 *
 * Assumes `points` is sorted by `x`, which the chart buffer is: it is appended in arrival
 * order. `normalized: true` and the decimation plugin already assume the same, so this is
 * not a new requirement. Duplicate timestamps are fine and expected — a batch parsed inside
 * one millisecond stamps several readings identically — and the first of the run is
 * returned, which is the correct edge for trimming.
 *
 * A backwards clock step breaks the assumption for as long as the jump lasts. A sub-second
 * NTP slew puts the window edge off by a sample or two. A LARGE backwards step is worse than
 * that: the search runs on unsorted data, converges to 0, and nothing is trimmed, so the
 * chart buffer grows unbounded until the clock catches up. It cannot throw and cannot corrupt
 * anything — it is memory growth that self-heals.
 */
export function firstIndexInWindow(points: readonly { x: number }[], fromX: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x < fromX) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Tick positions for the time axis: multiples of `step` away from `now`, clipped to
 * [`min`, `max`].
 *
 * Anchored to the PRESENT, not to `min`. Chart.js generates ticks from the axis minimum,
 * which is only aligned with the present in the rolling phase (`min === now - window`).
 * While a young session's window is still filling, `min` is the session start — an
 * arbitrary instant — so every label carried an arbitrary remainder and no tick landed on
 * `now` at all, leaving the view with no `Now` marker. Generating from `now` makes the
 * present a tick by construction in both phases.
 */
export function timeAxisTicks(min: number, max: number, step: number, now: number): number[] {
  if (!(step > 0) || !Number.isFinite(min) || !Number.isFinite(max)) return [];
  const ticks: number[] = [];
  const first = now + Math.ceil((min - now) / step) * step;
  for (let v = first; v <= max; v += step) ticks.push(v);
  return ticks;
}

export function resolveTimeWindow(
  range: TimeRange,
  sessionStart: number | null,
  now: number,
): TimeWindow {
  const windowMs = TIME_RANGE_MS[range];
  if (!Number.isFinite(windowMs)) return {};
  // Clamped to `now`: Date.now() can step backwards (NTP, a manual clock change), and a
  // start in the future would put the whole window ahead of the present, showing nothing.
  const start = Math.min(sessionStart ?? now, now);
  const min = Math.max(start, now - windowMs);
  return { min, max: min + windowMs, stepSize: TIME_RANGE_STEP_MS[range] };
}

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
