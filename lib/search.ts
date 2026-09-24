// Query pre-tests for the Data Log filter. No React, no DOM: `scripts/check-search.mts` loads
// this directly under Node's type stripping, because these decide whether a predicate runs at
// all — and a pre-test that wrongly says "cannot match" hides real rows from the operator with
// nothing on screen looking wrong.
//
// The filtered scan is O(session) and deliberately uncapped, so a filter reaches the whole
// retained week. These are what make that affordable: each is decided ONCE per query, and a
// negative skips millions of `toFixed` or `Date` formattings.
//
// THE CONTRACT IS ONE-SIDED. Returning `true` about a query that cannot match costs one wasted
// scan. Returning `false` about a query that CAN match silently loses rows. Every judgement
// call below therefore errs toward `true`.

/**
 * `toISOString()` output as a fixed-width template. `0` stands for any digit, `±` for a sign.
 *
 * TWO templates, because `toISOString()` is NOT always 24 characters. Years outside 0000-9999
 * use the expanded form, with a sign and SIX year digits:
 *
 * ```
 * new Date(253402300799999).toISOString()  === '9999-12-31T23:59:59.999Z'     // 24
 * new Date(253402300800000).toISOString()  === '+010000-01-01T00:00:00.000Z'  // 27
 * new Date(-1742338240813294).toISOString() === '-053243-07-02T03:19:46.706Z' // 27
 * ```
 *
 * Modelling only the normal form made `couldMatchIso('-053243')` and `couldMatchIso('+')`
 * return false about strings that really do occur — a one-sided violation. Unreachable while
 * every `ts` is `Date.now()`, but `SampleStore.snapshot`/`from` exist so a future session
 * restore can read timestamps back from storage, and this failure is silent.
 */
const ISO_TEMPLATE = '0000-00-00T00:00:00.000Z';
const ISO_EXPANDED = '±000000-00-00T00:00:00.000Z';

/** First timestamp that needs the expanded form; `new Date(this).getUTCFullYear()` is 10000. */
export const ISO_NORMAL_MAX = 253402300800000;
/** `0000-01-01T00:00:00.000Z` — the earliest timestamp still in the 24-character form. */
export const ISO_NORMAL_MIN = -62167219200000;

/**
 * Whether `ts` formats as the fixed-width 24-character ISO string.
 *
 * Callers that hand-assemble an ISO string from parts (the Data Log's per-second prefix cache)
 * must check this first: outside the range, `toISOString().slice(0, 19)` slices the wrong
 * fields and `ts % 1000` goes negative.
 */
export const isNormalIsoTime = (ts: number): boolean =>
  Number.isFinite(ts) && ts >= ISO_NORMAL_MIN && ts < ISO_NORMAL_MAX;

/** Does `q` fit under `tpl` starting at `p`? `0` = any digit, `±` = `+` or `-`. */
const fitsAt = (q: string, tpl: string, p: number): boolean => {
  for (let k = 0; k < q.length; k++) {
    const t = tpl[p + k];
    const c = q[k];
    if (t === '0') {
      if (c < '0' || c > '9') return false;
    } else if (t === '±') {
      if (c !== '+' && c !== '-') return false;
    } else if (c !== t.toLowerCase()) {
      return false;
    }
  }
  return true;
};

const fitsTemplate = (q: string, tpl: string): boolean => {
  if (q.length > tpl.length) return false;
  for (let p = 0; p + q.length <= tpl.length; p++) if (fitsAt(q, tpl, p)) return true;
  return false;
};

/**
 * Whether `q` could occur inside SOME ISO timestamp — true if it can be laid over either
 * template at any offset with every character compatible.
 *
 * Deliberately CONSERVATIVE: it tests digit-ness, not ranges, so `'9-99'` is admitted even
 * though no month is 99. See the contract note at the top of this file.
 *
 * This is why a charset test is not enough: `'zzz'` is made entirely of ISO characters, but
 * neither template holds more than one `Z` and it is last, so no offset fits.
 *
 * Case-insensitive. The one caller already lowercases, but this is a pre-test whose ONLY
 * failure mode is silent data loss, so it normalizes rather than trusting a precondition that
 * nothing enforces.
 */
export const couldMatchIso = (query: string): boolean => {
  const q = query.toLowerCase();
  if (q.length === 0) return true;
  return fitsTemplate(q, ISO_TEMPLATE) || fitsTemplate(q, ISO_EXPANDED);
};

/**
 * Every character `Number.prototype.toFixed` emits **for a finite argument below 1e21**.
 *
 * Above that, and for a non-finite argument, `toFixed` falls back to `ToString` and can emit
 * letters and `+` (`(1e21).toFixed(3) === '1e+21'`, `NaN`, `Infinity`) — which this charset
 * would reject. That is out of the documented domain, not a hole: `lib/parser.ts` stores only
 * `Number.isFinite` values, and `rowValue` divides by a `SCALE` factor no smaller than 1e-3,
 * so reaching 1e21 needs a base value of 1e18 from a five-digit meter.
 *
 * Stated explicitly because widening the input domain is exactly what would make it a hole.
 */
const VALUE_CHARS = /^[0-9.\-]+$/;

/** Whether `q` could occur inside a formatted reading. Empty matches everything. */
export const couldMatchValue = (q: string): boolean => q.length === 0 || VALUE_CHARS.test(q);

/**
 * An ISO formatter that caches the per-second prefix.
 *
 * The Data Log's filter formats a timestamp for every scanned row when the query could be a
 * timestamp. At the meter's ~3 samples/s roughly three consecutive rows share a wall-clock
 * second, so caching `YYYY-MM-DDTHH:MM:SS` cuts the `Date` work to a third.
 *
 * Lives here, not inline in the component, because the inline version shipped two silent
 * bugs that no check could reach from a `.tsx`:
 *
 *  - `ts % 1000` keeps the SIGN OF THE DIVIDEND, so a pre-1970 timestamp produced
 *    `1969-12-31T23:59:59.00-1Z` instead of `…59.999Z`. `ts - sec * 1000` is always in
 *    [0, 1000) because `sec` is a floor.
 *  - `-1` as the "nothing cached" sentinel COLLIDES with a real second (the last one before
 *    the epoch), so the staleness check missed and a stale prefix was reused. `NaN` cannot
 *    collide, since `NaN !== NaN`.
 *
 * Returns exactly what `new Date(ts).toISOString()` returns, for every `ts`; the expanded
 * form falls back to formatting in full. `scripts/check-search.mts` asserts that equality.
 */
export const createIsoFormatter = (): ((ts: number) => string) => {
  let cachedSec = NaN;
  let cachedPrefix = '';
  return (ts: number): string => {
    if (!isNormalIsoTime(ts)) return new Date(ts).toISOString();
    const sec = Math.floor(ts / 1000);
    if (sec !== cachedSec) {
      cachedSec = sec;
      cachedPrefix = new Date(sec * 1000).toISOString().slice(0, 19);
    }
    const ms = ts - sec * 1000;
    return `${cachedPrefix}.${ms < 10 ? '00' : ms < 100 ? '0' : ''}${ms}Z`;
  };
};
