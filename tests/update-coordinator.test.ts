import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  UpdateCoordinator,
  type UpdaterAdapter,
  type UpdaterInfo,
  type UpdaterProgress,
} from '../src/main/update-coordinator';
import type { UpdateState } from '../src/shared/types';

class ControlledUpdater extends EventEmitter implements UpdaterAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  allowDowngrade = true;
  logger: unknown = console;
  checkCalls = 0;
  downloadCalls = 0;
  installCalls = 0;
  checkResult?: { updateInfo?: UpdaterInfo } | null;
  checkError?: Error;
  downloadError?: Error;
  installError?: Error;
  checkGate?: Promise<void>;

  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  async checkForUpdates(): Promise<{ updateInfo?: UpdaterInfo } | null> {
    this.checkCalls += 1;
    this.emit('checking-for-update');
    await this.checkGate;
    if (this.checkError) throw this.checkError;
    return this.checkResult ?? null;
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloadCalls += 1;
    if (this.downloadError) throw this.downloadError;
    return ['update.exe'];
  }

  quitAndInstall(): void {
    this.installCalls += 1;
    if (this.installError) throw this.installError;
  }

  available(info: UpdaterInfo): void {
    this.emit('update-available', info);
  }

  notAvailable(info: UpdaterInfo): void {
    this.emit('update-not-available', info);
  }

  progress(progress: UpdaterProgress): void {
    this.emit('download-progress', progress);
  }

  downloaded(info: UpdaterInfo): void {
    this.emit('update-downloaded', info);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }
}

const update = (version = '1.0.1'): UpdaterInfo => ({
  version,
  releaseName: 'MoneyComing update',
  releaseNotes: 'Stable update',
  releaseDate: '2026-10-15T00:00:00.000Z',
});

function setup(enabled = true) {
  const updater = new ControlledUpdater();
  const published: UpdateState[] = [];
  const coordinator = new UpdateCoordinator({
    updater,
    currentVersion: '1.0.0',
    enabled,
    publish: state => published.push(state),
    now: () => new Date('2026-10-15T08:00:00.000Z'),
  });
  return { updater, coordinator, published };
}

describe('UpdateCoordinator', () => {
  it('configures explicit update consent and exposes a disabled state', () => {
    const { updater, coordinator } = setup(false);
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      allowDowngrade: false,
      logger: null,
    });
    expect(coordinator.getState()).toMatchObject({
      phase: 'disabled',
      currentVersion: '1.0.0',
      currentVersionLabel: 'v1.0.0',
      error: { code: 'disabled' },
    });
  });

  it('merges duplicate checks and reports a newer version', async () => {
    const { updater, coordinator } = setup();
    let releaseCheck!: () => void;
    updater.checkGate = new Promise<void>(resolve => { releaseCheck = resolve; });
    updater.checkResult = { updateInfo: update() };

    const first = coordinator.check('manual');
    const second = coordinator.check('manual');
    expect(updater.checkCalls).toBe(1);
    releaseCheck();

    await expect(first).resolves.toMatchObject({ phase: 'available', availableVersion: '1.0.1' });
    await expect(second).resolves.toMatchObject({ phase: 'available', availableVersion: '1.0.1' });
  });

  it('reports equal and older versions as up to date', async () => {
    for (const version of ['1.0.0', '0.9.9']) {
      const { updater, coordinator } = setup();
      updater.checkResult = { updateInfo: update(version) };
      await expect(coordinator.check('manual')).resolves.toMatchObject({
        phase: 'up-to-date',
        checkedAt: '2026-10-15T08:00:00.000Z',
      });
    }
  });

  it('ignores stale out-of-order updater events', async () => {
    const { updater, coordinator } = setup();
    updater.checkResult = { updateInfo: update() };
    await coordinator.check('startup');
    updater.notAvailable(update('1.0.0'));
    updater.fail(new Error('late network error'));
    updater.progress({ percent: 50, transferred: 1, total: 2, bytesPerSecond: 1 });
    expect(coordinator.getState()).toMatchObject({ phase: 'available', availableVersion: '1.0.1' });
  });

  it('downloads only after confirmation and publishes progress', async () => {
    const { updater, coordinator, published } = setup();
    updater.checkResult = { updateInfo: update() };
    await coordinator.check('manual');

    const downloading = coordinator.download();
    updater.progress({ percent: 56, transferred: 56, total: 100, bytesPerSecond: 8 });
    updater.downloaded(update());

    await expect(downloading).resolves.toMatchObject({
      phase: 'downloaded',
      progress: { percent: 100, transferred: 100, total: 100, bytesPerSecond: 8 },
    });
    expect(updater.downloadCalls).toBe(1);
    expect(published.some(state => state.phase === 'downloading' && state.progress?.percent === 56)).toBe(true);
  });

  it.each([
    ['download failure', new Error('network interrupted'), 'download-failed'],
    ['verification failure', new Error('SHA-512 integrity check failed'), 'verification-failed'],
  ])('recovers from %s and permits retry', async (_name, failure, code) => {
    const { updater, coordinator } = setup();
    updater.checkResult = { updateInfo: update() };
    await coordinator.check('manual');
    updater.downloadError = failure;

    await expect(coordinator.download()).resolves.toMatchObject({ phase: 'failed', error: { code } });
    updater.downloadError = undefined;
    const retry = coordinator.download();
    updater.downloaded(update());
    await expect(retry).resolves.toMatchObject({ phase: 'downloaded' });
    expect(updater.downloadCalls).toBe(2);
  });

  it('keeps install launch failures recoverable', async () => {
    const { updater, coordinator } = setup();
    updater.checkResult = { updateInfo: update() };
    await coordinator.check('manual');
    const download = coordinator.download();
    updater.downloaded(update());
    await download;
    updater.installError = new Error('installer failed to start');

    await expect(coordinator.restartAndInstall()).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'install-failed' },
    });
    expect(updater.installCalls).toBe(1);
  });

  it('sanitizes public errors and release data before serialization', async () => {
    const { updater, coordinator } = setup();
    updater.checkResult = {
      updateInfo: {
        ...update(),
        releaseNotes: 'See https://example.com/private and C:\\Users\\name\\secret.txt ghp_abcdefghijklmnop',
      },
    };
    await coordinator.check('manual');
    const serialized = JSON.stringify(coordinator.getState());
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('C:\\\\Users');
    expect(serialized).not.toContain('ghp_');

    const failing = setup();
    failing.updater.checkError = new Error('failed at C:\\Users\\name\\token.txt with github_pat_abcdefghijklmnop');
    await failing.coordinator.check('manual');
    expect(JSON.stringify(failing.coordinator.getState())).not.toMatch(/Users|github_pat_/);
  });
});
