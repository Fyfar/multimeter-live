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
  TIME_RANGES, TIME_RANGE_MS, TIME_RANGE_STEP_MS, resolveTimeWindow,
  firstIndexInWindow, timeAxisTicks, BUFFER_RETENTION_MS,
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

// --- resolveTimeWindow: the chart's x-axis range --------------------------------
// The two failure modes worth guarding: a window that does not span its range (the
// scale stops being constant) and a discontinuity where the anchored phase hands over
// to the rolling one (a visible jump in the trace).
const NOW = 1_700_000_000_000;

// Anchored: a session younger than the window starts at its own start, and the span is
// still a full window — that empty remainder on the right is the point.
{
  const w = resolveTimeWindow('1m', NOW - 10_000, NOW);
  assert.equal(w.min, NOW - 10_000, 'a young session anchors at its start');
  assert.equal((w.max as number) - (w.min as number), 60_000, 'the span is a full window');
  assert.ok((w.max as number) > NOW, 'the window extends past the present while filling');
  checks += 3;
}

// Rolling: once the session outlives the window, the present is the right edge.
{
  const w = resolveTimeWindow('1m', NOW - 300_000, NOW);
  assert.equal(w.max, NOW, 'an old session ends at the present');
  assert.equal(w.min, NOW - 60_000, 'and begins one window earlier');
  checks += 2;
}

// The handover. Both arms of the max() must agree AT the boundary, or the trace jumps
// at exactly the moment the window fills.
for (const range of TIME_RANGES.filter((r) => r !== 'all')) {
  const span = TIME_RANGE_MS[range];
  const at = resolveTimeWindow(range, NOW - span, NOW);
  assert.equal(at.min, NOW - span, `${range}: both arms agree at the boundary`);
  assert.equal(at.max, NOW, `${range}: the boundary window ends at the present`);
  // One millisecond either side moves the edges by one millisecond, not by a window.
  const before = resolveTimeWindow(range, NOW - span + 1, NOW);
  const after = resolveTimeWindow(range, NOW - span - 1, NOW);
  assert.equal((at.min as number) - (before.min as number), -1, `${range}: continuous below`);
  assert.equal((at.min as number) - (after.min as number), 0, `${range}: continuous above`);
  checks += 4;
}

// Degenerate anchors. No session yet => anchor at the present; a start in the future
// (a clock step) is clamped to it rather than pushing the whole window out of view.
{
  const none = resolveTimeWindow('10s', null, NOW);
  assert.equal(none.min, NOW, 'no session anchors at the present');
  const future = resolveTimeWindow('10s', NOW + 5_000, NOW);
  assert.equal(future.min, NOW, 'a future start is clamped to the present');
  checks += 2;
}

// 'all' has no fixed duration, so nothing is pinned and the axis fits the data.
{
  const w = resolveTimeWindow('all', NOW - 10_000, NOW);
  assert.deepEqual(w, {}, "'all' pins nothing");
  checks++;
}

// Every bounded range spans exactly its window and carries a tick step that divides it
// into at most the chart's maxTicksLimit (9) intervals — otherwise Chart.js autoSkips
// labels and the round-offset guarantee is lost.
for (const range of TIME_RANGES.filter((r) => r !== 'all')) {
  const span = TIME_RANGE_MS[range];
  const w = resolveTimeWindow(range, NOW - span * 2, NOW);
  assert.equal((w.max as number) - (w.min as number), span, `${range}: spans its window`);
  const step = TIME_RANGE_STEP_MS[range] as number;
  assert.ok(step > 0, `${range}: has a tick step`);
  assert.equal(span % step, 0, `${range}: the step divides the window, so a tick lands on the present`);
  assert.ok(span / step <= 9, `${range}: at most 9 intervals`);
  assert.equal(w.stepSize, step, `${range}: the step is returned`);
  checks += 5;
}

