// The decisions behind the durable session copy, as pure functions: what one flush writes, what
// a page does with the sessions it finds at load, and how stored segments become a session.
// No IndexedDB, no React: `scripts/check-persist.mts` runs this under Node against an in-memory
// fake, because a wrong trim bound or a mis-keyed segment corrupts a saved session silently —
// nobody looks at it again until the day it is restored. `lib/sessionDb.ts` does only I/O.

import type { VerdictRow } from './passfail.ts';
import type { Loadable, Segment } from './samples.ts';

/**
 * Samples per stored segment (~5 KB; 64 per 16,384-sample store chunk). The tail segment is
 * rewritten each flush until full. Retention drops whole store chunks, a multiple of this, so
 * a trim is always a clean key-range delete — never a split segment.
 */
const SEGMENT = 256;

/** Bump on an incompatible layout change; `assembleSession` refuses anything else. */
const SCHEMA_VERSION = 1;

// `previous` is the one session the restore notice offers; `closed` is the rest of History.
export type SessionState = 'active' | 'previous' | 'closed';

const MIN_SAMPLES = 30;
export const HISTORY_MAX_AGE_MS = 30 * 86_400_000;

export interface SessionSummary {
  id: number;
  state: SessionState;
  startTs: number;
  lastTs: number;
  count: number;
  firstSeq: number;
  endSeq: number;
  // Segment `k` starts at `gridOrigin + k * SEGMENT`. Keys use absolute `seq` because `firstSeq`
  // is not chunk-aligned after a `clear()`.
  gridOrigin: number;
  mode: string | null;
  unit: string;
  chartFromSeq: number;
  schemaVersion: number;
  // The dictionaries the stored `mode`/`unit` bytes index into. Written in the same transaction
  // as the segments that use them: a segment holding unit index 14 under a summary that stops
  // at 13 would restore the wrong unit without any error.
  modes: string[];
  units: string[];
  // Absent in summaries written by 2.4.0.
  verdicts?: number;
  notes?: number;
}

type Counts = Pick<SessionSummary, 'count' | 'verdicts' | 'notes'>;

/**
 * Whether an ended session is worth keeping in History. A summary without counts (2.4.0) is
 * kept: a Pass/Fail-only session has no samples, and zero would delete it.
 */
export const isKeepable = (s: Counts): boolean =>
  s.verdicts === undefined || s.notes === undefined || s.count >= MIN_SAMPLES || s.verdicts > 0 || s.notes > 0;

export interface FlushView {
  now: number;
  count: number;
  firstSeq: number;
  generation: number;
  firstTs: number | null;
  lastTs: number | null;
  verdictRows: number;
  notes: number;
  // Above every session id this page has seen: a clock set back must not reuse a kept one's.
  minId: number;
  mode: string | null;
  unit: string;
  chartFromSeq: number;
  modes: string[];
  units: string[];
  notesDirty: boolean;
  verdictsDirty: boolean;
}

/** What the last successful flush left in storage, and the store generation it belongs to. */
export interface FlushMark {
  summary: SessionSummary;
  generation: number;
}

export interface FlushPlan {
  // The session ended. Kept: its last summary is rewritten as `closed`. Not kept: it is deleted
  // whole, first. Never both for one id, since removals run first in the transaction.
  removeSession: number | null;
  closeSummary: SessionSummary | null;
  // Null when nothing is left to save.
  summary: SessionSummary | null;
  segments: { seq: number; n: number }[];
  // Delete segments below this seq: retention dropped them from the store.
  deleteBelow: number | null;
  writeNotes: boolean;
  writeVerdicts: boolean;
}

const matchesStorage = (cont: SessionSummary, view: FlushView, endSeq: number): boolean =>
  cont.endSeq === endSeq &&
  cont.firstSeq === view.firstSeq &&
  cont.mode === view.mode &&
  cont.unit === view.unit &&
  cont.chartFromSeq === view.chartFromSeq &&
  cont.units.length === view.units.length &&
  cont.verdicts === view.verdictRows &&
  cont.notes === view.notes &&
  !view.notesDirty &&
  !view.verdictsDirty;

