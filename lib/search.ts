// Query pre-tests for the Data Log filter. No React, no DOM: `scripts/check-search.mts` loads
// this directly under Node's type stripping.
//
// THE CONTRACT IS ONE-SIDED. `true` about a query that cannot match costs one wasted scan;
// `false` about a query that CAN match silently hides rows. Every call below errs toward
// `true`. That is also why these live here rather than inline in the component — a `.tsx`
// is unreachable from a self-check, and both bugs noted below shipped in the inline version.

// `localIso()` as fixed-width templates. `0` = any digit, `±` = a sign.
//
// TWO of them, because the output is not always 29 characters — outside years 0000-9999 it
// carries a sign and six year digits, as `toISOString` does:
//   '+010000-01-01T02:00:00.000+02:00'
// Modelling only the normal form rejected '+' and '-053243', which really do occur.
const ISO_TEMPLATE = '0000-00-00T00:00:00.000±00:00';
const ISO_EXPANDED = '±000000-00-00T00:00:00.000±00:00';

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
 * Whether `q` could occur inside SOME ISO timestamp. Conservative: tests digit-ness, not
 * ranges, so `'9-99'` is admitted though no month is 99.
 *
 * A charset test would not do: `'tt'` is all ISO characters, but each template holds one `T`.
 * Normalizes case rather than trusting a caller precondition nothing enforces.
 */
export const couldMatchIso = (query: string): boolean => {
  const q = query.toLowerCase();
  if (q.length === 0) return true;
  return fitsTemplate(q, ISO_TEMPLATE) || fitsTemplate(q, ISO_EXPANDED);
};

/**
 * Every character `toFixed` emits for a finite argument below 1e21. Above that it falls back
 * to `ToString` and can emit letters and `+` (`(1e21).toFixed(3) === '1e+21'`), which this
 * rejects. Out of domain, not a hole: `lib/parser.ts` stores only finite values and `rowValue`
 * divides by a factor no smaller than 1e-3, so 1e21 needs a base value of 1e18 from a
 * five-digit meter. Stated because widening the domain is what would make it a hole.
 */
const VALUE_CHARS = /^[0-9.\-]+$/;

/** Whether `q` could occur inside a formatted reading. Empty matches everything. */
export const couldMatchValue = (q: string): boolean => q.length === 0 || VALUE_CHARS.test(q);

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * `ts` as ISO 8601 in the user's own timezone, with the offset spelled out
 * (`2026-10-03T17:29:05.123+03:00`): the clock the operator saw, and still unambiguous across
 * a DST change or when the file is opened elsewhere. UTC is `+00:00`, never `Z` — one shape.
 * Years outside 0000-9999 take `toISOString`'s expanded `±YYYYYY` form.
 */
export const localIso = (ts: number): string => {
  const d = new Date(ts);
  const y = d.getFullYear();
  const year = y >= 0 && y <= 9999 ? pad(y, 4) : (y < 0 ? '-' : '+') + pad(Math.abs(y), 6);
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return (
    `${year}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}` +
    `T${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}` +
    `${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`
  );
};

/**
 * `localIso` caching the per-second head and offset — ~3 samples share a wall-clock second,
 * so the `Date` work drops to a third. Returns exactly `localIso(ts)` for every `ts`;
 * `check-search.mts` asserts that equality, because two silent bugs lived here:
 *
 *  - `ts % 1000` keeps the dividend's sign, so a pre-1970 row built `…59.00-1`.
 *    `ts - sec * 1000` is always in [0, 1000) since `sec` is a floor.
 *  - `-1` as the "nothing cached" sentinel collides with a real second (the last before the
 *    epoch), reusing a stale prefix. `NaN` cannot collide.
 *
 * Caching per second is safe for the offset too: zones change offset on whole seconds.
 */
export const createIsoFormatter = (): ((ts: number) => string) => {
  let cachedSec = NaN;
  let head = '';
  let offset = '';
  return (ts: number): string => {
    if (!Number.isFinite(ts)) return localIso(ts);
    const sec = Math.floor(ts / 1000);
    if (sec !== cachedSec) {
      cachedSec = sec;
      const full = localIso(sec * 1000);
      head = full.slice(0, -10); // drop '.000+HH:MM'
      offset = full.slice(-6);
    }
    const ms = ts - sec * 1000;
    return `${head}.${ms < 10 ? '00' : ms < 100 ? '0' : ''}${ms}${offset}`;
  };
};
