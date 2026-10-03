// SI-prefix magnitude bucketing and resolution-aware formatting, shared by the
// Dashboard, Pass/Fail, and the realtime chart. Pure, no React import (see AGENTS.md).

import { displayUnit, resolutionDecimals } from './parser.ts';

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

/** Pick the SI prefix bucket for `value`'s TRUE magnitude. Never call this on an
 *  already-rounded number — a value must not be promoted to a larger prefix just
 *  because rounding its digits made it read like one. */
export function siPrefixOf(value: number | null): { exp: number; symbol: string } {
  if (value === null || !Number.isFinite(value) || value === 0) {
    return { exp: 0, symbol: '' };
  }
  const abs = Math.abs(value);
  return PREFIXES.find((p) => abs >= Math.pow(10, p.exp)) ?? PREFIXES[PREFIXES.length - 1];
}

// Every SCALE base unit (parser.ts) already IS its physical SI unit (OM=Ω, V=V, A=A)
// except Capacitance, whose base is nF — the one deliberate exception. Keyed on the
// raw SCALE token, never the display string, so this can't silently break if
// DISPLAY_UNITS ever grows an 'nF' entry.
const PHYSICAL_FACTOR: Record<string, number> = { nF: 1e-9 };

/** Raw base-unit value/resolution -> physical SI value (Ω, V, A, F). */
export function toPhysicalUnit(baseUnit: string, value: number): number {
  return value * (PHYSICAL_FACTOR[baseUnit] ?? 1);
}

/** Physical-unit label for a raw base unit token ('OM' -> 'Ω', 'nF' -> 'F', passthrough
 *  otherwise). */
export function physicalUnitLabel(baseUnit: string): string {
  return baseUnit === 'nF' ? 'F' : displayUnit(baseUnit);
}

/**
 * Format a base-unit value with its own SI prefix, at the demonstrated resolution's
 * decimal count (+ `extraDecimals`, for stats — e.g. an average — that resolve finer
 * than one LSD). `resolution` and `value` must be in the same base unit. When
 * `resolution` is unknown, this falls back to a flat 3 decimals and `extraDecimals` is
 * ignored — there is no demonstrated precision to add it on top of.
 *
 * The prefix is chosen from `value`'s TRUE magnitude (`siPrefixOf` runs before any
 * rounding) and is never revisited afterward — `toFixed` only ever grows digits
 * inside that prefix, so a value can never be promoted into the next one by rounding
 * (e.g. 999999.6 Ω at 1 Ω resolution reads "1000.000 k", never "1.00 M").
 */
export function formatSiValue(
  baseUnit: string,
  value: number,
  resolution?: number,
  extraDecimals = 0,
): { text: string; unit: string } {
  // A real zero (e.g. Peak-to-Peak or Std Dev before a second sample exists) has no
  // magnitude bucket to pick a prefix from, but the resolution's OWN decimal count can
  // still be huge once converted to a physical unit far from the base (capacitance's
  // nF->F correction turns a normal ~0.001 nF resolution into 1e-12) — without this,
  // a genuine zero briefly renders as "0.00000000000000F" instead of "0". Mirrors
  // formatEntryValue's own zero case (lib/passfail.ts). The unit still gets a prefix:
  // the meter tops out near 100 mF, so a bare "F" is never a real reading.
  if (value === 0) return { text: '0', unit: siAxisScale(baseUnit, 0, resolution).unit };
  const physicalValue = toPhysicalUnit(baseUnit, value);
  const prefix = siPrefixOf(physicalValue);
  const scale = Math.pow(10, prefix.exp);
  const decimals =
    resolution === undefined
      ? 3
      : resolutionDecimals(toPhysicalUnit(baseUnit, resolution) / scale) + extraDecimals;
  const text = (physicalValue / scale).toFixed(decimals);
  return { text, unit: `${prefix.symbol}${physicalUnitLabel(baseUnit)}` };
}

/**
 * One shared prefix for a whole axis, chosen from `extent` (the largest base-unit magnitude
 * on display), so neighbouring ticks never read `999.9 k` next to `1.000 M`. Decimals come
 * from `resolution` exactly as in `formatSiValue`. Format a tick as
 * `(toPhysicalUnit(baseUnit, v) / scale).toFixed(decimals)`.
 */
export function siAxisScale(
  baseUnit: string,
  extent: number,
  resolution?: number,
): { scale: number; decimals: number; unit: string } {
  // A zero extent has no magnitude; fall back to one base unit, so an all-zero capacitance
  // axis reads nF (never a bare F) and every other unit keeps its unprefixed form.
  const prefix = siPrefixOf(toPhysicalUnit(baseUnit, extent || 1));
  const scale = Math.pow(10, prefix.exp);
  const decimals =
    resolution === undefined ? 3 : resolutionDecimals(toPhysicalUnit(baseUnit, resolution) / scale);
  return { scale, decimals, unit: `${prefix.symbol}${physicalUnitLabel(baseUnit)}` };
}
