// Self-check for lib/settings.ts persistence. Run: `node scripts/check-settings.mts`
//
// The interesting path is the schema bump: a stored blob from an older version must be
// discarded wholesale, not half-merged. Also covers the enum-shaped fields (baud,
// timeRange), where an invalid value has no meaningful nearest neighbour to clamp to.
import assert from 'node:assert/strict';

// loadSettings/saveSettings guard on `typeof window`; give them one backed by a Map.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const {
  loadSettings, saveSettings, DEFAULT_SETTINGS,
  loadPortRecord, savePortRecord, clearPortRecord,
} = await import('../lib/settings.ts');
const KEY = 'multimeter-live:settings';
let checks = 0;

function reset() { store.clear(); }
function expectDefaults(why: string) {
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS, why);
  checks++;
}

// --- no stored value ------------------------------------------------------------
reset();
expectDefaults('empty storage falls back to defaults');

// --- an older blob is discarded by the version bump -----------------------------
reset();
store.set(KEY, JSON.stringify({
  version: 1,
  stabilityCount: 7, hysteresisPct: 25, preserveOnModeChange: true,
  noDataWarning: false, noDataAudio: true,
}));
expectDefaults('a v1 blob is discarded wholesale, not partially merged');

// A v2 blob is a complete, valid settings object under the OLD schema — every field it
// carries is still a real field. Only the version marks it stale, so this is the case
// that would silently half-merge if the version gate were dropped.
reset();
store.set(KEY, JSON.stringify({
  version: 2,
  stabilityCount: 7, hysteresisPct: 25, preserveOnModeChange: true,
  noDataWarning: false, noDataAudio: true, capNoPartFloor: 1.5, verdictAudio: true,
}));
expectDefaults('a v2 blob is discarded by the bump to v3');

// --- corrupt JSON ---------------------------------------------------------------
reset();
store.set(KEY, '{not json');
expectDefaults('corrupt JSON falls back to defaults');

// --- round trip -----------------------------------------------------------------
reset();
const custom = {
  ...DEFAULT_SETTINGS,
  stabilityCount: 5, capNoPartFloor: 2.5, verdictAudio: true,
};
saveSettings(custom);
assert.deepEqual(loadSettings(), custom, 'settings round-trip through storage');
checks++;

// --- each new field validates independently -------------------------------------
reset();
store.set(KEY, JSON.stringify({
  version: 3, ...DEFAULT_SETTINGS,
  capNoPartFloor: -5,                 // out of range -> clamped to the minimum
  verdictAudio: 'yes',                // wrong type -> that field's default
}));
const mixed = loadSettings();
assert.equal(mixed.capNoPartFloor, 0, 'negative capNoPartFloor -> clamped to 0');
assert.equal(mixed.verdictAudio, DEFAULT_SETTINGS.verdictAudio, 'bad verdictAudio -> default');
assert.equal(mixed.stabilityCount, DEFAULT_SETTINGS.stabilityCount, 'valid siblings survive');
checks += 3;

// --- clamps ----------------------------------------------------------------------
reset();
store.set(KEY, JSON.stringify({ version: 3, ...DEFAULT_SETTINGS, capNoPartFloor: 99999 }));
assert.equal(loadSettings().capNoPartFloor, 10, 'capNoPartFloor clamps to the max');
store.set(KEY, JSON.stringify({ version: 3, ...DEFAULT_SETTINGS, stabilityCount: 1 }));
assert.equal(loadSettings().stabilityCount, 2, 'stabilityCount clamps up to 2');
// Unbounded above, a run can never complete and capture stops silently.
store.set(KEY, JSON.stringify({ version: 3, ...DEFAULT_SETTINGS, stabilityCount: 1_000_000 }));
assert.equal(loadSettings().stabilityCount, 50, 'stabilityCount clamps down to the max');
// A removed key must be ignored. The stored blob differs from defaults so this cannot
// pass vacuously: a resurrected field would show up as an extra key on the result.
store.set(KEY, JSON.stringify({
  version: 3, ...DEFAULT_SETTINGS, stabilityCount: 5, capStabilityCount: 40,
}));
assert.deepEqual(loadSettings(), { ...DEFAULT_SETTINGS, stabilityCount: 5 },
  'a removed key is dropped, siblings survive');
checks += 4;

