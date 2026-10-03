// Self-check for lib/search.ts. The property that matters is ONE-SIDED: a pre-test may say
// "might match" about a query that cannot, but must NEVER say "cannot match" about one that
// can — that direction hides rows from the operator silently.
//
// An earlier version of this file sampled only years 2019-2033 and an alphabet without `+`,
// which made the expanded-year ISO form (`+010000-…`) invisible to it. The corpora below
// deliberately straddle both forms.
import { couldMatchIso, couldMatchValue, createIsoFormatter, localIso } from '../lib/search.ts';

// UTC bounds of the 4-digit-year form, used as corpus points: in a local zone the switch to the
// expanded form sits an offset away from them, so the points just around them straddle it.
const NORMAL_MAX = 253402300800000;
const NORMAL_MIN = -62167219200000;

// The output depends on the machine's zone, so every timestamp section runs in several:
// UTC (`+00:00`), DST either side of UTC, half-hour (St John's, -03:30) and 45-minute
// (Kathmandu +05:45, Chatham +12:45) offsets. Node re-reads TZ on assignment.
const ZONES = ['UTC', 'Europe/Kyiv', 'America/St_Johns', 'Asia/Kathmandu', 'Pacific/Chatham'];

let pass = 0;
let fail = 0;
const ok = (cond: boolean, what: string) => {
  if (cond) pass++;
  else if (fail++ < 20) console.error(`  FAIL ${what}`);
};

/** Timestamps spanning BOTH ISO forms, including the exact boundaries between them. */
const timestamps: number[] = [
  NORMAL_MIN, NORMAL_MIN + 1, 0, 1, -1, NORMAL_MAX - 1, NORMAL_MAX, NORMAL_MAX + 1,
  253402300799999, 253402300800000, -1742338240813294,
  8640000000000000, -8640000000000000, Date.now(),
];
for (let i = 0; i < 400; i++) {
  timestamps.push(Date.UTC(2020 + (i % 12), i % 12, 1 + (i % 28), i % 24, i % 60, i % 60, (i * 37) % 1000));
}
// Expanded-year form on both sides of zero — the class the old corpus never reached.
for (let i = 0; i < 120; i++) {
  timestamps.push(NORMAL_MAX + i * 31557600000);
  timestamps.push(NORMAL_MIN - i * 31557600000);
}
const isos: string[] = [];
for (const tz of ZONES) {
  process.env.TZ = tz;
  for (const t of timestamps) isos.push(localIso(t).toLowerCase());
}
ok(isos.some((s) => s.length === 29), 'corpus contains the normal 29-char form');
ok(isos.some((s) => s.length === 32), 'corpus contains the EXPANDED 32-char form');
ok(isos.some((s) => s.endsWith('-03:30')) && isos.some((s) => s.endsWith('+05:45')), 'corpus has negative and 45-minute offsets');
ok(isos.some((s) => s.startsWith('+')), 'corpus contains a `+`-signed expanded year');
ok(isos.some((s) => s.startsWith('-')), 'corpus contains a `-`-signed expanded year');

// ---- 1. SOUNDNESS: every substring of a real local-ISO string must be admitted ----------------
// This is the direction that loses data, so it is exhaustive over the substrings of every
// string in the corpus above (the corpus itself is sampled; the substrings are not).
let subs = 0;
for (const iso of isos) {
  for (let a = 0; a < iso.length; a++) {
    for (let b = a + 1; b <= iso.length; b++) {
      subs++;
      const q = iso.slice(a, b);
      ok(couldMatchIso(q), `couldMatchIso(${JSON.stringify(q)}) must be true — occurs in ${iso}`);
    }
  }
}

// ---- 2. COMPLETENESS: exhaustively enumerate short queries; a rejection must be genuine --
// Every string of length <= 3 over the full ISO alphabet INCLUDING `+`. Checked against the
// set of real corpus substrings, so a guard that got too clever fails here.
const ALPHABET = '0123456789-:.tz+';  // `z` kept: it must now be rejected
const corpusSubs = new Set<string>();
for (const iso of isos) {
  for (let a = 0; a < iso.length; a++) for (let b = a + 1; b <= Math.min(iso.length, a + 4); b++) corpusSubs.add(iso.slice(a, b));
}
let enumerated = 0;
const walk = (prefix: string) => {
  if (prefix.length > 0) {
    enumerated++;
    if (!couldMatchIso(prefix)) {
      ok(!corpusSubs.has(prefix), `couldMatchIso(${JSON.stringify(prefix)}) said no, but a real ISO contains it`);
    }
  }
  if (prefix.length === 3) return;
  for (const c of ALPHABET) walk(prefix + c);
};
walk('');