// Resume at the segment holding the last flushed sample (the partial tail is rewritten),
// clamped to what the store still has; nothing to put when no sample was added.
function resumeSeq(cont: SessionSummary | null, view: FlushView, endSeq: number, origin: number): number {
  if (cont === null) return view.firstSeq;
  if (cont.endSeq === endSeq) return endSeq;
  const aligned = origin + Math.floor((cont.endSeq - origin) / SEGMENT) * SEGMENT;
  return Math.max(view.firstSeq, aligned);
}

function summaryFor(view: FlushView, cont: SessionSummary | null, endSeq: number, origin: number): SessionSummary {
  return {
    id: cont !== null ? cont.id : Math.max(view.now, view.minId),
    state: 'active',
    startTs: cont !== null ? cont.startTs : (view.firstTs ?? view.now),
    // Rewritten only on a change, so a session without samples ages from its last change.
    lastTs: view.lastTs ?? view.now,
    count: view.count,
    firstSeq: view.firstSeq,
    endSeq,
    gridOrigin: origin,
    mode: view.mode,
    unit: view.unit,
    chartFromSeq: view.chartFromSeq,
    schemaVersion: SCHEMA_VERSION,
    modes: view.modes,
    units: view.units,
    verdicts: view.verdictRows,
    notes: view.notes,
  };
}

// A trim that empties the store drops a partial last chunk too, leaving `firstSeq` off the grid.
// Everything below it is deleted anyway, so the grid restarts there.
const gridOrigin = (cont: SessionSummary | null, view: FlushView): number =>
  cont !== null && (view.firstSeq - cont.gridOrigin) % SEGMENT === 0 ? cont.gridOrigin : view.firstSeq;

type End = Pick<FlushPlan, 'removeSession' | 'closeSummary'>;
const NO_END: End = { removeSession: null, closeSummary: null };

const endPlan = (end: End): FlushPlan => ({
  ...end, summary: null, segments: [], deleteBelow: null, writeNotes: false, writeVerdicts: false,
});

/**
 * How a session that ends leaves storage: closed into History if it is worth keeping, else
 * deleted. `endSeq` is rebuilt because an adopted mark may carry -1.
 */
export const endSession = (s: SessionSummary): End =>
  isKeepable(s)
    ? { removeSession: null, closeSummary: { ...s, state: 'closed', endSeq: s.firstSeq + s.count } }
    : { removeSession: s.id, closeSummary: null };

function segmentRanges(from: number, endSeq: number): FlushPlan['segments'] {
  const out: FlushPlan['segments'] = [];
  for (let seq = from; seq < endSeq; seq += SEGMENT) out.push({ seq, n: Math.min(SEGMENT, endSeq - seq) });
  return out;
}

// A generation change (Clear, a mode change without keep-log, a trigger) ends the session. An
// emptying without one (Clear Batch on a verdicts-only session) leaves nothing to keep, and an
// idle app saves no zero-sample record that a crash would then offer.
function endOf(last: FlushMark | null, regenerated: boolean, empty: boolean): End {
  if (last === null) return NO_END;
  if (regenerated) return endSession(last.summary);
  return empty ? { removeSession: last.summary.id, closeSummary: null } : NO_END;
}

