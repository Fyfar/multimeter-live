// Pure logic for the Pass/Fail view: SI entry parsing, tolerance bands, verdicts.
// ENTRY UNIT (what the operator types: Ω, V, F) is NOT the internal base unit that
// normalizeReading() produces (parser.ts SCALE). They differ for Capacitance, whose base
// is nF — keeping the two apart is what lets the operator type `22m` and not do maths.

import type { Mode } from '@/lib/parser';

// ---------------------------------------------------------------- SI value parsing

// Case-sensitive between `m` (milli) and `M` (mega): folding them is a 10^9 error that
// still produces a confident verdict. `k`/`K` fold (no collision); micro has 3 spellings.
const SI_MULTIPLIERS: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  'µ': 1e-6, // MICRO SIGN
  'μ': 1e-6, // GREEK SMALL LETTER MU
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
};

const SI_CHARS = 'pnuµμmkKMG';
// "4.7k" / "4700" / "-0.5" — an optional suffix after a plain decimal.
const RE_SUFFIX = new RegExp(`^([+-]?(?:\\d+\\.?\\d*|\\.\\d+))\\s*([${SI_CHARS}])?$`);
// "4k7" — the suffix stands in for the decimal point (standard electronics notation).
const RE_INFIX = new RegExp(`^([+-]?\\d+)([${SI_CHARS}])(\\d+)$`);

/**
 * Parse an operator-entered value with an optional SI suffix. The suffix is ONLY a
 * decimal multiplier — no mode awareness, no plausibility check. Null if unparseable.
 * `explicit` reports whether a suffix was actually written: a BARE tolerance is read in
 * the reference's own SI range (`30` against `300p` means 30 pF), a suffix always wins.
 */
export function parseSiEntry(input: string): { value: number; explicit: boolean } | null {
  const s = input.trim();
  if (s === '') return null;

  const infix = RE_INFIX.exec(s);
  if (infix) {
    const [, intPart, suffix, fracPart] = infix;
    const sign = intPart.startsWith('-') ? -1 : 1;
    const n = Number.parseFloat(`${intPart.replace(/^[+-]/, '')}.${fracPart}`);
    return finite(sign * n * SI_MULTIPLIERS[suffix], true);
  }

  const m = RE_SUFFIX.exec(s);
  if (!m) return null;
  const [, numPart, suffix] = m;
  const n = Number.parseFloat(numPart);
  return suffix ? finite(n * SI_MULTIPLIERS[suffix], true) : finite(n, false);
}

// Checked AFTER the multiplier: a mantissa can be finite and still overflow once scaled
// ("1" + 300 zeros + "G"), and an infinite reference captures FAIL forever and writes
// "Infinity" into the CSV.
function finite(value: number, explicit: boolean) {
  return Number.isFinite(value) ? { value, explicit } : null;
}

/** Value-only form of {@link parseSiEntry}. */
export function parseSiValue(input: string): number | null {
  return parseSiEntry(input)?.value ?? null;
}

// ------------------------------------------------------------------- entry units

/** Voltage/Current have no OL on lifted probes, so per-part capture is undefined there;
 *  Continuity is what the meter's buzzer already is. */
export const SUPPORTED_MODES = ['RESISTANCE', 'DIODE', 'CAPACITANCE'] as const;
export type SupportedMode = (typeof SUPPORTED_MODES)[number];

export function isSupportedMode(mode: Mode | null): mode is SupportedMode {
  return mode !== null && (SUPPORTED_MODES as readonly string[]).includes(mode);
}

/**
 * What the operator types per mode, and the factor to the internal base unit.
 * Capacitance is the odd one: entry is farads, base is nF (parser.ts SCALE).
 */
// `baseUnit` is what normalizeReading must report for the conversion to be valid. An
// unrecognized unit string yields baseUnit '' and SKIPS page.tsx's mode-change reset, so
// without this check a stale ohms reference could be judged as farads.
export const ENTRY_UNITS: Record<
  SupportedMode,
  { label: string; toBase: number; baseUnit: string }
