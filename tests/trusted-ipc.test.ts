import { describe, expect, it, vi } from 'vitest';
import { isTrustedMainWindowEvent } from '../src/main/trusted-ipc';

function fixture(url = 'app://viewer/index.html') {
  const mainFrame = { url };
  const webContents = { mainFrame };
  const window = { isDestroyed: vi.fn(() => false), webContents };
  const event = { sender: webContents, senderFrame: mainFrame };
  return { event, window, webContents, mainFrame };
}

describe('trusted main-window IPC', () => {
  it('accepts only the main frame of the active viewer window', () => {
    const { event, window } = fixture();
    expect(isTrustedMainWindowEvent(event as never, window as never)).toBe(true);
  });

  it('rejects missing, destroyed, foreign-window, subframe, and foreign-origin senders', () => {
    const valid = fixture();
    expect(isTrustedMainWindowEvent(valid.event as never, null)).toBe(false);

    const destroyed = fixture();
    destroyed.window.isDestroyed.mockReturnValue(true);
    expect(isTrustedMainWindowEvent(destroyed.event as never, destroyed.window as never)).toBe(false);

    const foreignWindow = fixture();
    expect(isTrustedMainWindowEvent(
      { ...foreignWindow.event, sender: {} } as never,
      foreignWindow.window as never,
    )).toBe(false);

    const subframe = fixture();
    expect(isTrustedMainWindowEvent(
      { ...subframe.event, senderFrame: { url: 'app://viewer/frame.html' } } as never,
      subframe.window as never,
    )).toBe(false);

    const foreignOrigin = fixture('https://example.com/');
    expect(isTrustedMainWindowEvent(foreignOrigin.event as never, foreignOrigin.window as never)).toBe(false);
  });
});
