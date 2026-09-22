// Self-check for lib/passfail.ts. Run: `node scripts/check-passfail.mts`
import assert from 'node:assert/strict';
import {
  parseSiValue, entryToBase, ENTRY_UNITS, formatEntryValue, isPlausibleReference,
  isSupportedMode, resolveBand, isBandTooWide, judge, SUPPORTED_MODES,
  parseSiEntry, siPrefixOf, resolveAbsoluteTolerance,
} from '../lib/passfail.ts';

let checks = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.equal(a, b, m); checks++; };
const close = (a: number | null, b: number, m: string) => {
  assert.ok(a !== null && Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-15, `${m}: got ${a}, want ${b}`);
  checks++;
};

// --- SI parsing: suffix is a plain multiplier ----------------------------------
close(parseSiValue('4.5k'), 4500, '4.5k');
close(parseSiValue('470k'), 470_000, '470k');
close(parseSiValue('4.7M'), 4_700_000, '4.7M');
close(parseSiValue('4k7'), 4700, 'infix 4k7');
close(parseSiValue('1G'), 1e9, '1G');
close(parseSiValue('5p'), 5e-12, '5p');
close(parseSiValue('100n'), 1e-7, '100n');
close(parseSiValue('22m'), 0.022, '22m');
close(parseSiValue('4700'), 4700, 'bare number');
close(parseSiValue('-0.5'), -0.5, 'negative');
close(parseSiValue('  4.5k  '), 4500, 'surrounding whitespace');
close(parseSiValue('.5k'), 500, 'leading-dot mantissa');

// milli vs mega must NOT fold — folding is a 10^9 error that still verdicts confidently
close(parseSiValue('5m'), 0.005, '5m is milli');
close(parseSiValue('5M'), 5e6, '5M is mega');
// kilo and micro variants fold
close(parseSiValue('2K'), 2000, 'K folds to kilo');
close(parseSiValue('10u'), 1e-5, 'u micro');
close(parseSiValue('10µ'), 1e-5, 'U+00B5 micro sign');
close(parseSiValue('10μ'), 1e-5, 'U+03BC greek mu');

// rejections
eq(parseSiValue('4.5x'), null, 'unknown suffix rejected');
eq(parseSiValue(''), null, 'empty rejected');
eq(parseSiValue('   '), null, 'whitespace rejected');
eq(parseSiValue('k'), null, 'bare suffix rejected');
eq(parseSiValue('4..5'), null, 'malformed number rejected');
eq(parseSiValue('4k7k'), null, 'double suffix rejected');
eq(parseSiValue('abc'), null, 'text rejected');

// --- no plausibility check in the parser (task 3.1a) ---------------------------
close(parseSiValue('9.9G'), 9.9e9, 'absurd magnitude still parses');
close(parseSiValue('1p'), 1e-12, 'tiny magnitude still parses');

// --- entry unit conversion ------------------------------------------------------
eq(ENTRY_UNITS.CAPACITANCE.label, 'F', 'capacitance is entered in farads');
eq(ENTRY_UNITS.RESISTANCE.toBase, 1, 'resistance entry == base');
eq(ENTRY_UNITS.DIODE.toBase, 1, 'diode entry == base');
// the whole point: `22m` in capacitance needs no operator arithmetic
close(entryToBase('CAPACITANCE', parseSiValue('22m')!), 22_000_000, '22m -> 22000000 nF');
close(entryToBase('CAPACITANCE', parseSiValue('100n')!), 100, '100n -> 100 nF');
close(entryToBase('RESISTANCE', parseSiValue('4.7k')!), 4700, '4.7k -> 4700 ohms');
close(entryToBase('DIODE', parseSiValue('0.65')!), 0.65, '0.65 -> 0.65 V');

// --- formatting (the echo under the field) --------------------------------------
eq(formatEntryValue(1e-7, 'F'), '100 nF', '100n echoes as 100 nF');
eq(formatEntryValue(0.022, 'F'), '22 mF', '22m echoes as 22 mF');
eq(formatEntryValue(100, 'F'), '100 F', 'unsuffixed 100 echoes at its true magnitude');
eq(formatEntryValue(4700, 'Ω'), '4.7 kΩ', '4700 ohms echoes as 4.7 k\u03A9');
eq(formatEntryValue(0, 'F'), '0 F', 'zero');
eq(formatEntryValue(5e-12, 'F'), '5 pF', 'picofarads');

