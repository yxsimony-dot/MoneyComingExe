import { describe, expect, it } from 'vitest';
// @ts-expect-error The shared Electron helper is an executable ESM JavaScript module.
import { assertBoundsOffscreen, negativeCoordinateGeometryFixture, rectanglesHaveAreaIntersection } from './electron-offscreen.mjs';

describe('shared Electron offscreen assertion', () => {
  it('accepts a fully offscreen window', () => {
    expect(assertBoundsOffscreen(
      { x: 200, y: 0, width: 100, height: 100 },
      [{ x: 0, y: 0, width: 100, height: 100 }],
    ).offscreen).toBe(true);
  });

  it('rejects partial overlap', () => {
    expect(() => assertBoundsOffscreen(
      { x: 99, y: 25, width: 100, height: 50 },
      [{ x: 0, y: 0, width: 100, height: 100 }],
    )).toThrow(/intersects a display/);
  });

  it('checks every display in a multi-monitor layout', () => {
    const displays = [
      { x: -1920, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: -200, width: 1280, height: 1024 },
    ];
    expect(rectanglesHaveAreaIntersection({ x: 3199, y: 100, width: 50, height: 50 }, displays[2])).toBe(true);
    expect(() => assertBoundsOffscreen({ x: 3199, y: 100, width: 50, height: 50 }, displays)).toThrow();
    expect(assertBoundsOffscreen({ x: 3264, y: 100, width: 50, height: 50 }, displays).offscreen).toBe(true);
  });

  it('covers a negative-coordinate display arrangement', () => {
    const result = negativeCoordinateGeometryFixture();
    expect(result.offscreen).toBe(true);
    expect(result.displayBounds.some((display: { x: number }) => display.x < 0)).toBe(true);
  });
});
