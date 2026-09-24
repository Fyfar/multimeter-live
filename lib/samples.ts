// The single store for captured measurements. No React, no DOM: `scripts/check-samples.mts`
// loads this directly under Node's type stripping, because the properties that matter here —
// chunk-boundary arithmetic, `seq` stability across a trim, notes staying on their own row —
// are silent when wrong and cannot be checked by looking at the screen.
//
// Columnar by necessity, not by taste. A sample is five scalars (19 B); the same sample as
// two objects across a chart buffer and a row buffer was 256 B. At the meter's measured 3.03
// samples/second that is the difference between 35 MB and 469 MB over a seven-day session.
// The other reason is `snapshot()`: cloning typed arrays is a memcpy, cloning 1.8 M objects
// is an object-graph walk, which is what makes a future session-restore practical at all.

import { SCALE, type Mode } from './parser.ts';

/**
 * Mode dictionary. **The order is part of the snapshot format** — a snapshot records the
 * dictionary it was written with, so appending is safe and reordering is handled by the
 * remap in `SampleStore.from`. Never renumber in place and assume old snapshots follow.
 */
export const MODES: readonly Mode[] = Object.freeze([
  'VOLTAGE',
  'CURRENT',
  'RESISTANCE',
  'CONTINUITY',
  'DIODE',
  'CAPACITANCE',
] as const);

/**
 * Unit dictionary: `''` (no unit) followed by every key of `SCALE` in `lib/parser.ts`, in
 * that file's order. **DERIVED, not copied** — a hand-maintained duplicate would drift the
 * moment a unit is added to the parser, and the drifted unit's index is exactly what
 * `MODES`/`UNITS` order promises to keep stable for snapshots.
 *
 * A store starts from this list but keeps its OWN mutable copy: `lib/parser.ts` documents
 * that what the ZT703s sends above `nF` is unconfirmed, so an unrecognized unit is appended
 * at runtime rather than throwing. A `Uint8Array` leaves ample headroom past the 14 known.
 *
 * Reordering `SCALE` is safe: a snapshot records the dictionary it was written with, and
 * `SampleStore.from` remaps by NAME.
 */
export const UNITS: readonly string[] = Object.freeze(['', ...Object.keys(SCALE)]);

/**
 * How long captured samples are kept. Time, not a sample count: the retained span must not
 * depend on the meter's packet rate (the count-based cap this replaces covered 20 minutes at
 * this meter's 3/s while claiming an hour).
 *
 * 7 days x 86,400 s x 3.03 samples/s = ~1,832,544 samples. At 19 B/sample that is ~35 MB in
 * 112 chunks. Samples leave a whole chunk at a time (see `trim`), so the retained span is
 * seven days plus up to ~90 minutes — a floor, never less.
 */
export const RETENTION_MS: number = 7 * 24 * 60 * 60 * 1000;

const CHUNK_SHIFT = 14;
/**
 * Samples per chunk: ~304 KiB of typed arrays, ~90 minutes of wall time at 3.03 samples/s.
 * DERIVED from the shift rather than written twice — index arithmetic is `i >>> CHUNK_SHIFT`
 * and `i & CHUNK_MASK`, so a literal that drifted from the shift would silently read the
 * wrong slot. Exported so the self-check probes real boundaries instead of its own copy.
 */
export const CHUNK = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK - 1;

/**
 * Upper bound on a stored `decimals`. `Reading.display` is `numPart` — a raw slice of the
 * serial buffer, bounded only by the parser's `MAX_BUFFER` of 4096 — and `displayDecimals`
 * has no clamp of its own, so a garbled packet can report a fractional-digit count in the
 * hundreds. Stored into a `Uint8Array` that wraps SILENTLY (300 becomes 44) and the row then
 * renders at the wrong precision with nothing looking wrong.
 *
 * 20 is the same ceiling `resolutionDecimals` already applies and the largest value
 * `Number.prototype.toFixed` accepts without throwing. A real reading never exceeds about 5,
 * so this only ever fires on junk.
 */
const MAX_DECIMALS = 20;

const clampDecimals = (d: number): number =>
  Number.isFinite(d) ? Math.min(MAX_DECIMALS, Math.max(0, Math.trunc(d))) : 0;

/** One stored sample, rebuilt as an object. See `SampleStore.at` before using this in render. */
export interface Sample {
  /** Monotonic id. Never reused, survives trimming — this is the row's identity. */
  seq: number;
  ts: number;
  /** Canonical base unit (V / A / OM / nF), NEVER clamped to a display range. */
  value: number;
  mode: Mode;
  /** The unit the meter reported on the wire (`mV`), not the operator-facing spelling. */
  unit: string;
  /** Fractional digits the meter displayed. Recovers both the CSV value and the LSD. */
  decimals: number;
  note: string;
}

interface Chunk {
  ts: Float64Array;
  value: Float64Array;
  mode: Uint8Array;
  unit: Uint8Array;
  decimals: Uint8Array;
}