// --- firstIndexInWindow: where the visible slice starts -------------------------
// Off-by-one here silently drops or keeps one sample at the window edge, which is
// invisible on screen and wrong in the y-axis floor.
{
  const pts = [10, 20, 30, 40, 50].map((x) => ({ x }));
  assert.equal(firstIndexInWindow([], 30), 0, 'empty buffer -> 0');
  assert.equal(firstIndexInWindow(pts, 5), 0, 'everything in window -> 0');
  assert.equal(firstIndexInWindow(pts, 99), 5, 'nothing in window -> length');
  assert.equal(firstIndexInWindow(pts, 30), 2, 'a boundary hit is INSIDE the window');
  assert.equal(firstIndexInWindow(pts, 31), 3, 'just past a point excludes it');
  assert.equal(firstIndexInWindow([{ x: 10 }], 10), 0, 'single point, at the boundary');
  assert.equal(firstIndexInWindow([{ x: 10 }], 11), 1, 'single point, out of window');
  // Duplicate timestamps are the normal case, not an exotic one: the parser stamps
  // Date.now() per reading, so a batch parsed inside one millisecond stamps several
  // identically. The FIRST of the run is the correct edge — returning the last would
  // silently drop the points whose ts equals the cutoff exactly.
  assert.equal(firstIndexInWindow([10, 10, 10, 20].map((x) => ({ x })), 10), 0,
    'a run of equal timestamps returns the first of the run');
  assert.equal(firstIndexInWindow([10, 10, 10, 20].map((x) => ({ x })), 20), 3,
    'and the first index past the run when the cutoff moves on');
  checks += 9;
}

// --- timeAxisTicks: 'Now' must be a tick in BOTH phases -------------------------
// The bug this replaced: ticks generated from the axis minimum are aligned with the
// present only once the window has filled, so a young session's '1h' view had no 'Now'
// label at all. Asserting the divisibility of the window was not enough — assert the
// outcome.
for (const range of TIME_RANGES.filter((r) => r !== 'all')) {
  const span = TIME_RANGE_MS[range];
  const step = TIME_RANGE_STEP_MS[range] as number;
  for (const [phase, sessionStart] of [
    ['anchored', NOW - Math.round(span / 3) - 12_345], // an arbitrary instant, deliberately
    ['rolling', NOW - span * 2],
  ] as const) {
    const w = resolveTimeWindow(range, sessionStart, NOW);
    const ticks = timeAxisTicks(w.min as number, w.max as number, step, NOW);
    assert.ok(ticks.includes(NOW), `${range}/${phase}: the present is a tick`);
    assert.ok(ticks.length <= 9, `${range}/${phase}: within maxTicksLimit`);
    assert.ok(
      ticks.every((v) => v >= (w.min as number) && v <= (w.max as number)),
      `${range}/${phase}: every tick is inside the axis`,
    );
    assert.ok(
      ticks.every((v, i) => i === 0 || v - ticks[i - 1] === step),
      `${range}/${phase}: evenly spaced by the step`,
    );
    checks += 4;
  }
}

// Every input the guard rejects, asserted separately. A zero step is the harmless one; a
// NEGATIVE step is what actually runs away (measured: 5,000,000 ticks pushed in 121 ms,
// which inside afterBuildTicks is a hung tab), and a non-finite bound does the same. With
// only the zero case asserted, narrowing the guard to `step === 0` would still pass.
assert.deepEqual(timeAxisTicks(NOW - 1000, NOW, 0, NOW), [], 'a zero step yields no ticks');
assert.deepEqual(timeAxisTicks(NOW - 1000, NOW, -1000, NOW), [], 'a negative step yields no ticks');
assert.deepEqual(timeAxisTicks(NOW - 1000, Infinity, 1000, NOW), [], 'a non-finite max yields no ticks');
assert.deepEqual(timeAxisTicks(-Infinity, NOW, 1000, NOW), [], 'a non-finite min yields no ticks');
checks += 4;

// --- BUFFER_RETENTION_MS: the chart keeps the longest bounded window ------------
// Derived, not written down, so a new range cannot leave the buffer short of what that
// range needs — the failure the 3600-sample cap produced.
{
  const bounded = TIME_RANGES.filter((r) => r !== 'all').map((r) => TIME_RANGE_MS[r]);
  // This one assertion is load-bearing and sufficient. It fails if 'all' Infinity leaks in,
  // if the value regresses to a literal, and if a new range outgrows retention. Asserting
  // `isFinite`, or that every bounded window fits, adds nothing: both are consequences of
  // this equality and cannot fail once it holds (docs/quality.md — a check that cannot fail
  // is worse than none).
  assert.equal(BUFFER_RETENTION_MS, Math.max(...bounded), 'retention is the longest window');
  checks++;
}

console.log(`check-settings: ${checks} assertions passed`);
