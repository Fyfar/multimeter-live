// Self-check for lib/si.ts. Run: `node scripts/check-si.mts`
import assert from 'node:assert/strict';
import { formatSiValue, physicalUnitLabel, siAxisScale, siPrefixOf, toPhysicalUnit } from '../lib/si.ts';

let checks = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.equal(a, b, m); checks++; };
const close = (a: number, b: number, m: string) => {
  assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-15, `${m}: got ${a}, want ${b}`);
  checks++;
};

// --- SI range of a value (moved from check-passfail.mts: siPrefixOf relocated to lib/si.ts) --
eq(siPrefixOf(3e-10).symbol, 'p', '300p sits in the pico range');
eq(siPrefixOf(1e-7).symbol, 'n', '100n sits in the nano range');
eq(siPrefixOf(0.022).symbol, 'm', '22m sits in the milli range');
eq(siPrefixOf(4700).symbol, 'k', '4.7k sits in the kilo range');
eq(siPrefixOf(100).symbol, '', '100 sits in the unprefixed range');
eq(siPrefixOf(null).symbol, '', 'no value -> no prefix');
eq(siPrefixOf(0).symbol, '', 'zero -> no prefix');

// --- capacitance's nF->F correction: the one base unit that isn't its physical SI unit --
close(toPhysicalUnit('nF', 1500), 1.5e-6, '1500 nF -> 1.5e-6 F');
close(toPhysicalUnit('nF', 0.001), 1e-12, '0.001 nF resolution -> 1e-12 F');
eq(toPhysicalUnit('OM', 100), 100, 'every other base unit passes through unchanged');
eq(physicalUnitLabel('nF'), 'F', 'nF\'s physical label is F, not nF-of-nF');
eq(physicalUnitLabel('OM'), 'Ω', 'OM\'s physical label is the display unit');

// --- formatSiValue: decimals come from resolution, not a fixed digit count -------------
eq(
  JSON.stringify(formatSiValue('OM', 11_130_000, 10_000)),
  JSON.stringify({ text: '11.13', unit: 'MΩ' }),
  'the motivating example: 11.13 MOhm at 10k resolution',
);
eq(
  JSON.stringify(formatSiValue('OM', 11_130_000, 10_000, 2)),
  JSON.stringify({ text: '11.1300', unit: 'MΩ' }),
  'Average/Std-Dev get 2 extra decimals over the same resolution',
);
eq(
  JSON.stringify(formatSiValue('OM', 11_130_000, undefined, 2)),
  JSON.stringify({ text: '11.130', unit: 'MΩ' }),
  'unknown resolution always falls back to a flat 3dp; extraDecimals is ignored, not added on top',
);
eq(
  JSON.stringify(formatSiValue('nF', 1500, 1)),
  JSON.stringify({ text: '1.500', unit: 'µF' }),
  'capacitance formats in its physical unit (F-family), not nF-of-nF',
);
eq(
  JSON.stringify(formatSiValue('nF', 0, 0.001)),
  JSON.stringify({ text: '0', unit: 'nF' }),
  'a real zero (e.g. P2P before a 2nd sample): short text, and a prefixed unit, never bare F',
);

// --- no rounding across a prefix boundary: the prefix comes from the TRUE magnitude, ---
// never from the rounded text, so a value can only grow digits inside its own prefix.
eq(
  JSON.stringify(formatSiValue('OM', 999_999.6, 0.1)),
  JSON.stringify({ text: '999.9996', unit: 'kΩ' }),
  'fine resolution: near-boundary value reads out in full at the lower prefix',
);
eq(
  JSON.stringify(formatSiValue('OM', 999_999.6, 1)),
  JSON.stringify({ text: '1000.000', unit: 'kΩ' }),
  'coarse resolution: rounds to look like the next decade but stays at the lower prefix',
);

// --- siAxisScale: ONE prefix per axis, from the extent, so a straddling axis never mixes ---
eq(
  JSON.stringify(siAxisScale('OM', 1_000_100, 100)),
  JSON.stringify({ scale: 1e6, decimals: 4, unit: 'MΩ' }),
  'straddling 999.9k..1.0001M: the extent picks M, and 999_900 then reads 0.9999, not 999.9 k',
);
eq(
  JSON.stringify(siAxisScale('nF', 4700, 1)),
  JSON.stringify({ scale: 1e-6, decimals: 3, unit: 'µF' }),
  'capacitance axis is in farads: 4700 nF extent -> µF at 1 nF = 0.001 µF resolution',
);
eq(siAxisScale('OM', 11_113_000).decimals, 3, 'unknown resolution -> flat 3 decimals');
eq(
  JSON.stringify(siAxisScale('nF', 0, 0.001)),
  JSON.stringify({ scale: 1e-9, decimals: 3, unit: 'nF' }),
  'all-zero capacitance axis: one base unit (nF), not bare F with 12 decimals',
);
eq(siAxisScale('OM', 0, 0.1).unit, 'Ω', 'all-zero ohms keep the plain unit, not the resolution\'s mΩ');
eq(formatSiValue('OM', 0, 0.1).unit, 'Ω', 'a zero P2P on an ohm reading still reads 0 Ω');

console.log(`check-si: ${checks} assertions passed`);
