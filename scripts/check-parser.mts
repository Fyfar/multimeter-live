// Self-check for lib/parser.ts. Run: `node scripts/check-parser.mts` (Node strips types).
// No test runner in this repo by design — this is the smallest thing that fails if the
// unit table, the measuring/overload split, or the stable band break. Alternation order
// in UNIT_RE is load-bearing: `mF` must not steal `mV`/`mA`, nor preempt `MOM`/`KOM`.
import assert from 'node:assert/strict';
import {
  parseMeasurement, normalizeReading, readingResolution, withinStableBand,
  displayUnit, STABLE_LSD_TOLERANCE, type Mode,
} from '../lib/parser.ts';

let checks = 0;
function check(
  mode: Mode,
  token: string,
  body: string,
  expected: { unit: string; value: number | null; baseValue: number | null; baseUnit: string },
) {
  const r = parseMeasurement(mode, token, body);
  const n = normalizeReading(r);
  assert.equal(r.unit, expected.unit, `unit for "${body}"`);
  assert.equal(r.value, expected.value, `value for "${body}"`);
  assert.equal(n.baseUnit, expected.baseUnit, `baseUnit for "${body}"`);
  if (expected.baseValue === null) assert.equal(n.baseValue, null, `baseValue for "${body}"`);
  // Scaling is a float multiply; compare with a tolerance rather than exactly.
  else assert.ok(
    Math.abs((n.baseValue as number) - expected.baseValue) < Math.abs(expected.baseValue) * 1e-9 + 1e-12,
    `baseValue for "${body}": got ${n.baseValue}, want ${expected.baseValue}`,
  );
  checks++;
}

// --- capacitance decades all land on the nF base -------------------------------
check('CAPACITANCE', 'Cap:', '00.100 pF', { unit: 'pF', value: 0.1, baseValue: 0.0001, baseUnit: 'nF' });
check('CAPACITANCE', 'Cap:', '00.100 nF', { unit: 'nF', value: 0.1, baseValue: 0.1, baseUnit: 'nF' });
check('CAPACITANCE', 'Cap:', '00.100 uF', { unit: 'uF', value: 0.1, baseValue: 100, baseUnit: 'nF' });
check('CAPACITANCE', 'Cap:', '00.100 µF', { unit: 'µF', value: 0.1, baseValue: 100, baseUnit: 'nF' });
check('CAPACITANCE', 'Cap:', '00.100 μF', { unit: 'μF', value: 0.1, baseValue: 100, baseUnit: 'nF' });
check('CAPACITANCE', 'Cap:', '22.000 mF', { unit: 'mF', value: 22, baseValue: 22_000_000, baseUnit: 'nF' });

// --- the new two-character entries must not shadow the pre-existing units ------
check('VOLTAGE', 'Voltage:', '00.145 mV', { unit: 'mV', value: 0.145, baseValue: 0.000145, baseUnit: 'V' });
check('CURRENT', 'Electricity:', '00.000 mA', { unit: 'mA', value: 0, baseValue: 0, baseUnit: 'A' });
check('RESISTANCE', 'Resistance:', '09.977 KOM', { unit: 'KOM', value: 9.977, baseValue: 9977, baseUnit: 'OM' });
check('RESISTANCE', 'Resistance:', '01.200 MOM', { unit: 'MOM', value: 1.2, baseValue: 1_200_000, baseUnit: 'OM' });
check('RESISTANCE', 'Resistance:', '000.2 OM', { unit: 'OM', value: 0.2, baseValue: 0.2, baseUnit: 'OM' });
check('VOLTAGE', 'Voltage:', '-0.0004 V', { unit: 'V', value: -0.0004, baseValue: -0.0004, baseUnit: 'V' });
check('CURRENT', 'Electricity:', '01.500 A', { unit: 'A', value: 1.5, baseValue: 1.5, baseUnit: 'A' });

// --- overload still parses as OL in every mode ---------------------------------
check('RESISTANCE', 'Resistance:', '0L. OM', { unit: 'OM', value: null, baseValue: null, baseUnit: 'OM' });
check('CAPACITANCE', 'Cap:', '0L. uF', { unit: 'uF', value: null, baseValue: null, baseUnit: 'nF' });

// --- the regression this guards: "uF" once fell through to unit='' and normalized at
// the PREVIOUS unit's scale. Only a genuinely unknown unit may yield ''.
{
  const r = parseMeasurement('CAPACITANCE', 'Cap:', '00.100 QQ');
  assert.equal(r.unit, '', 'a genuinely unknown unit yields empty unit');
  checks++;
}