// ---- 3. The cases that motivated the guard ----------------------------------------------
ok(couldMatchIso('z') === false, "'z' rejected (local form has an offset, never Z)");
ok(couldMatchIso('+03:00') === true, "'+03:00' admitted (an offset)");
ok(couldMatchIso('-03:30') === true, "'-03:30' admitted (a negative half-hour offset)");
ok(couldMatchIso('tt') === false, "'tt' rejected (single T)");
ok(couldMatchIso('voltage') === false, "'voltage' rejected");
ok(couldMatchIso('mv') === false, "'mv' rejected");
ok(couldMatchIso('calibration') === false, "'calibration' rejected");
ok(couldMatchIso('t10:') === true, "'t10:' admitted");
ok(couldMatchIso('2026-09-18') === true, 'full date admitted');
ok(couldMatchIso('5.00') === true, "'5.00' admitted");
ok(couldMatchIso('') === true, 'empty admits everything');
// Expanded-year regressions — each of these was WRONGLY rejected before the second template.
ok(couldMatchIso('+') === true, "'+' admitted (expanded-year sign)");
ok(couldMatchIso('-053243') === true, "'-053243' admitted (occurs in an expanded year)");
ok(couldMatchIso('+010000') === true, "'+010000' admitted");
ok(couldMatchIso('271821') === true, 'a 6-digit run admitted (expanded years are 6 digits)');
ok(couldMatchIso('2026-09-24t10:33:01.123+03:00') === true, 'a whole normal timestamp admitted');
ok(couldMatchIso('+010000-01-01t00:00:00.000-03:30') === true, 'a whole EXPANDED timestamp admitted');
ok(couldMatchIso('2026-09-24t10:33:01.123z') === false, 'the old UTC `Z` form is no longer produced, so rejected');
ok(couldMatchIso('x'.repeat(40)) === false, 'longer than both templates rejected');
// Case-insensitivity: the caller lowercases, but nothing enforces it, so it normalizes.
ok(couldMatchIso('T') === true, "uppercase 'T' admitted (input is normalized)");
ok(couldMatchIso('2026-09-24T10') === true, 'mixed-case timestamp admitted');

// ---- 4. couldMatchValue: the SAME one-sided property, which was previously untested ------
// Every substring of real `toFixed` output (finite, |n| < 1e21 — the documented domain) must
// be admitted, or the Data Log silently drops rows matching a value the operator can see.
let valueSubs = 0;
const VALUE_DOMAIN_MAX = 1e21; // where toFixed falls back to exponential; see lib/search.ts
const values: number[] = [0, -0, 1, -1, 0.145, -0.0004, 9.977, 1234.5, 123456789, 1e-7, 1e20, -1e20, 5e-324];
// Exponent capped at 19 so every generated value stays INSIDE the documented domain. A
// generator that drifts past 1e21 produces exponential strings and would "fail" this check
// while the code is correct — the assertion below pins that down rather than leaving it to
// the exponent arithmetic.
for (let i = 0; i < 300; i++) values.push((Math.random() - 0.5) * Math.pow(10, (i % 26) - 6));
for (const v of values) {
  ok(Math.abs(v) < VALUE_DOMAIN_MAX, `test value ${v} is inside couldMatchValue's documented domain`);
  for (const d of [0, 1, 2, 3, 4, 5, 8]) {
    const str = v.toFixed(d);
    for (let a = 0; a < str.length; a++) {
      for (let b = a + 1; b <= str.length; b++) {
        valueSubs++;
        const q = str.slice(a, b);
        ok(couldMatchValue(q), `couldMatchValue(${JSON.stringify(q)}) must be true — occurs in ${str}`);
      }
    }
  }
}
ok(couldMatchValue('mv') === false, "'mv' rejected");
ok(couldMatchValue('voltage') === false, "'voltage' rejected");
ok(couldMatchValue('') === true, 'empty admits everything');
// NOT "toFixed never emits it" — it does, above 1e21. Rejecting it is sound only because the
// capture path stores finite values far below that; see the note in lib/search.ts.
ok((1e21).toFixed(2) === '1e+21', 'toFixed DOES fall back to exponential above 1e21');
ok(couldMatchValue('1e+21') === false, 'exponential form rejected — outside the documented domain');