const newChunk = (): Chunk => ({
  ts: new Float64Array(CHUNK),
  value: new Float64Array(CHUNK),
  mode: new Uint8Array(CHUNK),
  unit: new Uint8Array(CHUNK),
  decimals: new Uint8Array(CHUNK),
});

/** A structured-cloneable snapshot. Carries its dictionaries so `from` can remap. */
export interface Snapshot {
  version: 1;
  modes: string[];
  units: string[];
  firstSeq: number;
  count: number;
  chunks: Chunk[];
  notes: [number, string][];
}

export class SampleStore {
  #chunks: Chunk[] = [];
  #count = 0;
  /** `seq` of physical index 0. Rises as head chunks are dropped, and across `clear()`. */
  #firstSeq = 0;
  #notes = new Map<number, string>();
  /** This store's unit dictionary. Starts as `UNITS`, grows if the meter sends a new one. */
  #units: string[] = [...UNITS];
  #unitIndex = new Map<string, number>(UNITS.map((u, i) => [u, i]));

  /** Live samples currently retained. */
  get count(): number {
    return this.#count;
  }

  /** `seq` of the oldest retained sample. */
  get firstSeq(): number {
    return this.#firstSeq;
  }

  /** Append one sample; returns its `seq`. Writes into the tail chunk and never copies. */
  append(ts: number, value: number, mode: Mode, unit: string, decimals: number): number {
    const i = this.#count;
    const c = i >>> CHUNK_SHIFT;
    if (c === this.#chunks.length) this.#chunks.push(newChunk());
    const chunk = this.#chunks[c];
    const slot = i & CHUNK_MASK;

    chunk.ts[slot] = ts;
    chunk.value[slot] = value;
    chunk.mode[slot] = MODES.indexOf(mode);
    chunk.unit[slot] = this.#unitId(unit);
    chunk.decimals[slot] = clampDecimals(decimals);

    this.#count += 1;
    return this.#firstSeq + i;
  }

  #unitId(unit: string): number {
    const known = this.#unitIndex.get(unit);
    if (known !== undefined) return known;
    // Unknown unit: extend rather than throw. See UNITS.
    const id = this.#units.length;
    this.#units.push(unit);
    this.#unitIndex.set(unit, id);
    return id;
  }

  /** Timestamp at physical index `i`. Allocates nothing — for scans over the whole store. */
  tsAt(i: number): number {
    return this.#chunks[i >>> CHUNK_SHIFT].ts[i & CHUNK_MASK];
  }

  /** Base value at physical index `i`. Allocates nothing. */
  valueAt(i: number): number {
    return this.#chunks[i >>> CHUNK_SHIFT].value[i & CHUNK_MASK];
  }

  /**
   * The sample at physical index `i`, as an object.
   *
   * **Allocates.** Do not pass the result as a prop to a memoized component — `DataLog`'s
   * `Row` compares props by identity, and a fresh object every call defeats it. This is for
   * the CSV generator and one-off reads; render paths take scalars.
   *
   * ponytail: at() allocates; add a forEach with a reused scratch view if an export profiles hot.
   */
  at(i: number): Sample {
    const chunk = this.#chunks[i >>> CHUNK_SHIFT];
    const slot = i & CHUNK_MASK;
    const seq = this.#firstSeq + i;
    return {
      seq,
      ts: chunk.ts[slot],
      value: chunk.value[slot],
      mode: MODES[chunk.mode[slot]],
      unit: this.#units[chunk.unit[slot]],
      decimals: chunk.decimals[slot],
      note: this.#notes.get(seq) ?? '',
    };
  }

  /** The note on `seq`, or `''`. */
  noteOf(seq: number): string {
    return this.#notes.get(seq) ?? '';
  }

  /** Annotate a row. Notes are sparse and keyed by `seq`, so they survive trimming. */
  setNote(seq: number, note: string): void {
    if (note === '') this.#notes.delete(seq);
    else this.#notes.set(seq, note);
  }

