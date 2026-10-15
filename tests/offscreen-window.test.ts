import { describe, expect, it } from 'vitest';
import {
  isOffscreenTestLaunch,
  offscreenWindowPosition,
  rectanglesHaveAreaIntersection,
  rightmostDisplayEdge,
  windowPositionOptionsForLaunch,
} from '../src/main/offscreen-window';

describe('offscreen window geometry', () => {
  it('places a single-display window beyond the right edge with a safety margin', () => {
    const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    const position = offscreenWindowPosition(displays, { width: 1440, height: 900 }, 0);
    expect(rightmostDisplayEdge(displays)).toBe(1920);
    expect(position).toEqual({ x: 1984, y: 0 });
    expect(rectanglesHaveAreaIntersection({ ...position, width: 1440, height: 900 }, displays[0])).toBe(false);
  });

  it('uses the rightmost edge across positive, negative, and irregular display layouts', () => {
    const displays = [
      { x: -2560, y: -200, width: 2560, height: 1440 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1200, y: -1080, width: 1600, height: 900 },
    ];
    const position = offscreenWindowPosition(displays, { width: 1100, height: 720 }, -40);
    expect(rightmostDisplayEdge(displays)).toBe(2800);
    expect(position).toEqual({ x: 2864, y: -40 });
    expect(displays.every(display => !rectanglesHaveAreaIntersection(
      { ...position, width: 1100, height: 720 },
      display,
    ))).toBe(true);
  });

  it('handles layouts made entirely from negative display coordinates', () => {
    const displays = [
      { x: -3200, y: -900, width: 1280, height: 720 },
      { x: -1920, y: 0, width: 1920, height: 1080 },
    ];
    expect(offscreenWindowPosition(displays, { width: 1200, height: 800 }, 0)).toEqual({ x: 64, y: 0 });
  });

  it('treats touching edges as separate and detects partial overlap', () => {
    const display = { x: 0, y: 0, width: 100, height: 100 };
    expect(rectanglesHaveAreaIntersection(display, { x: 100, y: 20, width: 50, height: 50 })).toBe(false);
    expect(rectanglesHaveAreaIntersection(display, { x: 99, y: 20, width: 50, height: 50 })).toBe(true);
    expect(rectanglesHaveAreaIntersection(display, { x: 20, y: 99, width: 50, height: 50 })).toBe(true);
  });

  it('fails clearly when display data or window dimensions are invalid', () => {
    expect(() => offscreenWindowPosition([], { width: 100, height: 100 }, 0)).toThrow(/display rectangle/i);
    expect(() => offscreenWindowPosition(
      [{ x: 0, y: 0, width: 0, height: 100 }],
      { width: 100, height: 100 },
      0,
    )).toThrow(/displays\[0\]\.width/);
    expect(() => offscreenWindowPosition(
      [{ x: 0, y: 0, width: 100, height: 100 }],
      { width: 0, height: 100 },
      0,
    )).toThrow(/window width/);
    expect(() => offscreenWindowPosition(
      [{ x: 0, y: 0, width: 100, height: 100 }],
      { width: 100, height: Number.NaN },
      0,
    )).toThrow(/window height/);
  });
});

describe('offscreen test launch options', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  const size = { width: 1440, height: 900 };

  it('enables positioning for test mode and the explicit command-line flag', () => {
    expect(isOffscreenTestLaunch(true, [])).toBe(true);
    expect(isOffscreenTestLaunch(false, ['--test-window-offscreen'])).toBe(true);
    expect(isOffscreenTestLaunch(false, [])).toBe(false);
  });

  it('provides only x and y before construction when enabled', () => {
    const options = windowPositionOptionsForLaunch(true, displays, size, 0);
    expect(options).toEqual({ x: 1984, y: 0 });
    expect(Object.keys(options)).toEqual(['x', 'y']);
  });

  it('leaves normal launch options free of test-only coordinates', () => {
    expect(windowPositionOptionsForLaunch(false, displays, size, 0)).toEqual({});
  });
});