// --- plausibility (advisory only) ------------------------------------------------
eq(isPlausibleReference('CAPACITANCE', 100), false, '100 F is not a capacitor');
eq(isPlausibleReference('CAPACITANCE', 1e-7), true, '100 nF is plausible');
eq(isPlausibleReference('CAPACITANCE', 0.022), true, '22 mF is plausible');
eq(isPlausibleReference('RESISTANCE', 4700), true, '4.7k ohms is plausible');
eq(isPlausibleReference('RESISTANCE', 1e12), false, '1 T\u03A9 is not');
eq(isPlausibleReference('DIODE', 0.65), true, '0.65 V is a diode drop');
eq(isPlausibleReference('DIODE', 4700), false, '4700 V is not');
// The diode ceiling is the meter's 3.232 V applied voltage, not a round guess: a constant
// -current diode test cannot display a drop above the voltage it supplies. These pin the
// edge — the old 5 V bound passes every assertion above but fails the last two here.
eq(isPlausibleReference('DIODE', 3.2), true, '3.2 V (white LED) is within reach');
eq(isPlausibleReference('DIODE', 3.5), false, '3.5 V exceeds the applied voltage');
eq(isPlausibleReference('DIODE', 5), false, '5 V — the old assumed bound — is not plausible');

// --- supported modes --------------------------------------------------------------
eq(SUPPORTED_MODES.length, 3, 'three supported modes');
eq(isSupportedMode('RESISTANCE'), true, 'resistance supported');
eq(isSupportedMode('CAPACITANCE'), true, 'capacitance supported');
eq(isSupportedMode('DIODE'), true, 'diode supported');
eq(isSupportedMode('VOLTAGE'), false, 'voltage excluded');
eq(isSupportedMode('CURRENT'), false, 'current excluded');
eq(isSupportedMode('CONTINUITY'), false, 'continuity excluded');
eq(isSupportedMode(null), false, 'null mode unsupported');

// --- tolerance bands ---------------------------------------------------------------
close(resolveBand(10_000, 1, 'percent'), 100, '1% of 10k');
close(resolveBand(10_000, 250, 'absolute'), 250, 'absolute 250');
close(resolveBand(-10_000, 1, 'percent'), 100, 'percent uses |reference|');
eq(resolveBand(10_000, 0, 'percent'), null, 'zero-width percent -> no verdict');
eq(resolveBand(10_000, 0, 'absolute'), null, 'zero-width absolute -> no verdict');
eq(resolveBand(0, 5, 'percent'), null, 'percent of a zero reference -> no verdict');
close(resolveBand(0, 5, 'absolute'), 5, 'absolute works at a zero reference');

// --- verdicts (band edge is inclusive) ----------------------------------------------
eq(judge(9980, 10_000, 100), 'PASS', 'inside the band');
eq(judge(10_450, 10_000, 100), 'FAIL', 'outside the band');
eq(judge(10_100, 10_000, resolveBand(10_000, 1, 'percent')!), 'PASS', 'exactly on the upper edge');
eq(judge(9900, 10_000, resolveBand(10_000, 1, 'percent')!), 'PASS', 'exactly on the lower edge');
eq(judge(10_101, 10_000, 100), 'FAIL', 'one unit past the edge');
eq(judge(10_000, 10_000, 100), 'PASS', 'dead on');
// a float-arithmetic band must not fail a part sitting on its limit
eq(judge(0.33, 0.3, resolveBand(0.3, 10, 'percent')!), 'PASS', 'float band edge stays inclusive');

// --- explicit-vs-bare suffix detection ---------------------------------------------
eq(parseSiEntry('30')?.explicit, false, 'a bare number has no explicit suffix');
eq(parseSiEntry('30p')?.explicit, true, 'a suffixed number is explicit');
eq(parseSiEntry('4k7')?.explicit, true, 'infix counts as explicit');
eq(parseSiEntry('bad'), null, 'unparseable returns null');

// --- SI range of a value ------------------------------------------------------------
eq(siPrefixOf(3e-10).symbol, 'p', '300p sits in the pico range');
eq(siPrefixOf(1e-7).symbol, 'n', '100n sits in the nano range');
eq(siPrefixOf(0.022).symbol, 'm', '22m sits in the milli range');
eq(siPrefixOf(4700).symbol, 'k', '4.7k sits in the kilo range');
eq(siPrefixOf(100).symbol, '', '100 sits in the unprefixed range');
eq(siPrefixOf(null).symbol, '', 'no value -> no prefix');
eq(siPrefixOf(0).symbol, '', 'zero -> no prefix');

