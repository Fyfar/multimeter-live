// Self-check for lib/persist.ts. Run by `npm run check` (see docs/quality.md).
//
// The planner decides what lands in IndexedDB; a wrong tail rewrite, trim bound or session end
// corrupts a saved session in a way nobody sees until the day it is restored. So: drive a real
// SampleStore through random appends, notes, trims, clears and SKIPPED flushes (a failed save),
// apply every plan to an in-memory fake of the database, and require that what is stored
// assembles back into exactly the live store.

import assert from 'node:assert/strict';
import {
  adoptedMark, assembleSession, HISTORY_MAX_AGE_MS, planFlush, planLoad,
  type FlushMark, type FlushPlan, type FlushView, type SessionSummary,
} from '../lib/persist.ts';
import { CHUNK, MODES, SampleStore, type Segment } from '../lib/samples.ts';
import type { VerdictRow } from '../lib/passfail.ts';

// The stored segment size, written out rather than imported: it is part of the saved format,
// so changing it in persist.ts must fail here rather than move the check along with it.
const SEGMENT = 256;
let checks = 0;
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); checks++; };

/** The slice of IndexedDB the app uses, as maps. */
class FakeDb {
  sessions = new Map<number, SessionSummary>();
  segments = new Map<string, Segment>();
  notes = new Map<number, [number, string][]>();
  verdicts = new Map<number, VerdictRow[]>();
  remove(id: number) {
    for (const k of [...this.segments.keys()]) if (k.startsWith(`${id}:`)) this.segments.delete(k);
    this.sessions.delete(id); this.notes.delete(id); this.verdicts.delete(id);
  }
  apply(plan: FlushPlan, store: SampleStore, verdicts: VerdictRow[]) {
    assert.ok(plan.removeSession === null || plan.closeSummary === null, 'a plan never both closes and removes');
    if (plan.removeSession !== null) this.remove(plan.removeSession);
    if (plan.closeSummary !== null) this.sessions.set(plan.closeSummary.id, plan.closeSummary);
    const s = plan.summary;
    if (s === null) return;
    for (const { seq, n } of plan.segments) this.segments.set(`${s.id}:${seq}`, store.segment(seq - store.firstSeq, n));
    if (plan.deleteBelow !== null) {
      for (const k of [...this.segments.keys()]) {
        const [id, seq] = k.split(':').map(Number);
        if (id === s.id && seq < plan.deleteBelow) this.segments.delete(k);
      }
    }
    if (plan.writeNotes) {
      this.notes.set(s.id, Array.from({ length: store.count }, (_, i) => store.at(i))
        .filter((r) => r.note !== '').map((r) => [r.seq, r.note]));
    }
    if (plan.writeVerdicts) this.verdicts.set(s.id, verdicts);
    this.sessions.set(s.id, s);
  }
  sorted(id: number): Segment[] {
    return [...this.segments].filter(([k]) => k.startsWith(`${id}:`)).map(([, v]) => v).sort((a, b) => a.seq - b.seq);
  }
}

/** A persister without the I/O: view from the live store, plan, apply, remember. */
class Saver {
  db = new FakeDb();
  last: FlushMark | null = null;
  clock = 1_000;
  notesDirty = false;
  verdictsDirty = false;
  verdicts: VerdictRow[] = [];
  mode: string | null = 'VOLTAGE';
  chartFromSeq = 0;
  minId = 0;
  // Every row of each session as it stood at its last successful flush.
  flushed = new Map<number, unknown[]>();
  store: SampleStore;
  constructor(store: SampleStore) { this.store = store; }
  view(): FlushView {
    const s = this.store;
    return {
      now: ++this.clock, count: s.count, firstSeq: s.firstSeq, generation: s.generation,
      firstTs: s.count ? s.tsAt(0) : null, lastTs: s.count ? s.tsAt(s.count - 1) : null,
      verdictRows: this.verdicts.length, notes: s.noteCount, minId: this.minId, mode: this.mode, unit: 'V', chartFromSeq: this.chartFromSeq,
      modes: [...MODES], units: s.unitDictionary,
      notesDirty: this.notesDirty, verdictsDirty: this.verdictsDirty,
    };
  }
  flush(): FlushPlan | null {
    const plan = planFlush(this.view(), this.last);
    if (plan === null) return null;
    this.db.apply(plan, this.store, this.verdicts);
    this.last = plan.summary ? { summary: plan.summary, generation: this.store.generation } : null;
    if (plan.summary) {
      this.minId = Math.max(this.minId, plan.summary.id + 1);
      this.flushed.set(plan.summary.id, Array.from({ length: this.store.count }, (_, i) => this.store.at(i)));
    }
    this.notesDirty = this.verdictsDirty = false;
    return plan;
  }
}
const fill = (s: SampleStore, n: number, t0 = s.count + s.firstSeq) => {
  for (let i = 0; i < n; i++) s.append(t0 + i, (t0 + i) * 0.001, 'VOLTAGE', i % 9 === 0 ? 'mV' : 'V', 3);
};

