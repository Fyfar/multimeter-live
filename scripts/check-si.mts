// Self-check for lib/si.ts. Run: `node scripts/check-si.mts`
import assert from 'node:assert/strict';
import { formatSiValue, physicalUnitLabel, siPrefixOf, toPhysicalUnit } from '../lib/si.ts';

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
  JSON.stringify({ text: '0', unit: 'F' }),
  'a real zero (e.g. P2P before a 2nd sample) never inflates into a long decimal string',
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

console.log(`check-si: ${checks} assertions passed`);
