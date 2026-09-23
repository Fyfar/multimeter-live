// Pure, framework-free parser for the multimeter's continuous serial stream.
//
// The meter emits packets with NO reliable newline delimiter, e.g.:
//   "Voltage:-0.0004 V"  "Voltage:00.145 mV"  "Electricity:00.000 mA"
//   "Resistance:0L. OM"  "Resistance:.0L MOM" "beep:. OM" "Diode:0.L V"
//   "Cap:00.000 nF"
// We accumulate raw chunks in a buffer and only emit a measurement once the
// *next* token delimits its end, so a chunk cut mid-word never loses data.

export type Mode =
  | 'VOLTAGE'
  | 'CURRENT'
  | 'RESISTANCE'
  | 'CONTINUITY'
  | 'DIODE'
  | 'CAPACITANCE';

// Human-readable label for each mode (shared by DigitalDisplay + DataLog).
export const MODE_LABELS: Record<Mode, string> = {
  VOLTAGE: 'DC Voltage',
  CURRENT: 'DC Current',
  RESISTANCE: 'Resistance',
  CONTINUITY: 'Continuity',
  DIODE: 'Diode',
  CAPACITANCE: 'Capacitance',
};

export interface Reading {
  mode: Mode;
  value: number | null; // null = Out-of-Limit (OL) or not-yet-measured
  display: string; // what the digital readout shows: "00.145", "-0.0004", "OL", "---"
  unit: string; // 'V','mV','A','mA','OM','KOM','MOM','nF', '' if none
  isOverload: boolean;
  // Mid-measurement: the meter sends dashes ("-.--") — digit-free but no 'L'. A charging
  // capacitor reads this, so it never reports a wrong intermediate NUMBER. value === null.
  isMeasuring: boolean;
  ts: number; // Date.now() when parsed
}

// Leading token (as the meter sends it) -> logical mode.
const TOKENS: Record<string, Mode> = {
  'Voltage:': 'VOLTAGE',
  'Electricity:': 'CURRENT',
  'Resistance:': 'RESISTANCE',
  'beep:': 'CONTINUITY',
  'Diode:': 'DIODE',
  'Cap:': 'CAPACITANCE',
};

const TOKEN_LIST = Object.keys(TOKENS);
const MAX_TOKEN_LEN = Math.max(...TOKEN_LIST.map((t) => t.length));
const MAX_BUFFER = 4096; // safety net against unbounded growth on junk input

// Longest-first so "mV" is not read as "V", "MOM"/"KOM" not "OM". An unrecognized unit
// parses to unit='' which skips page.tsx's mode/unit-change guard entirely — the reading
// is then recorded at the PREVIOUS unit's scale with nothing looking wrong. All three
// micro spellings ('u', U+00B5, U+03BC) are listed: what the ZT703s sends above nF is
// unconfirmed, and an extra entry costs nothing.
const UNIT_RE = /(MOM|KOM|mV|mA|pF|nF|uF|\u00B5F|\u03BCF|mF|OM|V|A)\s*$/;
const RE_OVERLOAD = /L/i;
const RE_DIGIT = /[0-9]/;
const RE_NON_NUM = /[^0-9.+-]/g;

// Scale every unit to a canonical base so a mid-stream unit switch (mV -> V)
// does not make the chart jump. The digital readout still shows the raw unit.
const SCALE: Record<string, { base: string; factor: number }> = {
  V: { base: 'V', factor: 1 },
  mV: { base: 'V', factor: 1e-3 },
  A: { base: 'A', factor: 1 },
  mA: { base: 'A', factor: 1e-3 },
  OM: { base: 'OM', factor: 1 },
  KOM: { base: 'OM', factor: 1e3 },
  MOM: { base: 'OM', factor: 1e6 },
  // Capacitance is based on nF (not F) — changing that base would re-scale the chart,
  // statistics, histogram binning and readingResolution for every capacitance session.
  pF: { base: 'nF', factor: 1e-3 },
  nF: { base: 'nF', factor: 1 },
  uF: { base: 'nF', factor: 1e3 },
  '\u00B5F': { base: 'nF', factor: 1e3 },
  '\u03BCF': { base: 'nF', factor: 1e3 },
  mF: { base: 'nF', factor: 1e6 },
};

// The meter spells ohms in ASCII — `OM`/`KOM`/`MOM` — because its protocol has no room
// for a symbol. That is a WIRE spelling, not something to show an operator: Pass/Fail's
// entry units already render `Ω` (ENTRY_UNITS), so leaving the readout as `OM` made one
// app disagree with itself about what unit a resistance is in.
//
// Display-only. `Reading.unit` keeps the raw token, and so does the CSV export — the wire
// spelling is the stable one for data interchange, and every capture rule and the SCALE
// table above key off it.
const DISPLAY_UNITS: Record<string, string> = {
  OM: '\u03A9',   // Ω
  KOM: 'k\u03A9', // kΩ
  MOM: 'M\u03A9', // MΩ
};

/** The operator-facing spelling of a raw meter unit. Unmapped units pass through. */
export const displayUnit = (unit: string): string => DISPLAY_UNITS[unit] ?? unit;

interface FoundToken {
  index: number;
  token: string;
}

