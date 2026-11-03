// Self-check for lib/persist.ts. Run by `npm run check` (see docs/quality.md).
//
// The planner decides what lands in IndexedDB; a wrong tail rewrite, trim bound or session end
// corrupts a saved session in a way nobody sees until the day it is restored. So: drive a real
// SampleStore through random appends, notes, trims, clears and SKIPPED flushes (a failed save),
// apply every plan to an in-memory fake of the database, and require that what is stored
// assembles back into exactly the live store.

import assert from 'node:assert/strict';
import {
  adoptedMark, assembleSession, planFlush, planLoad,
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
    if (plan.removeSession !== null) this.remove(plan.removeSession);
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
  store: SampleStore;
  constructor(store: SampleStore) { this.store = store; }
  view(): FlushView {
    const s = this.store;
    return {
      now: ++this.clock, count: s.count, firstSeq: s.firstSeq, generation: s.generation,
      firstTs: s.count ? s.tsAt(0) : null, lastTs: s.count ? s.tsAt(s.count - 1) : null,
      verdictRows: this.verdicts.length, mode: this.mode, unit: 'V', chartFromSeq: this.chartFromSeq,
      modes: [...MODES], units: s.unitDictionary,
      notesDirty: this.notesDirty, verdictsDirty: this.verdictsDirty,
    };
  }
  flush(): FlushPlan | null {
    const plan = planFlush(this.view(), this.last);
    if (plan === null) return null;
    this.db.apply(plan, this.store, this.verdicts);
    this.last = plan.summary ? { summary: plan.summary, generation: this.store.generation } : null;
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
}

// --- a clear ends the session; the next one gets a new id and grid origin -------------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  fill(store, 700);
  const first = sv.flush()!.summary!;
  store.clear();
  const gone = sv.flush()!;
  eq([gone.removeSession, gone.summary], [first.id, null], 'clear with nothing left: the session is removed');
  eq(sv.db.sessions.size, 0, 'and nothing remains in storage');
  eq(sv.flush(), null, 'an emptied store keeps saving nothing');
  fill(store, 40, 9_999);
  const next = sv.flush()!;
  eq(next.summary!.id !== first.id && next.summary!.id > first.id, true, 'a new session has a new id');
  eq([next.summary!.gridOrigin, next.segments], [700, [{ seq: 700, n: 40 }]], 'its grid starts at its own first seq');
  eq(next.removeSession, null, 'nothing left to remove');

  // clear + new samples before the next flush: one plan ends the old session and starts the new
  fill(store, 5);
  sv.flush();
  store.clear();
  fill(store, 3);
  const swap = sv.flush()!;
  eq([swap.removeSession, swap.summary!.count], [next.summary!.id, 3], 'a clear between flushes is still seen');
  eq([...sv.db.sessions.keys()], [swap.summary!.id], 'only the new session remains');
}

// --- Clear Data leaves verdict rows alive; the saved copy keeps mirroring them ---------------
{
  const store = new SampleStore();
  const sv = new Saver(store);
  sv.verdicts = [{ id: 0 } as VerdictRow]; sv.verdictsDirty = true;
  fill(store, 50);
  const a = sv.flush()!.summary!;
  store.clear();
  const p = sv.flush()!;
  eq([p.removeSession, p.summary!.count, p.summary!.id > a.id, p.writeVerdicts], [a.id, 0, true, true],
    'samples cleared, verdict rows remain: a new sample-less session holds them');
  sv.verdicts = []; sv.verdictsDirty = true;
  const q = sv.flush()!;
  eq([q.removeSession, q.summary], [p.summary!.id, null], 'Clear Batch on a sample-less session leaves nothing');
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
  if (store.count === 0) {
    eq(sv.db.sessions.size, 0, `round ${round}: an emptied session leaves nothing behind`);
    continue;
  }
  eq([...sv.db.sessions.keys()], [id], `round ${round}: exactly one session in storage`);
  eq([...sv.db.segments.keys()].every((k) => k.startsWith(`${id}:`)), true, `round ${round}: no stray segments of ended sessions`);
  eq(sv.db.sorted(id!)[0].seq, store.firstSeq, `round ${round}: nothing below firstSeq survives`);

  const a = assembleSession(sv.db.sessions.get(id!)!, sv.db.sorted(id!), sv.db.notes.get(id!) ?? [], sv.db.verdicts.get(id!) ?? []);
  const back = new SampleStore();
  back.load(a.loadable);
  eq([back.count, back.firstSeq], [store.count, store.firstSeq], `round ${round}: count and firstSeq`);
  for (let i = 0; i < store.count; i++) {
    assert.deepEqual(back.at(i), store.at(i), `round ${round}: row ${i}`);
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
  const act = (id: number) => ({ id, state: 'active' as const });
  const prev = (id: number) => ({ id, state: 'previous' as const });
  eq(planLoad([]), { keep: null, relabel: false, remove: [] }, 'nothing stored -> nothing');
  eq(planLoad([act(5)]), { keep: 5, relabel: true, remove: [] }, 'a dead page left one: it becomes previous');
  eq(planLoad([prev(3), act(5)]), { keep: 5, relabel: true, remove: [3] }, 'a newer left-behind replaces the older previous');
  eq(planLoad([prev(3)]), { keep: 3, relabel: false, remove: [] }, 'only a previous: left alone');
  eq(planLoad([prev(1), act(2), act(7)]), { keep: 7, relabel: true, remove: [1, 2] }, 'several actives: the newest wins');
  eq(planLoad([prev(2), prev(9)]), { keep: 9, relabel: false, remove: [2] }, 'several previous: only the newest is reachable');
}

console.log(`check-persist: ${checks} assertions passed`);
