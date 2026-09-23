// CSV assembly. No React, no DOM: `Blob` is a global in browsers and in Node 18+, so
// scripts/check-csv.mts loads this directly under Node's type stripping. It has to, because
// the one property that matters here — that the assembled file is byte-identical to a single
// join — is arithmetic at chunk boundaries and cannot be checked by looking at the screen.

/** Quote a field only when it needs it, doubling any embedded quotes. */
export const csvEsc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// Lines absorbed into the Blob at a time — ~60 KB a piece. Fully progressive (absorbing
// every chunk immediately) measured best on both peak memory and time, so this is the only
// knob and nothing depends on its exact value.
export const CSV_CHUNK_LINES = 1000;

// Chunks gathered before one intermediate Blob absorbs them. Together with the line count
// above this bounds BOTH things that can go wrong: the JS heap holds at most this many chunk
// strings (~4.5 MB), and the finished Blob is exactly two levels deep however long the
// session ran. See the nesting note below — depth is not a free parameter.
export const CHUNKS_PER_BLOB = 100;

/**
 * A CSV as a finished `Blob`, assembled without the file ever existing as one string.
 *
 * `lines` is consumed lazily into ~1,000-line chunks; every `CHUNKS_PER_BLOB` chunks are
 * absorbed into an intermediate `Blob`, and the result is one `Blob` over those
 * intermediates. Measured at 2,000,000 rows (an 89.3 MB file): **~32 MB peak heap, against
 * 94 MB holding every chunk as a string and 292 MB for a single `join`**.
 *
 * **Never chain blobs** — `blob = new Blob([blob, next])` per chunk gives the lowest peak of
 * all and produces a Blob that CANNOT BE READ. Reading recurses through the chain: depth
 * 1,000 is fine, depth 1,500 aborts the process with a V8 `StackOverflow` that try/catch
 * cannot intercept. A 2M-row export would chain ~2,000 deep, so it would build a perfect
 * file and then kill the tab on download. Two levels are safe at 2,000 x 100, and a flat
 * Blob is safe at 200,000 parts; the chain is the only shape that fails.
 *
 * The separator goes BETWEEN chunks, never after a line, so the result is exactly
 * `[header, ...lines].join('\n')` — no trailing newline, no visible chunk boundary. That
 * equality is the contract; scripts/check-csv.mts asserts it against the finished file,
 * because a corrupt export is silent.
 */
export function csvBlob(header: string, lines: Iterable<string>): Blob {
  const type = 'text/csv;charset=utf-8';
  const blobs: Blob[] = [];
  let pending: string[] = [];
  let chunk: string[] = [header];
  let started = false;

  const endChunk = () => {
    if (chunk.length === 0) return;
    pending.push(started ? '\n' + chunk.join('\n') : chunk.join('\n'));
    started = true;
    chunk = [];
  };
  const absorb = () => {
    if (pending.length === 0) return;
    blobs.push(new Blob(pending, { type }));
    pending = [];
  };

  for (const line of lines) {
    chunk.push(line);
    if (chunk.length >= CSV_CHUNK_LINES) {
      endChunk();
      if (pending.length >= CHUNKS_PER_BLOB) absorb();
    }
  }
  endChunk();
  absorb();
  return new Blob(blobs, { type });
}
