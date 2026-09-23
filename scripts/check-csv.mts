// Self-check for lib/csv.ts. Run: `node scripts/check-csv.mts`
//
// Asserts against the FINISHED file — `await blob.text()` — not against the pieces it was
// built from. Comparing pieces would only restate how the function works; comparing the
// blob's text compares what actually lands on disk. A chunk boundary that gained or lost a
// newline would corrupt an export in the middle, and nothing downstream would notice.
import assert from 'node:assert/strict';

const { csvEsc, csvBlob, CSV_CHUNK_LINES, CHUNKS_PER_BLOB } = await import('../lib/csv.ts');
let checks = 0;

const HEADER = 'Timestamp,Mode,Value,Unit,Notes';
const mkLines = (n: number) =>
  Array.from({ length: n }, (_, i) => `2026-09-23T00:00:00.000Z,Resistance,${i},OM,`);

// Identical output either side of every chunk boundary, at the degenerate counts, and —
// critically — past the point where a SECOND intermediate Blob is created. Everything below
// `CSV_CHUNK_LINES * CHUNKS_PER_BLOB` assembles inside one Blob, so without that last case
// the multi-Blob path is never executed and a broken `absorb()` (a `pending` array that is
// not reset, or a missing separator where two intermediates meet) passes the whole suite.
// Derived from both constants so retuning either keeps the coverage.
const MULTI_BLOB = CSV_CHUNK_LINES * CHUNKS_PER_BLOB + 1;
for (const n of [0, 1, 2, CSV_CHUNK_LINES - 2, CSV_CHUNK_LINES - 1, CSV_CHUNK_LINES,
                 CSV_CHUNK_LINES + 1, CSV_CHUNK_LINES * 2, CSV_CHUNK_LINES * 2 + 1,
                 MULTI_BLOB - 1, MULTI_BLOB]) {
  const lines = mkLines(n);
  const expected = [HEADER, ...lines].join('\n');
  const blob = csvBlob(HEADER, lines);
  assert.equal(await blob.text(), expected, `${n} lines: the assembled file is byte-identical`);
  assert.equal(blob.size, Buffer.byteLength(expected), `${n} lines: byte length matches`);
  assert.equal(blob.type, 'text/csv;charset=utf-8', `${n} lines: media type is set`);
  checks += 3;
}

// No trailing newline — the property most likely to be "tidied up" by a later edit.
assert.ok(!(await csvBlob(HEADER, mkLines(5)).text()).endsWith('\n'), 'no trailing newline');
assert.equal(await csvBlob(HEADER, []).text(), HEADER, 'header alone, nothing appended');
checks += 2;

// The source is consumed lazily and exactly once.
{
  let produced = 0;
  function* counted() {
    for (let i = 0; i < CSV_CHUNK_LINES * 2 + 7; i++) { produced++; yield `line ${i}`; }
  }
  const text = await csvBlob(HEADER, counted()).text();
  assert.equal(produced, CSV_CHUNK_LINES * 2 + 7, 'every line was consumed');
  assert.equal(text.split('\n').length, CSV_CHUNK_LINES * 2 + 8, 'header plus every line, once each');
  checks += 2;
}

// Escaping: quotes only where needed, doubled inside.
assert.equal(csvEsc('plain'), 'plain');
assert.equal(csvEsc('has,comma'), '"has,comma"');
assert.equal(csvEsc('has"quote'), '"has""quote"');
assert.equal(csvEsc('has\nnewline'), '"has\nnewline"');
checks += 4;

// An escaped newline inside a note must survive chunking without being read as a row break.
{
  const lines = [...mkLines(CSV_CHUNK_LINES - 1), 'a,b,c,d,' + csvEsc('note\nwith newline')];
  assert.equal(await csvBlob(HEADER, lines).text(), [HEADER, ...lines].join('\n'),
    'an escaped newline straddling a chunk boundary survives');
  checks++;
}

// Non-ASCII must be encoded as UTF-8 bytes, not counted as characters.
{
  const lines = ['2026-09-23T00:00:00.000Z,Resistance,9.8,Ω,' + csvEsc('µF note')];
  const blob = csvBlob(HEADER, lines);
  const expected = [HEADER, ...lines].join('\n');
  assert.equal(await blob.text(), expected, 'non-ASCII round-trips');
  assert.equal(blob.size, Buffer.byteLength(expected, 'utf8'), 'size is UTF-8 bytes, not characters');
  assert.ok(blob.size > expected.length, 'multi-byte characters really are multi-byte');
  checks += 3;
}

console.log(`check-csv: ${checks} assertions passed`);