// --- an idle app saves nothing -------------------------------------------------------------
{
  const sv = new Saver(new SampleStore());
  eq(sv.flush(), null, 'empty store, no verdicts: nothing to save');
  eq(sv.db.sessions.size, 0, 'no session record is created');
}

// --- growing store: only the tail segment is rewritten, and a full one never again ----------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, 100);
  const p1 = sv.flush()!;
  eq(p1.segments, [{ seq: 0, n: 100 }], 'first flush: one partial segment');
  eq([p1.summary!.gridOrigin, p1.summary!.count, p1.removeSession], [0, 100, null], 'summary and origin');
  fill(store, 155);
  eq(sv.flush()!.segments, [{ seq: 0, n: 255 }], 'growing within the tail rewrites only the tail');
  fill(store, 1);
  eq(sv.flush()!.segments, [{ seq: 0, n: 256 }], 'the tail fills');
  fill(store, 1);
  eq(sv.flush()!.segments, [{ seq: 256, n: 1 }], 'a full segment is never rewritten');
  fill(store, 300);
  eq(sv.flush()!.segments, [{ seq: 256, n: 256 }, { seq: 512, n: 45 }], 'a flush spanning several segments');
  eq(sv.flush(), null, 'nothing changed: no write');
  eq(sv.db.sorted(p1.summary!.id).length, 3, 'storage holds exactly the segments, not duplicates');
}

// --- notes, verdicts and context changes flush without rewriting samples ------------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, 300);
  sv.flush();
  sv.notesDirty = true;
  const n = sv.flush()!;
  eq([n.segments, n.writeNotes, n.writeVerdicts], [[], true, false], 'a note edit rewrites notes only');
  sv.chartFromSeq = 300;
  const c = sv.flush()!;
  eq([c.segments, c.summary!.chartFromSeq], [[], 300], 'a watermark move updates the summary only');
  sv.verdicts = [{ id: 0 } as VerdictRow];
  sv.verdictsDirty = true;
  eq([sv.flush()!.writeVerdicts, sv.db.verdicts.get(sv.last!.summary.id)!.length], [true, 1], 'verdict rows saved');
}

// --- a unit added mid-session is in the same flush's dictionary -------------------------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, 10);
  sv.flush();
  store.append(99, 1, 'CAPACITANCE', 'GF', 2);
  const p = sv.flush()!;
  eq(p.summary!.units, store.unitDictionary, 'dictionary written with the segment that uses it');
  eq(p.summary!.units.includes('GF'), true, 'the new unit is in it');
}

// --- retention: a trim moves the delete bound to firstSeq and dirties notes ----------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, CHUNK * 2 + 500);
  sv.flush();
  store.trim(store.tsAt(CHUNK - 1) + 1);
  eq(store.firstSeq, CHUNK, 'precondition: the head chunk was dropped');
  const p = sv.flush()!;
  eq([p.deleteBelow, p.writeNotes, p.segments], [CHUNK, true, []], 'trim: delete below firstSeq, notes rewritten');
  eq(sv.db.sorted(p.summary!.id)[0].seq, CHUNK, 'storage starts at the new firstSeq');
  // a trim exactly on the boundary must keep the first retained segment
  eq(sv.db.sorted(p.summary!.id).length * SEGMENT >= store.count, true, 'the first retained segment survived');
}

// --- the start is clamped to firstSeq when a failed save let retention overtake the flush ---------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, 100);
  sv.flush();
  fill(store, CHUNK * 2 + 50); // unflushed (saves failing)
  store.trim(store.tsAt(CHUNK * 2 - 1) + 1);
  eq(store.firstSeq, CHUNK * 2, 'precondition: two chunks dropped past the last flush');
  const p = sv.flush()!;
  eq([p.segments[0].seq, p.deleteBelow], [CHUNK * 2, CHUNK * 2], 'resumes at firstSeq, drops the stale segment');
}

