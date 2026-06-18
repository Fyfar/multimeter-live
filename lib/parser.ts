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

export interface Reading {
  mode: Mode;
  raw: string; // original token + body, kept for debugging
  value: number | null; // null = Out-of-Limit (OL) or no reading
  display: string; // what the digital readout shows: "00.145", "-0.0004", "OL"
  unit: string; // 'V','mV','A','mA','OM','KOM','MOM','nF', '' if none
  isOverload: boolean;
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

// Units ordered longest-first so "mV" is not read as "V", "MOM"/"KOM" not "OM".
const UNIT_RE = /(MOM|KOM|mV|mA|nF|OM|V|A)\s*$/;
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
  nF: { base: 'nF', factor: 1 },
};

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

  let value: number | null;
  let display: string;
  if (isOverload || !hasDigit) {
    value = null;
    display = 'OL';
  } else {
    const n = Number.parseFloat(numPart.replace(RE_NON_NUM, ''));
    value = Number.isFinite(n) ? n : null;
    display = numPart; // preserve the meter's formatting, e.g. "00.145"
  }

  return { mode, raw: token + body, value, display, unit, isOverload, ts: Date.now() };
}

/** Project a Reading onto its canonical base unit for charting. */
export function normalizeReading(r: Reading): { baseValue: number | null; baseUnit: string } {
  const scale = SCALE[r.unit];
  const baseUnit = scale ? scale.base : r.unit;
  const baseValue = r.value === null || !scale ? r.value : r.value * scale.factor;
  return { baseValue, baseUnit };
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