/** The one flush to run now, or null when storage already matches. */
export function planFlush(view: FlushView, last: FlushMark | null): FlushPlan | null {
  const empty = view.count === 0 && view.verdictRows === 0;
  const regenerated = last !== null && view.generation !== last.generation;
  const end = endOf(last, regenerated, empty);
  if (empty) return end === NO_END ? null : endPlan(end);
  const cont = regenerated ? null : (last?.summary ?? null);

  const endSeq = view.firstSeq + view.count;
  if (cont !== null && matchesStorage(cont, view, endSeq)) return null;

  const trimmed = cont !== null && view.firstSeq > cont.firstSeq;
  const origin = gridOrigin(cont, view);
  return {
    ...end,
    summary: summaryFor(view, cont, endSeq, origin),
    segments: segmentRanges(resumeSeq(cont, view, endSeq, origin), endSeq),
    deleteBelow: trimmed ? view.firstSeq : null,
    // A trim makes the store drop notes below `firstSeq`, so the saved ones are stale too.
    writeNotes: cont === null || view.notesDirty || trimmed,
    writeVerdicts: cont === null || view.verdictsDirty,
  };
}

/**
 * The mark a restored session continues from. `rewrite` when storage cannot be trusted to hold
 * exactly `prev` — the load remapped the dictionary bytes in RAM, or the write adopting it
 * failed: the next flush then rewrites the summary and every segment. `endSeq: -1` is what
 * forces that (no `endSeq` matches it, and the resume point clamps to `firstSeq`).
 */
export function adoptedMark(prev: SessionSummary, generation: number, rewrite: boolean): FlushMark {
  return { summary: { ...prev, state: 'active', endSeq: rewrite ? -1 : prev.endSeq }, generation };
}

export interface LoadPlan {
  previous: SessionSummary | null;
  // Summaries to rewrite with a new state.
  relabel: SessionSummary[];
  remove: number[];
  maxId: number;
}

/**
 * What a page that owns the lock does with the sessions it finds: expired and too-short ones
 * go; of those a dead page left behind (`active`) or that were already offered (`previous`), the
 * newest is offered and the rest join History as `closed`.
 */
export function planLoad(rows: readonly SessionSummary[], now: number): LoadPlan {
  const remove = rows.filter((r) => now - r.lastTs > HISTORY_MAX_AGE_MS || !isKeepable(r));
  const left = rows.filter((r) => r.state !== 'closed' && !remove.includes(r));
  const newest = left.reduce<SessionSummary | null>(
    (best, r) => (best === null || r.lastTs > best.lastTs || (r.lastTs === best.lastTs && r.id > best.id) ? r : best), null);
  const previous = newest && { ...newest, state: 'previous' as const };
  const relabel: SessionSummary[] = left.filter((r) => r !== newest).map((r) => ({ ...r, state: 'closed' }));
  if (previous !== null && newest?.state !== 'previous') relabel.push(previous);
  return {
    previous,
    relabel,
    remove: remove.map((r) => r.id),
    maxId: rows.reduce((m, r) => Math.max(m, r.id), 0),
  };
}

export interface Assembled {
  loadable: Loadable;
  context: { mode: string; unit: string; chartFromSeq: number };
  verdicts: VerdictRow[];
}

/**
 * Stored records to what `SampleStore.load` + `CaptureEngine.restore` take. Refuses rather than
 * guesses: a restore that quietly dropped a gap would present a shorter session as complete.
 * Gaps between segments, and an unknown mode, are the store's own checks.
 */
export function assembleSession(
  summary: SessionSummary,
  segments: readonly Segment[],
  notes: readonly [number, string][],
  verdicts: readonly VerdictRow[],
): Assembled {
  if (summary.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`saved by an incompatible version (schema ${summary.schemaVersion})`);
  }
  if (summary.mode === null) throw new Error('no measurement mode was saved');
  const found = segments.reduce((total, s) => total + s.n, 0);
  if (found !== summary.count) throw new Error(`expected ${summary.count} samples, found ${found}`);
  return {
    loadable: { firstSeq: summary.firstSeq, modes: summary.modes, units: summary.units, segments, notes },
    context: { mode: summary.mode, unit: summary.unit, chartFromSeq: summary.chartFromSeq },
    verdicts: [...verdicts],
  };
}