// --- a trim that empties the store (partial last chunk too) re-anchors the grid --------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  sv.verdicts = [{ id: 0 } as VerdictRow]; sv.verdictsDirty = true; // keeps the session alive
  fill(store, CHUNK + 100);
  sv.flush();
  store.trim(Infinity);
  eq([store.count, store.firstSeq % SEGMENT !== 0], [0, true], 'precondition: emptied, firstSeq off the grid');
  sv.flush();
  for (const n of [120, 120, 300]) { fill(store, n); sv.flush(); }
  const id = sv.last!.summary.id;
  const back = new SampleStore();
  back.load(assembleSession(sv.db.sessions.get(id)!, sv.db.sorted(id), [], []).loadable);
  eq([back.count, back.firstSeq], [store.count, store.firstSeq], 'the re-anchored session still assembles');
}

// --- a restored session continues from its stored mark, or is rewritten whole -----------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, 600);
  const s = sv.flush()!.summary!;
  sv.last = adoptedMark({ ...s, state: 'previous' }, store.generation, false);
  eq(sv.flush(), null, 'adopted as stored: nothing to write');
  sv.last = adoptedMark({ ...s, state: 'previous' }, store.generation, true);
  const p = sv.flush()!;
  eq([p.segments, p.summary!.state, p.summary!.endSeq, p.deleteBelow],
    [[{ seq: 0, n: 256 }, { seq: 256, n: 256 }, { seq: 512, n: 88 }], 'active', 600, null],
    'rewrite: every segment and the summary are written again');
  sv.last = adoptedMark({ ...s, state: 'previous' }, store.generation, true);
  store.clear();
  eq(sv.flush()!.closeSummary!.endSeq, 600, 'ended before its rewrite: closed with its real endSeq, not the -1 marker');
}

// A session in storage as rows, the way the persister would restore it.
const restoredRows = (db: FakeDb, id: number) => {
  const a = assembleSession(db.sessions.get(id)!, db.sorted(id), db.notes.get(id) ?? [], db.verdicts.get(id) ?? []);
  const back = new SampleStore();
  back.load(a.loadable);
  return Array.from({ length: back.count }, (_, i) => back.at(i));
};

// --- a clear ends the session and keeps it; the next one gets a new id and grid origin --------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, 700);
  store.setNote(3, 'kept');
  const first = sv.flush()!.summary!;
  eq([first.count, first.notes, first.verdicts], [700, 1, 0], 'the summary carries the counts');
  store.clear();
  const end = sv.flush()!;
  eq([end.removeSession, end.closeSummary?.state, end.summary], [null, 'closed', null], 'clear of a keepable session closes it');
  eq([sv.db.sessions.get(first.id)!.state, restoredRows(sv.db, first.id)], ['closed', sv.flushed.get(first.id)],
    'the closed session keeps its segments and assembles as it was');
  eq(sv.flush(), null, 'an emptied store keeps saving nothing');
  fill(store, 40, 9_999);
  const next = sv.flush()!;
  eq(next.summary!.id > first.id, true, 'a new session has a new id');
  eq([next.summary!.gridOrigin, next.segments], [700, [{ seq: 700, n: 40 }]], 'its grid starts at its own first seq');
  eq([next.removeSession, next.closeSummary], [null, null], 'nothing left to end');

  // clear + new samples before the next flush: one plan ends the old session and starts the new
  fill(store, 5);
  sv.flush();
  store.clear();
  fill(store, 3);
  const swap = sv.flush()!;
  eq([swap.closeSummary?.id, swap.summary!.count], [next.summary!.id, 3], 'a clear between flushes is still seen');
  eq([...sv.db.sessions.values()].map((x) => x.state), ['closed', 'closed', 'active'], 'both ended sessions are in History');

  // too short to keep: removed whole
  store.clear();
  fill(store, 12);
  const short = sv.flush()!.summary!;
  eq(short.count, 12, 'precondition: 12 samples');
  store.clear();
  const gone = sv.flush()!;
  eq([gone.removeSession, gone.closeSummary], [short.id, null], 'clear of a 12-sample session removes it');
  eq(sv.db.sessions.has(short.id) || sv.db.sorted(short.id).length > 0, false, 'and leaves nothing of it');
}

