import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

export function isTrustedMainWindowEvent(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  window: BrowserWindow | null,
): boolean {
  if (!window || window.isDestroyed()) return false;
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === 'app:' && url.host === 'viewer';
  } catch {
    return false;
  }
}