// ---- 5. localIso is the local wall clock; createIsoFormatter equals it for every timestamp --
// Independent reference for localIso: shift by the zone's offset and read the UTC form. Only
// for modern timestamps — V8 rounds pre-1900 local-mean-time offsets to whole minutes while
// the getters keep the seconds, so there the two legitimately differ.
// The cached formatter is an optimization; a divergence silently mis-renders a row AND
// silently changes which rows a timestamp query matches. Two real bugs lived here: `ts %
// 1000` going negative pre-1970, and `-1` as a sentinel colliding with a real second.
let isoChecks = 0;
const adversarial: number[] = [
  0, 1, -1, -999, -1000, -1001, 999, 1000, 1001,
  NORMAL_MIN, NORMAL_MAX - 1, NORMAL_MAX, NORMAL_MAX + 1,
  253402300799999, -1742338240813294, 8640000000000000, -8640000000000000, Date.now(),
];
// Runs that SHARE a second, in both directions, so the cache is exercised rather than bypassed.
for (const anchorTs of [0, -1, -1000, 1000, Date.now(), NORMAL_MIN]) {
  for (let k = -1200; k <= 1200; k += 137) adversarial.push(anchorTs + k);
}
// Across a DST switch (Kyiv, 2026-03-29 01:00 UTC): the offset changes between cached seconds.
const dst = Date.UTC(2026, 2, 29, 1, 0, 0);
for (let k = -2500; k <= 2500; k += 333) adversarial.push(dst + k);
for (const tz of ZONES) {
  process.env.TZ = tz;
  for (const ts of [dst - 1, dst, Date.UTC(2026, 9, 3, 14, 29, 5, 123), Date.now()]) {
    const off = -new Date(ts).getTimezoneOffset();
    const sign = off < 0 ? '-' : '+';
    const ref = new Date(ts + off * 60000).toISOString().slice(0, -1) + sign +
      `${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
    isoChecks++;
    ok(localIso(ts) === ref, `localIso(${ts}) in ${tz}: ${localIso(ts)} must equal ${ref}`);
  }
  for (const order of ['asc', 'desc'] as const) {
    const list = order === 'asc' ? [...adversarial].sort((a, b) => a - b) : [...adversarial].sort((a, b) => b - a);
    // ONE formatter across the whole sequence — a fresh one per call would hide cache bugs.
    const isoOf = createIsoFormatter();
    for (const ts of list) {
      isoChecks++;
      ok(isoOf(ts) === localIso(ts), `createIsoFormatter()(${ts}) must equal localIso() (${order}, ${tz})`);
    }
  }
  // Interleaving distant timestamps must not let a stale prefix survive.
  const mixed = createIsoFormatter();
  for (let i = 0; i < 400; i++) {
    const ts = i % 2 === 0 ? -1 - (i % 5) : Date.now() + i;
    isoChecks++;
    ok(mixed(ts) === localIso(ts), `interleaved createIsoFormatter()(${ts}) must equal localIso() (${tz})`);
  }
}
process.env.TZ = 'Europe/Kyiv';
ok(localIso(Date.UTC(2026, 9, 3, 14, 29, 5, 123)) === '2026-10-03T17:29:05.123+03:00', 'the motivating case: 14:29 UTC is 17:29 in Kyiv');
process.env.TZ = 'UTC';
ok(localIso(0) === '1970-01-01T00:00:00.000+00:00', 'UTC spells +00:00, never Z');

console.log(
  `check-search: ${pass} assertions passed (${subs} ISO substrings, ${enumerated} enumerated queries, ` +
  `${valueSubs} value substrings, ${isoChecks} ISO reconstructions), ${fail} failed`,
);
if (fail > 0) process.exit(1);