// --- Clear Data leaves verdict rows alive; the saved copy keeps mirroring them ---------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  sv.verdicts = [{ id: 0 } as VerdictRow]; sv.verdictsDirty = true;
  fill(store, 6);
  const a = sv.flush()!.summary!;
  store.clear();
  const p = sv.flush()!;
  eq([p.closeSummary?.id, p.summary!.count, p.summary!.id > a.id, p.writeVerdicts], [a.id, 0, true, true],
    'a 6-sample session with a verdict is kept; a new sample-less session holds the rows');
  const t0 = p.summary!.lastTs;
  sv.verdicts = [...sv.verdicts, { id: 1 } as VerdictRow]; sv.verdictsDirty = true;
  eq(sv.flush()!.summary!.lastTs > t0, true, 'a sample-less session ages from its last change');
  sv.verdicts = []; sv.verdictsDirty = true;
  const q = sv.flush()!;
  eq([q.removeSession, q.closeSummary, q.summary], [p.summary!.id, null, null], 'Clear Batch on a sample-less session deletes it');
}

// --- ids: never below one already seen, even with the clock set back -------------------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  sv.minId = 5_000_000;
  fill(store, 40);
  eq(sv.flush()!.summary!.id, 5_000_000, 'a clock behind the newest kept id does not reuse an id');
  store.clear();
  fill(store, 40);
  eq(sv.flush()!.summary!.id, 5_000_001, 'the next session moves past the last one minted');
}

// --- a restored 2.4.0 session gets its counts written without its samples -------------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, 300);
  const s = sv.flush()!.summary!;
  const old = { ...s, state: 'previous' as const };
  delete old.verdicts; delete old.notes;
  sv.last = adoptedMark(old, store.generation, false);
  const p = sv.flush()!;
  eq([p.segments, p.writeNotes, p.summary!.verdicts, p.summary!.notes], [[], false, 0, 0], 'summary-only rewrite adds the counts');
}

// --- plan -> store -> assemble -> load: random sessions round-trip row for row --------------------
let seed = 20_261_103;
const rnd = () => { seed = (seed * 1_664_525 + 1_013_904_223) >>> 0; return seed / 2 ** 32; };
const pick = (n: number) => Math.floor(rnd() * n);
for (let round = 0; round < 6; round++) {
  const store = new SampleStore();
  const sv = new Saver(store);
  let t = 0;
  for (let step = 0; step < 120; step++) {
    const op = rnd();
    if (op < 0.55) {
      const n = 1 + pick(400);
      for (let i = 0; i < n; i++) {
        store.append(t++, rnd() * 10, MODES[pick(MODES.length)], pick(40) === 0 ? 'GF' : 'V', pick(6));
      }
    } else if (op < 0.7 && store.count > 0) {
      store.setNote(store.firstSeq + pick(store.count), pick(3) ? `note ${step}` : '');
      sv.notesDirty = true;
    } else if (op < 0.78 && store.count > CHUNK + 10) {
      store.trim(store.tsAt(CHUNK - 1) + 1);
    } else if (op < 0.82) {
      store.clear();
    }
    if (pick(10) < 7) sv.flush(); // otherwise this save "failed"; the next one must catch up
  }
  sv.flush();
  const id = sv.last?.summary.id;
  const ended = [...sv.db.sessions.values()].filter((x) => x.id !== id);
  eq(ended.every((x) => x.state === 'closed' && (x.count >= 30 || x.notes! > 0)), true, `round ${round}: every ended session in storage is closed and keepable`);
  eq([...sv.db.segments.keys()].every((k) => sv.db.sessions.has(Number(k.split(':')[0]))), true, `round ${round}: no stray segments of removed sessions`);
  for (const x of ended) eq(restoredRows(sv.db, x.id), sv.flushed.get(x.id), `round ${round}: closed ${x.id} is its last flush`);
  if (store.count === 0) {
    eq(id, undefined, `round ${round}: an emptied live session leaves nothing behind`);
    continue;
  }
  eq(sv.db.sessions.get(id!)!.state, 'active', `round ${round}: the live session is active`);
  eq(sv.db.sorted(id!)[0].seq, store.firstSeq, `round ${round}: nothing below firstSeq survives`);

  const back = restoredRows(sv.db, id!);
  eq(back.length, store.count, `round ${round}: count`);
  for (let i = 0; i < store.count; i++) {
    assert.deepEqual(back[i], store.at(i), `round ${round}: row ${i}`);
  }
  checks += store.count;
}