> = {
  RESISTANCE: { label: 'Ω', toBase: 1, baseUnit: 'OM' },
  DIODE: { label: 'V', toBase: 1, baseUnit: 'V' },
  CAPACITANCE: { label: 'F', toBase: 1e9, baseUnit: 'nF' }, // entry farads -> base nF
};

/** Convert a value the operator entered into the internal base unit for `mode`. */
export function entryToBase(mode: SupportedMode, entryValue: number): number {
  return entryValue * ENTRY_UNITS[mode].toBase;
}

// ------------------------------------------------------------------- formatting

const PREFIXES: { exp: number; symbol: string }[] = [
  { exp: 9, symbol: 'G' },
  { exp: 6, symbol: 'M' },
  { exp: 3, symbol: 'k' },
  { exp: 0, symbol: '' },
  { exp: -3, symbol: 'm' },
  { exp: -6, symbol: 'µ' },
  { exp: -9, symbol: 'n' },
  { exp: -12, symbol: 'p' },
];

/** Render a value in its entry unit with the conventional SI prefix ("100 nF", "22 mF",
 *  "4.7 kΩ"). The echo under the reference field: typing `100` in Capacitance shows
 *  "100 F", which is self-evidently not a capacitor. */
export function siPrefixOf(value: number | null): { exp: number; symbol: string } {
  if (value === null || !Number.isFinite(value) || value === 0) {
    return { exp: 0, symbol: '' };
  }
  const abs = Math.abs(value);
  return PREFIXES.find((p) => abs >= Math.pow(10, p.exp)) ?? PREFIXES[PREFIXES.length - 1];
}

export function formatEntryValue(value: number, unitLabel: string): string {
  if (!Number.isFinite(value)) return `— ${unitLabel}`;
  if (value === 0) return `0 ${unitLabel}`;
  const prefix = siPrefixOf(value);
  const scaled = value / Math.pow(10, prefix.exp);
  // Trim trailing zeros so 4.700 reads as 4.7 but 4.703 keeps its digits.
  const text = Number.parseFloat(scaled.toPrecision(4)).toString();
  return `${text} ${prefix.symbol}${unitLabel}`;
}

// ------------------------------------------------------------------ plausibility

/**
 * Bounds (in ENTRY units) outside which a reference is almost certainly a typo — most
 * often an unsuffixed capacitance, where `100` means 100 farads. NOT measured from the
 * ZT703s: advisory only, never a block or clamp, so a loose bound only costs a missing
 * or spurious hint.
 */
const PLAUSIBLE_RANGE: Record<SupportedMode, { min: number; max: number }> = {
  RESISTANCE: { min: 1e-2, max: 9.999e7 }, // 0.01 Ω .. 99.99 MΩ (meter full scale)
  // 0.01 V .. 3.3 V. The max is DERIVED, not assumed: the meter's diode-test open-circuit
  // voltage measures 3.232 V (bench, 2026-09-22), and a constant-current diode test can
  // never display a forward drop larger than the voltage it can supply — a part needing
  // more simply does not conduct and reads OL. 3.3 clears that with accuracy margin, and
  // is also where diode testing practically stops (white/blue LEDs are Vf 3.0–3.4 V).
  DIODE: { min: 1e-2, max: 3.3 },
  CAPACITANCE: { min: 1e-12, max: 9.999e-2 }, // 1 pF .. 99.99 mF (meter full scale)
};

/** Whether an entry-unit reference is within the plausible range for `mode`. */
export function isPlausibleReference(mode: SupportedMode, entryValue: number): boolean {
  const abs = Math.abs(entryValue);
  if (abs === 0) return false;
  const { min, max } = PLAUSIBLE_RANGE[mode];
  return abs >= min && abs <= max;
}

// ------------------------------------------------------------ tolerance + verdict