  /**
   * Physical index of the first sample at or after `ts`, by binary search; `count` when every
   * sample is older. Samples are appended in timestamp order, so a window is a tail slice and
   * finding where it starts costs O(log n) instead of a scan.
   *
   * A boundary hit is INSIDE the window: this returns the FIRST index whose timestamp is
   * `>= ts`, so repeated identical timestamps all fall on the same side.
   */
  indexAtOrAfter(ts: number): number {
    let lo = 0;
    let hi = this.#count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.tsAt(mid) < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Discard samples older than `beforeTs`, a whole chunk at a time — never a partial chunk,
   * so physical index 0 always stays chunk-aligned and `i >>> CHUNK_SHIFT` keeps working.
   * Retention is therefore a floor: up to one chunk more than asked for is kept, never less.
   *
   * Returns whether anything was dropped; the chart's incremental tier needs that signal to
   * know its buckets are stale.
   */
  trim(beforeTs: number): boolean {
    let dropped = false;
    while (this.#chunks.length > 0 && this.#count > 0) {
      const live = Math.min(CHUNK, this.#count);
      // The newest sample still in the head chunk. If IT is old, the whole chunk is.
      if (this.#chunks[0].ts[live - 1] >= beforeTs) break;
      this.#chunks.shift();
      this.#firstSeq += live;
      this.#count -= live;
      dropped = true;
    }
    if (dropped) {
      // Notes on discarded rows go with them, or the map is the new unbounded buffer.
      for (const seq of this.#notes.keys()) {
        if (seq < this.#firstSeq) this.#notes.delete(seq);
      }
    }
    return dropped;
  }

  /**
   * Empty the store. **`seq` stays monotonic** — `firstSeq` advances to the next unused value
   * rather than rewinding to 0. A rewind would let a watermark held across a Clear (the
   * preserve-log-on-mode-change path keeps one) sit AHEAD of every new sample: a permanently
   * blank chart over a full Data Log, with nothing to see in a debugger.
   */
  clear(): void {
    this.#firstSeq += this.#count;
    this.#count = 0;
    this.#chunks = [];
    this.#notes.clear();
  }

  /**
   * A structured-cloneable copy. Nothing calls this yet: it exists so the store is verifiable
   * by round-trip today and so session restore is later a storage decision rather than a
   * rewrite of the data model. See design.md "Non-Goals".
   */
  snapshot(): Snapshot {
    return {
      version: 1,
      modes: [...MODES],
      units: [...this.#units],
      firstSeq: this.#firstSeq,
      count: this.#count,
      // COPIED, not referenced. Handing out the live backing stores would make
      // `SampleStore.from(store.snapshot())` share memory with `store`: both would write
      // slot N of the same chunk, each silently overwriting the other's samples, and
      // `from`'s dictionary remap would rewrite the original store in place. The copy is
      // one memcpy — the same cost `structuredClone` would pay on the way to storage.
      chunks: this.#chunks.map((c) => ({
        ts: c.ts.slice(),
        value: c.value.slice(),
        mode: c.mode.slice(),
        unit: c.unit.slice(),
        decimals: c.decimals.slice(),
      })),
      notes: [...this.#notes],
    };
  }

  /**
   * Rebuild from a snapshot, remapping its dictionaries onto the current ones. The remap is
   * what makes the dictionaries safe to reorder or extend later: a snapshot written before
   * such a change still reads back as the same measurements.
   *
   * Copies `snap.chunks` rather than adopting them, so one `Snapshot` can be restored more
   * than once — a retry after a failed restore, or two sessions from one saved file — without
   * the two stores sharing memory. Adopting them would reproduce the aliasing bug one level
   * removed: `store` would be safe while two restores silently overwrote each other.
   * Throws if the snapshot names a mode this build no longer has.
   */
  static from(snap: Snapshot): SampleStore {
    const store = new SampleStore();
    store.#firstSeq = snap.firstSeq;
    store.#count = snap.count;
    store.#chunks = snap.chunks.map((c) => ({
      ts: c.ts.slice(),
      value: c.value.slice(),
      mode: c.mode.slice(),
      unit: c.unit.slice(),
      decimals: c.decimals.slice(),
    }));
    store.#notes = new Map(snap.notes);

    // Units auto-extend (`#unitId`), so they can never fail to resolve. MODES is fixed and
    // frozen, so a name that is gone means the snapshot predates a breaking change to the
    // dictionary. Fall back to index 0 and every affected sample silently becomes VOLTAGE —
    // wrong data presented as right, which is the one outcome worth refusing to produce.
    const modeMap = snap.modes.map((m) => {
      const i = MODES.indexOf(m as Mode);
      if (i === -1) throw new Error(`snapshot has unknown mode ${JSON.stringify(m)}`);
      return i;
    });
    const unitMap = snap.units.map((u) => store.#unitId(u));
    const identity = (m: number[], n: number) =>
      m.length <= n && m.every((v, i) => v === i);

    if (!identity(modeMap, MODES.length) || !identity(unitMap, store.#units.length)) {
      for (let i = 0; i < store.#count; i++) {
        const chunk = store.#chunks[i >>> CHUNK_SHIFT];
        const slot = i & CHUNK_MASK;
        // Every byte this module writes is a valid index by construction, so the lookups
        // always hit. A hand-crafted snapshot could carry an out-of-range byte; writing the
        // resulting `undefined` into a Uint8Array coerces to 0 silently, so be explicit.
        const m = modeMap[chunk.mode[slot]];
        const u = unitMap[chunk.unit[slot]];
        if (m === undefined || u === undefined) {
          throw new Error(`snapshot has an out-of-range dictionary index at sample ${i}`);
        }
        chunk.mode[slot] = m;
        chunk.unit[slot] = u;
      }
    }
    return store;
  }
}
