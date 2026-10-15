import assert from 'node:assert/strict';

function assertRectangle(rectangle, label) {
  assert.ok(rectangle && Number.isFinite(rectangle.x) && Number.isFinite(rectangle.y), `${label} must have finite coordinates`);
  assert.ok(Number.isFinite(rectangle.width) && rectangle.width > 0, `${label} must have a positive width`);
  assert.ok(Number.isFinite(rectangle.height) && rectangle.height > 0, `${label} must have a positive height`);
}

export function rectanglesHaveAreaIntersection(left, right) {
  assertRectangle(left, 'left rectangle');
  assertRectangle(right, 'right rectangle');
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

export function assertBoundsOffscreen(windowBounds, displayBounds, phase = 'window') {
  assertRectangle(windowBounds, `${phase} bounds`);
  assert.ok(Array.isArray(displayBounds) && displayBounds.length > 0, `${phase} requires at least one display`);
  displayBounds.forEach((display, index) => assertRectangle(display, `${phase} display ${index}`));
  const intersections = displayBounds.filter(display => rectanglesHaveAreaIntersection(windowBounds, display));
  assert.deepEqual(intersections, [], `${phase} intersects a display: ${JSON.stringify({ windowBounds, intersections, displayBounds })}`);
  return { phase, windowBounds, displayBounds, offscreen: true };
}

export async function assertElectronWindowOffscreen(app, phase) {
  const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
    if (!window) throw new Error('MoneyComing main window was not found.');
    return {
      windowBounds: window.getBounds(),
      displayBounds: screen.getAllDisplays().map(display => ({ ...display.bounds })),
      visible: window.isVisible(),
    };
  });
  return {
    ...assertBoundsOffscreen(geometry.windowBounds, geometry.displayBounds, phase),
    visible: geometry.visible,
  };
}

export function negativeCoordinateGeometryFixture() {
  const displayBounds = [
    { x: -3200, y: -900, width: 1280, height: 720 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
  ];
  return assertBoundsOffscreen(
    { x: 64, y: 0, width: 1440, height: 900 },
    displayBounds,
    'negative-coordinate-simulation',
  );
}