export type ToleranceMode = 'percent' | 'absolute';

/**
 * Resolve an ABSOLUTE tolerance entry into the mode's entry unit. A bare number inherits
 * the REFERENCE's SI range (`30` against a `300p` reference = ±30 pF); an explicit suffix
 * always wins; with no parseable reference there is no range to inherit, so the entry is
 * taken at face value.
 */
export function resolveAbsoluteTolerance(
  input: string,
  referenceEntry: number | null,
): number | null {
  const parsed = parseSiEntry(input);
  if (parsed === null) return null;
  if (parsed.explicit || referenceEntry === null) return parsed.value;
  return parsed.value * Math.pow(10, siPrefixOf(referenceEntry).exp);
}
export type Verdict = 'PASS' | 'FAIL';

/**
 * Resolve the symmetric tolerance band, in the same units as `reference`.
 * Returns null when the band is unusable (unparseable, negative, or zero-width) —
 * the caller then produces no verdict rather than comparing against a zero band.
 */
// |ref| * pct / 100, not |ref| * (pct/100): 0.01 is not representable.
const rawBand = (reference: number, tolerance: number, mode: ToleranceMode): number =>
  mode === 'percent' ? (Math.abs(reference) * tolerance) / 100 : tolerance;

/**
 * True when the tolerance is parseable and positive but so wide that the accept
 * interval reaches zero. Past that point `judge` accepts a dead short and a negative
 * value alike, so the verdict carries no information: a 400% tolerance on 4k7 accepts
 * -14.1k to 23.5k. The bound is band < |reference| rather than "percent <= 100",
 * because that one rule also catches an absolute tolerance larger than the reference
 * and the 1000x decade jump a bare tolerance can inherit. A zero reference is exempt —
 * it has no scale to be wide relative to.
 */
export function isBandTooWide(reference: number, tolerance: number, mode: ToleranceMode): boolean {
  const band = rawBand(reference, tolerance, mode);
  return (
    Number.isFinite(band) && band > 0 && reference !== 0 && band >= Math.abs(reference)
  );
}

/** Symmetric tolerance band, in `reference`'s units. Null when unusable — unparseable,
 *  non-positive, or wide enough to reach zero (see {@link isBandTooWide}). */
export function resolveBand(
  reference: number,
  tolerance: number,
  mode: ToleranceMode,
): number | null {
  // Negative is rejected outright rather than abs()'d: silently flipping the sign turns
  // a typo into a confident verdict, and the percent path already returned null for it.
  if (!(tolerance > 0)) return null;
  const band = rawBand(reference, tolerance, mode);
  if (!Number.isFinite(band) || band <= 0) return null;
  return isBandTooWide(reference, tolerance, mode) ? null : band;
}

/**
 * PASS when |measured − reference| is within the band, edge inclusive. The epsilon buys
 * that inclusivity: a float-computed band can land a hair under the exact edge, and a
 * part on its tolerance limit must not read FAIL from representation error.
 */
export function judge(measured: number, reference: number, band: number): Verdict {
  const epsilon = Math.abs(band) * 1e-9;
  return Math.abs(measured - reference) <= band + epsilon ? 'PASS' : 'FAIL';
}

/** One captured part. Reference and tolerance are stored as they were AT CAPTURE, so a
 *  later edit never rewrites verdict history. */
export interface VerdictRow {
  id: number;
  ts: number;
  iso: string;
  mode: SupportedMode;
  /** Measured value in the internal base unit. */
  baseValue: number;
  /** Reference in the internal base unit, as it stood at capture. */
  baseReference: number;
  /** Band half-width in the internal base unit, as it stood at capture. */
  baseBand: number;
  /** Tolerance exactly as entered, for display ("1%" / "250 Ω"). */
  toleranceMode: ToleranceMode;
  toleranceValue: number;
  verdict: Verdict;
  /** Signed measured − reference, in the internal base unit. */
  deviation: number;
}