// --- the preference defaults reproduce the pre-persistence useState values --------
assert.equal(DEFAULT_SETTINGS.baud, 115200, 'default baud matches the old useState value');
assert.equal(DEFAULT_SETTINGS.timeRange, '10s', 'default timeRange matches');
assert.equal(DEFAULT_SETTINGS.autoScale, true, 'default autoScale matches');
assert.equal(DEFAULT_SETTINGS.rangeMin, '', 'default rangeMin matches');
assert.equal(DEFAULT_SETTINGS.rangeMax, '', 'default rangeMax matches');
assert.equal(DEFAULT_SETTINGS.stableOnly, false, 'default stableOnly matches');
checks += 6;

// --- enum fields fall back rather than clamp -------------------------------------
// A baud of 14400 is a real rate the meter might use but NOT one this app offers; there
// is no sensible nearest neighbour, so it must fall back rather than snap to 9600.
reset();
store.set(KEY, JSON.stringify({
  version: 3, ...DEFAULT_SETTINGS,
  baud: 14400,          // not in BAUD_RATES
  timeRange: '30s',     // not in TIME_RANGES
  rangeMin: 42,         // number, not the string the input holds
  autoScale: 'true',    // string, not boolean
}));
const pref = loadSettings();
assert.equal(pref.baud, DEFAULT_SETTINGS.baud, 'an unlisted baud falls back to the default');
assert.equal(pref.timeRange, DEFAULT_SETTINGS.timeRange, 'an unknown timeRange falls back');
assert.equal(pref.rangeMin, DEFAULT_SETTINGS.rangeMin, 'a non-string rangeMin falls back');
assert.equal(pref.autoScale, DEFAULT_SETTINGS.autoScale, 'a non-boolean autoScale falls back');
assert.equal(pref.stableOnly, DEFAULT_SETTINGS.stableOnly, 'valid siblings survive');
checks += 5;

// A '' rangeMin must round-trip as '' and not be mistaken for "missing".
reset();
saveSettings({ ...DEFAULT_SETTINGS, rangeMin: '1.5', rangeMax: '', timeRange: '1h' });
const rt = loadSettings();
assert.equal(rt.rangeMin, '1.5', 'a typed range bound round-trips as a string');
assert.equal(rt.rangeMax, '', 'an empty range bound stays empty');
assert.equal(rt.timeRange, '1h', 'a valid timeRange round-trips');
checks += 3;

// --- last-used port record -------------------------------------------------------
const PORT_KEY = 'multimeter-live:port';
reset();
assert.equal(loadPortRecord(), null, 'absent port record reads as null');
store.set(PORT_KEY, '{not json');
assert.equal(loadPortRecord(), null, 'corrupt port record reads as null');
// Partial: a record missing baudRate cannot drive a reconnect, so it is not "a record".
store.set(PORT_KEY, JSON.stringify({ usbVendorId: 0x10c4, usbProductId: 0xea60 }));
assert.equal(loadPortRecord(), null, 'a partial port record reads as null');
store.set(PORT_KEY, JSON.stringify({ usbVendorId: 0x10c4, usbProductId: null, baudRate: 115200 }));
assert.equal(loadPortRecord(), null, 'a null field makes the port record invalid');
checks += 4;

reset();
savePortRecord({ usbVendorId: 0x10c4, usbProductId: 0xea60, baudRate: 115200 });
assert.deepEqual(loadPortRecord(), { usbVendorId: 0x10c4, usbProductId: 0xea60, baudRate: 115200 },
  'a port record round-trips');
// The port record must NOT ride along in the settings blob (own key, own lifecycle).
assert.equal('baudRate' in loadSettings(), false, 'the port record stays out of Settings');
checks += 2;

// An explicit Disconnect must forget the device, so the next load does not grab the port
// back. Asserted through loadPortRecord rather than the raw key: the storage layout is an
// implementation detail, "there is no record any more" is the behavior.
reset();
savePortRecord({ usbVendorId: 0x10c4, usbProductId: 0xea60, baudRate: 115200 });
assert.notEqual(loadPortRecord(), null, 'precondition: a record exists to clear');
clearPortRecord();
assert.equal(loadPortRecord(), null, 'clearPortRecord forgets the device');
// Clearing when there is nothing to clear must not throw.
clearPortRecord();
assert.equal(loadPortRecord(), null, 'clearing twice is a no-op');
// Settings must be untouched by it — separate keys, separate lifecycles.
saveSettings({ ...DEFAULT_SETTINGS, stabilityCount: 9 });
clearPortRecord();
assert.equal(loadSettings().stabilityCount, 9, 'clearing the port record leaves settings alone');
checks += 4;

console.log(`check-settings: ${checks} assertions passed`);