// --- assembly refuses instead of guessing -----------------------------------------------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, 256 * 5 + 17);
  const s = sv.flush()!.summary!;
  const segs = sv.db.sorted(s.id);
  const ok = () => assembleSession(s, segs, [], []);
  eq(ok().loadable.segments.length, 6, 'control: the intact session assembles');
  assert.throws(() => assembleSession(s, segs.filter((_, i) => i !== 2), [], []), /expected .* found/, 'a missing middle segment');
  assert.throws(() => assembleSession(s, segs.slice(0, 5), [], []), /expected .* found/, 'a missing tail');
  assert.throws(() => assembleSession({ ...s, schemaVersion: s.schemaVersion + 1 }, segs, [], []), /incompatible/, 'a newer schema');
  assert.throws(() => assembleSession({ ...s, mode: null }, segs, [], []), /no measurement mode/, 'no mode saved');
  checks += 4;
  // the store catches a gap that keeps the total right (one segment replaced by another's bytes)
  const swapped = [...segs]; swapped[2] = { ...segs[1], seq: segs[2].seq + 1 };
  assert.throws(() => new SampleStore().load(assembleSession(s, swapped, [], []).loadable), /does not follow/, 'misplaced segment');
  checks++;
}

// --- load lifecycle: what a page does with the sessions it finds ------------------------------
{
  const NOW = 1_793_750_400_000; // 2026-11-04
  const DAY = 86_400_000;
  const row = (id: number, state: SessionSummary['state'], daysAgo: number, count = 100, extra: Partial<SessionSummary> = { verdicts: 0, notes: 0 }) =>
    ({ id, state, lastTs: NOW - daysAgo * DAY, count, ...extra }) as SessionSummary;
  const brief = (p: ReturnType<typeof planLoad>) =>
    [p.previous?.id ?? null, p.relabel.map((r) => `${r.id}:${r.state}`).sort(), p.remove.sort(), p.maxId];

  eq(brief(planLoad([], NOW)), [null, [], [], 0], 'nothing stored -> nothing');
  eq(brief(planLoad([row(5, 'active', 0)], NOW)), [5, ['5:previous'], [], 5], 'a dead page left one: it is offered');
  eq(brief(planLoad([row(3, 'previous', 2), row(5, 'active', 1)], NOW)), [5, ['3:closed', '5:previous'], [], 5],
    'crash, then crash: the newer is offered, the older joins History');
  eq(brief(planLoad([row(3, 'previous', 1)], NOW)), [3, [], [], 3], 'an offer already made is left alone');
  eq(brief(planLoad([row(4, 'closed', 0), row(2, 'closed', 1)], NOW)), [null, [], [], 4], 'a closed session is never offered');
  eq(brief(planLoad([row(1, 'closed', 29), row(2, 'closed', 31)], NOW)), [null, [], [2], 2], '29 days old stays, 31 days old expires');
  eq(planLoad([row(1, 'closed', 31)], NOW - 2 * DAY).remove, [], 'the same session two days earlier was not yet expired');
  eq(brief(planLoad([row(6, 'previous', 31), row(7, 'closed', 1)], NOW)), [null, [], [6], 7], 'an expired offer is not offered');
  eq(brief(planLoad([row(8, 'previous', 3, 0, {})], NOW)), [8, [], [], 8], 'a 2.4.0 offer without counts and no samples is kept');
  eq(brief(planLoad([row(9, 'active', 0, 10)], NOW)), [null, [], [9], 9], 'a 10-sample crashed session is removed, not offered');
  eq(brief(planLoad([row(9, 'active', 0, 10, { verdicts: 1, notes: 0 })], NOW)), [9, ['9:previous'], [], 9], 'unless it holds a verdict');
  eq(brief(planLoad([row(9, 'active', 0, 10, { verdicts: 0, notes: 1 })], NOW)), [9, ['9:previous'], [], 9], 'or a note');
  eq(HISTORY_MAX_AGE_MS, 30 * DAY, 'history keeps sessions for 30 days');
  eq(brief(planLoad([row(1, 'active', 0, 29), row(2, 'closed', 0, 30)], NOW)), [null, [], [1], 2], '29 samples is too short, 30 is kept');
}

console.log(`check-persist: ${checks} assertions passed`);
