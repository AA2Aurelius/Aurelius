import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/stream';

describe('parseRange', () => {
  it.each([
    [null, 1000, null],
    ['bytes=0-99', 1000, { offset: 0, length: 100 }],
    ['bytes=900-', 1000, { offset: 900, length: 100 }],
    ['bytes=990-5000', 1000, { offset: 990, length: 10 }],
    ['bytes=-100', 1000, { offset: 900, length: 100 }],
    ['bytes=-5000', 1000, { offset: 0, length: 1000 }],
    ['bytes=1000-', 1000, 'unsatisfiable'],
    ['bytes=-0', 1000, 'unsatisfiable'],
    ['bytes=0-', 0, 'unsatisfiable'],
    ['bytes=50-10', 1000, null],
    ['bytes=0-1,5-9', 1000, null],
    ['items=0-10', 1000, null],
    ['bytes=-', 1000, null],
  ])('%s of %d bytes', (header, size, expected) => {
    expect(parseRange(header as any, size)).toEqual(expected);
  });
});
