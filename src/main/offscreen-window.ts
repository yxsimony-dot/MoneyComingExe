export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowPosition {
  x: number;
  y: number;
}

export const OFFSCREEN_WINDOW_MARGIN = 64;

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function assertPositive(value: number, label: string): void {
  assertFinite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero.`);
}

function assertRectangle(rectangle: Rectangle, label: string): void {
  assertFinite(rectangle.x, `${label}.x`);
  assertFinite(rectangle.y, `${label}.y`);
  assertPositive(rectangle.width, `${label}.width`);
  assertPositive(rectangle.height, `${label}.height`);
}

export function rightmostDisplayEdge(displays: readonly Rectangle[]): number {
  if (displays.length === 0) throw new RangeError('At least one display rectangle is required.');
  return Math.max(...displays.map((display, index) => {
    assertRectangle(display, `displays[${index}]`);
    return display.x + display.width;
  }));
}

export function rectanglesHaveAreaIntersection(left: Rectangle, right: Rectangle): boolean {
  assertRectangle(left, 'left');
  assertRectangle(right, 'right');
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

export function offscreenWindowPosition(
  displays: readonly Rectangle[],
  size: WindowSize,
  anchorY: number,
  margin = OFFSCREEN_WINDOW_MARGIN,
): WindowPosition {
  assertPositive(size.width, 'window width');
  assertPositive(size.height, 'window height');
  assertFinite(anchorY, 'window anchor y');
  assertPositive(margin, 'offscreen margin');
  return {
    x: Math.ceil(rightmostDisplayEdge(displays) + margin),
    y: Math.round(anchorY),
  };
}

export function isOffscreenTestLaunch(testMode: boolean, argv: readonly string[]): boolean {
  return testMode || argv.includes('--test-window-offscreen');
}

export function windowPositionOptionsForLaunch(
  enabled: boolean,
  displays: readonly Rectangle[],
  size: WindowSize,
  anchorY: number,
): Partial<WindowPosition> {
  return enabled ? offscreenWindowPosition(displays, size, anchorY) : {};
}