/** Find the earliest known token in `buf` at or after `from`. */
function findToken(buf: string, from: number): FoundToken | null {
  let best = -1;
  let bestToken = '';
  for (const token of TOKEN_LIST) {
    const i = buf.indexOf(token, from);
    if (i !== -1 && (best === -1 || i < best)) {
      best = i;
      bestToken = token;
    }
  }
  return best === -1 ? null : { index: best, token: bestToken };
}

/** Parse a single "<token><body>" measurement into a Reading. */
export function parseMeasurement(mode: Mode, token: string, body: string): Reading {
  const trimmed = body.trim();
  const m = trimmed.match(UNIT_RE);
  const unit = m ? m[1] : '';
  const numPart = (m ? trimmed.slice(0, m.index) : trimmed).trim();

  // Any 'L' marks Out-of-Limit / Overload (0L, .0L, 0.L, .L).
  const isOverload = RE_OVERLOAD.test(numPart);
  const hasDigit = RE_DIGIT.test(numPart);

  // Digit-free without an 'L' = the meter's "measuring, not ready" dashes.
  const isMeasuring = !isOverload && !hasDigit;

  let value: number | null;
  let display: string;
  if (isOverload || !hasDigit) {
    value = null;
    display = isMeasuring ? '---' : 'OL';
  } else {
    const n = Number.parseFloat(numPart.replace(RE_NON_NUM, ''));
    value = Number.isFinite(n) ? n : null;
    display = numPart; // preserve the meter's formatting, e.g. "00.145"
  }

  return { mode, value, display, unit, isOverload, isMeasuring, ts: Date.now() };
}

/** Project a Reading onto its canonical base unit for charting. */
export function normalizeReading(r: Reading): { baseValue: number | null; baseUnit: string } {
  const scale = SCALE[r.unit];
  const baseUnit = scale ? scale.base : r.unit;
  const baseValue = r.value === null || !scale ? r.value : r.value * scale.factor;
  return { baseValue, baseUnit };
}

/** Fractional-digit count of a meter display string ("00.145" → 3, "123" → 0). */
export function displayDecimals(display: string): number {
  const dotIdx = display.indexOf('.');
  return dotIdx === -1 ? 0 : display.length - dotIdx - 1;
}

/** Decimal places to represent values at a given step/width (1 → 0, 0.001 → 3), clamped to [0, 20]. */
export function resolutionDecimals(width: number): number {
  return Math.min(20, Math.max(0, -Math.floor(Math.log10(width))));
}

/**
 * Least-significant-digit step of a reading, in its base unit: decimals of the meter's
 * `display` × the unit's scale factor, so it lines up with `baseValue`.
 * e.g. "09.977" KOM -> 0.001 kΩ × 1e3 = 1 Ω. Null for OL / no unit.
 */
export function readingResolution(r: Reading): number | null {
  if (!r.unit || r.value === null) return null;
  const lsdDisplay = Math.pow(10, -displayDecimals(r.display));
  const factor = SCALE[r.unit]?.factor ?? 1;
  return lsdDisplay * factor;
}

/**
 * Band half-width, in least-significant digits, within which a reading still counts as
 * the same measurement. Exact equality never builds a run — the last digit dithers, and
 * the ZT703s specs 20 counts of noise on the nF range, so 1-2 LSD left a held part
 * flickering PASS -> Settling -> PASS. A real transient (probe lift) moves 10^3-10^4 LSD,
 * so widening is nearly free. Retune here — but note this is now also the chart's
 * auto-scale y-floor (RealtimeChart), deliberately, so the app has ONE number meaning
 * "a change smaller than this is not a measurement". Changing it moves both.
 */
export const STABLE_LSD_TOLERANCE = 20;

/** Whether `value` belongs to the run anchored at `anchor` (both base-unit; `lsd` from
 *  `readingResolution`). Falls back to exact equality when the resolution is unknown. */
export function withinStableBand(value: number, anchor: number, lsd: number | null): boolean {
  if (lsd === null) return value === anchor;
  // Tiny relative slack: the band edge is reached by float arithmetic on scaled units.
  return Math.abs(value - anchor) <= lsd * STABLE_LSD_TOLERANCE * (1 + 1e-9);
}

export interface StreamParser {
  push(chunk: string): Reading[];
  reset(): void;
}

/** Stateful, buffer-safe parser. Feed it raw chunks; get back complete Readings. */
export function createParser(): StreamParser {
  let buffer = '';

  return {
    push(chunk: string): Reading[] {
      buffer += chunk;
      const out: Reading[] = [];

      for (;;) {
        const first = findToken(buffer, 0);
        if (!first) {
          // No token yet. Keep only a short tail that might hold the start of a
          // token split across chunk boundaries.
          if (buffer.length > MAX_TOKEN_LEN) buffer = buffer.slice(-MAX_TOKEN_LEN);
          break;
        }

        // Drop any leading garbage before the first token.
        if (first.index > 0) buffer = buffer.slice(first.index);

        const next = findToken(buffer, first.token.length);
        if (!next) {
          // The first measurement is not yet delimited — wait for more data.
          // If something is wedged, drop the stuck token to make progress.
          if (buffer.length > MAX_BUFFER) buffer = buffer.slice(first.token.length);
          break;
        }

        const body = buffer.slice(first.token.length, next.index);
        out.push(parseMeasurement(TOKENS[first.token], first.token, body));
        buffer = buffer.slice(next.index);
      }

      return out;
    },

    reset() {
      buffer = '';
    },
  };
}