// --- absolute tolerance inherits the reference's range --------------------------------
// The headline case: reference 300p, tolerance "30" means 30 pF, not 30 F.
close(resolveAbsoluteTolerance('30', parseSiValue('300p')), 3e-11, '30 against 300p = 30 pF');
close(resolveAbsoluteTolerance('30', parseSiValue('100n')), 3e-8, '30 against 100n = 30 nF');
close(resolveAbsoluteTolerance('5', parseSiValue('22m')), 5e-3, '5 against 22m = 5 mF');
// The range follows what the ECHO and the field label show: 4k7 echoes "4.7 kΩ", so a
// bare tolerance there is in kilohms — ±250 Ω is typed as 0.25, not 250.
close(resolveAbsoluteTolerance('250', parseSiValue('4k7')), 250e3, '250 against 4k7 = 250 k\u03A9');
close(resolveAbsoluteTolerance('0.25', parseSiValue('4k7')), 250, '0.25 against 4k7 = 250 \u03A9');
// 0.65 V echoes as "650 mV", so its range is milli: a diode tolerance of 50 = 50 mV.
close(resolveAbsoluteTolerance('50', parseSiValue('0.65')), 0.05, '50 against 0.65 V = 50 mV');
close(resolveAbsoluteTolerance('0.05', parseSiValue('0.65')), 5e-5, 'a bare 0.05 there is 0.05 mV');
// An explicit suffix always wins over the inherited range.
close(resolveAbsoluteTolerance('1n', parseSiValue('300p')), 1e-9, 'explicit 1n beats the pico range');
close(resolveAbsoluteTolerance('300p', parseSiValue('300p')), 3e-10, 'explicit suffix is not double-scaled');
// No usable reference -> no range to inherit, take the entry at face value.
close(resolveAbsoluteTolerance('30', null), 30, 'no reference -> face value');
close(resolveAbsoluteTolerance('30', parseSiValue('300x')), 30, 'invalid reference -> face value');
close(resolveAbsoluteTolerance('30p', null), 3e-11, 'explicit suffix still works with no reference');
eq(resolveAbsoluteTolerance('bad', parseSiValue('300p')), null, 'unparseable tolerance -> null');

// --- end-to-end: the band a 300p +-30 entry produces -----------------------------------
{
  const ref = parseSiValue('300p')!;
  const tol = resolveAbsoluteTolerance('30', ref)!;
  const band = resolveBand(ref, tol, 'absolute')!;
  close(band * ENTRY_UNITS.CAPACITANCE.toBase, 0.03, 'band is 30 pF = 0.03 nF');
  close(entryToBase('CAPACITANCE', ref), 0.3, 'reference is 300 pF = 0.3 nF');
  // 320 pF is inside 300 +- 30; 340 pF is not.
  eq(judge(0.32, 0.3, band * ENTRY_UNITS.CAPACITANCE.toBase), 'PASS', '320 pF passes');
  eq(judge(0.34, 0.3, band * ENTRY_UNITS.CAPACITANCE.toBase), 'FAIL', '340 pF fails');
}

// --- the band may not reach zero -------------------------------------------------
// Past band >= |reference| the accept interval straddles zero, so a dead short and a
// negative value both PASS and the verdict means nothing.
eq(resolveBand(4700, 400, 'percent'), null, '400% is refused');
eq(resolveBand(4700, 100, 'percent'), null, '100% is refused (band reaches exactly 0)');
close(resolveBand(4700, 99, 'percent'), 4653, '99% is allowed');
eq(isBandTooWide(4700, 400, 'percent'), true, '400% is flagged too wide');
eq(isBandTooWide(4700, 15, 'percent'), false, '15% is not');
eq(resolveBand(4700, 5000, 'absolute'), null, 'an absolute band above the reference is refused');
close(resolveBand(4700, 250, 'absolute'), 250, 'an absolute band below it is fine');
// A zero reference has no scale to be wide relative to, so the bound is exempted.
close(resolveBand(0, 5, 'absolute'), 5, 'absolute still works at a zero reference');
eq(isBandTooWide(0, 5, 'absolute'), false, 'a zero reference is never "too wide"');
// Negative tolerance: both modes now agree on null instead of one silently abs()-ing.
eq(resolveBand(10_000, -5, 'absolute'), null, 'negative absolute tolerance is refused');
eq(resolveBand(10_000, -5, 'percent'), null, 'negative percent tolerance is refused');

// --- overflow after the multiplier -------------------------------------------------
// The mantissa is finite but the scaled value is not; an infinite reference would
// capture FAIL forever and write "Infinity" into the CSV.
eq(parseSiValue('1' + '0'.repeat(300) + 'G'), null, 'overflow after the suffix is rejected');
eq(parseSiValue('1' + '0'.repeat(400)), null, 'an overflowing mantissa is rejected');
close(parseSiValue('9' + '0'.repeat(20) + 'G'), 9e29, 'a large but finite value still parses');

// --- signed infix (previously uncovered) -------------------------------------------
close(parseSiValue('-4k7'), -4700, 'negative infix');
close(parseSiValue('+4k7'), 4700, 'explicitly positive infix');

console.log(`check-passfail: ${checks} assertions passed`);
