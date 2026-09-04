import { describe, expect, it } from 'vitest';
import { FixedLoop } from '../src/core/loop.js';

describe('fixed loop', () => {
  it('runs whole steps and keeps the remainder', () => {
    const seen: number[] = [];
    const loop = new FixedLoop(1 / 60, (dt) => seen.push(dt));
    expect(loop.advance(16.7)).toBe(1);
    expect(loop.advance(16.7)).toBe(1);
    expect(loop.advance(8)).toBe(0);
    expect(loop.advance(9)).toBe(1);
    expect(seen).toEqual([1 / 60, 1 / 60, 1 / 60]);
  });

  it('always steps by exactly the fixed amount', () => {
    const seen: number[] = [];
    const loop = new FixedLoop(1 / 120, (dt) => seen.push(dt));
    loop.advance(100);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe(1 / 120);
  });

  it('gives up catching up rather than spiralling', () => {
    let steps = 0;
    const loop = new FixedLoop(1 / 60, () => steps++, 5);
    expect(loop.advance(5000)).toBe(5);
    steps = 0;
    // The backlog is dropped, so the next frame is normal rather than another
    // five steps of debt.
    expect(loop.advance(16.7)).toBe(1);
  });

  it('ignores time going backwards', () => {
    let steps = 0;
    const loop = new FixedLoop(1 / 60, () => steps++);
    expect(loop.advance(-1000)).toBe(0);
    expect(steps).toBe(0);
  });
});
