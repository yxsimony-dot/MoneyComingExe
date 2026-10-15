import { EventEmitter } from 'node:events';
import type { UpdaterAdapter, UpdaterInfo, UpdaterProgress } from './update-coordinator';

export type FakeMode = 'available' | 'up-to-date' | 'check-fail' | 'download-fail' | 'verification-fail' | 'install-fail';

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

export class FakeUpdater extends EventEmitter implements UpdaterAdapter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = true;
  allowPrerelease = false;
  allowDowngrade = false;
  logger: unknown = null;
  private readonly info: UpdaterInfo;

  constructor(private readonly mode: FakeMode = 'available') {
    super();
    this.info = {
      version: process.env.MONEYCOMING_TEST_UPDATE_VERSION || '1.0.1',
      releaseName: 'MoneyComing 测试更新',
      releaseNotes: '用于自动化验收的受控更新，不访问外部网络。',
      releaseDate: '2026-10-15T00:00:00.000Z',
    };
  }

  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  async checkForUpdates(): Promise<{ updateInfo?: UpdaterInfo } | null> {
    this.emit('checking-for-update');
    await wait(20);
    if (this.mode === 'check-fail') {
      const error = new Error('受控更新源不可用');
      this.emit('error', error);
      throw error;
    }
    if (this.mode === 'up-to-date') {
      const info = { ...this.info, version: '1.0.0' };
      this.emit('update-not-available', info);
      return { updateInfo: info };
    }
    this.emit('update-available', this.info);
    return { updateInfo: this.info };
  }

  async downloadUpdate(): Promise<string[]> {
    if (this.mode === 'download-fail' || this.mode === 'verification-fail') {
      await wait(20);
      const error = new Error(this.mode === 'verification-fail' ? 'SHA-512 integrity check failed' : '受控下载已中断');
      this.emit('error', error);
      throw error;
    }
    for (const percent of [12, 56, 100]) {
      await wait(20);
      const progress: UpdaterProgress = {
        percent,
        transferred: percent * 1024,
        total: 100 * 1024,
        bytesPerSecond: 32 * 1024,
      };
      this.emit('download-progress', progress);
    }
    this.emit('update-downloaded', this.info);
    return ['controlled-update.exe'];
  }

  quitAndInstall(): void {
    if (this.mode === 'install-fail') throw new Error('受控安装程序无法启动');
  }
}