// --- "measuring" dashes are distinct from a real overload -----------------------
// The meter sends "-.--" while measuring (notably a charging capacitor): digit-free like
// OL but with no 'L'. Both give value === null; isMeasuring is what separates them.
for (const body of ['-.-- nF', '- . - - uF', '.-- OM']) {
  const r = parseMeasurement('CAPACITANCE', 'Cap:', body);
  assert.equal(r.value, null, `"${body}" has no value`);
  assert.equal(r.isMeasuring, true, `"${body}" is measuring`);
  assert.equal(r.isOverload, false, `"${body}" is NOT an overload`);
  assert.equal(r.display, '---', `"${body}" displays as dashes, not OL`);
  checks += 4;
}
for (const body of ['0L. OM', '.0L MOM', '0.L V']) {
  const r = parseMeasurement('RESISTANCE', 'Resistance:', body);
  assert.equal(r.value, null, `"${body}" has no value`);
  assert.equal(r.isOverload, true, `"${body}" IS an overload`);
  assert.equal(r.isMeasuring, false, `"${body}" is not measuring`);
  assert.equal(r.display, 'OL', `"${body}" displays as OL`);
  checks += 4;
}
// A real numeric reading is neither.
{
  const r = parseMeasurement('CAPACITANCE', 'Cap:', '00.100 uF');
  assert.equal(r.isMeasuring, false, 'a numeric reading is not measuring');
  assert.equal(r.isOverload, false, 'a numeric reading is not overload');
  checks += 2;
}
// A genuine zero IS numeric — the parser keeps it; treating it as "no part" is a
// Pass/Fail capture decision, not a parsing one.
{
  const r = parseMeasurement('CAPACITANCE', 'Cap:', '0.000 nF');
  assert.equal(r.value, 0, 'zero parses as a real 0');
  assert.equal(r.isMeasuring, false, 'zero is not the measuring state');
  checks += 2;
}

// --- resolution projects onto the base unit ------------------------------------
assert.equal(
  readingResolution(parseMeasurement('CAPACITANCE', 'Cap:', '00.100 uF')),
  1, // 1e-3 uF x 1e3 = 1 nF
);
assert.equal(
  readingResolution(parseMeasurement('RESISTANCE', 'Resistance:', '09.977 KOM')),
  1, // 1e-3 kOhm x 1e3 = 1 Ohm
);
checks += 2;

// --- stable-run band ------------------------------------------------------------
// A 10 Ω resistor displayed as "10.000" (LSD 0.001) whose last digit dithers: exact
// equality leaves it permanently unsettled, the band does not. A probe lift still breaks it.
{
  const lsd = 0.001; // a 10 ohm part displayed as "10.000"
  assert.ok(withinStableBand(10.0, 10.0, lsd), 'identical values are in band');
  assert.ok(withinStableBand(10.001, 10.0, lsd), '+1 LSD dither stays in the run');
  assert.ok(withinStableBand(9.999, 10.0, lsd), '-1 LSD dither stays in the run');
  // The reported case: a 0.01 ohm excursion on a 0.001 ohm LSD is 10 counts, which a
  // 2 LSD band rejected -- that was the residual flicker.
  assert.ok(withinStableBand(10.01, 10.0, lsd), 'a 10-count excursion stays in the run');
  assert.ok(withinStableBand(10.02, 10.0, lsd), '+20 LSD is the band edge, inclusive');
  assert.ok(!withinStableBand(10.03, 10.0, lsd), '+30 LSD leaves the run');
  assert.ok(!withinStableBand(14, 10.0, lsd), 'a lifted probe breaks the run');
  assert.ok(!withinStableBand(900_000, 10.0, lsd), 'a sweep toward OL breaks the run');
  // Separation is what makes a wide band safe: the transient is orders of magnitude out.
  assert.ok((14 - 10) / lsd > 100 * STABLE_LSD_TOLERANCE, 'a transient clears the band by >100x');
  checks += 9;
}
// Unknown resolution falls back to exact equality rather than guessing a band.
assert.ok(withinStableBand(10, 10, null), 'no LSD -> equality holds');
assert.ok(!withinStableBand(10.01, 10, null), 'no LSD -> anything else does not');
assert.equal(STABLE_LSD_TOLERANCE, 20, 'band is 20 LSD');
checks += 3;
// The band must scale with the reading's own resolution, not a fixed absolute.
{
  const r = parseMeasurement('RESISTANCE', 'Resistance:', '09.977 KOM');
  const lsd = readingResolution(r); // 1 ohm
  assert.equal(lsd, 1, 'kOhm range resolves to 1 ohm');
  assert.ok(withinStableBand(9997, 9977, lsd), '+20 ohm dither is in band on the k range');
  assert.ok(!withinStableBand(10_100, 9977, lsd), '+123 ohm is not');
  checks += 3;
}

// --- display spelling of units --------------------------------------------------
// The meter sends ohms as ASCII OM/KOM/MOM; the UI must show the symbol. Display-only:
// Reading.unit and the CSV keep the wire spelling, which SCALE and every capture rule
// key off, so these assert the MAPPING without touching the parse path.
assert.equal(displayUnit('OM'), '\u03A9', 'OM renders as the ohm symbol');
assert.equal(displayUnit('KOM'), 'k\u03A9', 'KOM renders as kilo-ohm');
assert.equal(displayUnit('MOM'), 'M\u03A9', 'MOM renders as mega-ohm');
// Everything else passes through untouched — a unit with no prettier spelling must not
// be silently dropped or blanked.
assert.equal(displayUnit('V'), 'V', 'volts pass through');
assert.equal(displayUnit('nF'), 'nF', 'nanofarads pass through');
assert.equal(displayUnit('mV'), 'mV', 'millivolts pass through');
assert.equal(displayUnit(''), '', 'the empty unit stays empty');
// The parse path must NOT change: the raw token is what SCALE and normalizeReading use.
assert.equal(parseMeasurement('RESISTANCE', 'Resistance:', '009.79 OM').unit, 'OM',
  'Reading.unit keeps the wire spelling');
assert.equal(normalizeReading(parseMeasurement('RESISTANCE', 'Resistance:', '009.79 KOM')).baseUnit,
  'OM', 'normalizeReading still keys off the wire spelling');
checks += 9;

console.log(`check-parser: ${checks} assertions passed`);
