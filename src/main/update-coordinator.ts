import type { UpdateErrorCode, UpdateRequestReason, UpdateState } from '../shared/types';
import { formatVersion, isNewerVersion, normalizeVersion } from '../shared/version';

export interface UpdaterInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | Array<{ version?: string; note?: string }> | null;
  releaseDate?: string;
}

export interface UpdaterProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  logger: unknown;
  on(event: 'checking-for-update', listener: () => void): this;
  on(event: 'update-not-available' | 'update-available', listener: (info: UpdaterInfo) => void): this;
  on(event: 'download-progress', listener: (progress: UpdaterProgress) => void): this;
  on(event: 'update-downloaded', listener: (info: UpdaterInfo) => void): this;
  on(event: 'update-cancelled', listener: (info: UpdaterInfo) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  checkForUpdates(): Promise<{ updateInfo?: UpdaterInfo } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateCoordinatorOptions {
  updater: UpdaterAdapter;
  currentVersion: string;
  enabled: boolean;
  publish: (state: UpdateState) => void;
  now?: () => Date;
}

const publicText = (value: unknown, fallback: string): string => {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  const sanitized = raw
    .replace(/https?:\/\/\S+/gi, '[远程地址]')
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[本地路径]')
    .replace(/(?:ghp_|github_pat_)[A-Za-z0-9_]{12,}/gi, '[凭据]')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || fallback).slice(0, 240);
};

const releaseText = (value: UpdaterInfo['releaseNotes']): string | undefined => {
  const raw = typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(item => [item.version, item.note].filter(Boolean).join(' ')).join('\n')
      : '';
  if (!raw) return undefined;
  return publicText(raw, '').slice(0, 3000) || undefined;
};

const progressValue = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0;

export class UpdateCoordinator {
  private state: UpdateState;
  private checkPromise?: Promise<UpdateState>;
  private downloadPromise?: Promise<UpdateState>;
  private availableInfo?: UpdaterInfo;
  private operation: 'idle' | 'check' | 'download' | 'install' = 'idle';
  private readonly now: () => Date;

  constructor(private readonly options: UpdateCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    const currentVersion = normalizeVersion(options.currentVersion);
    this.state = {
      phase: options.enabled ? 'idle' : 'disabled',
      currentVersion,
      currentVersionLabel: formatVersion(currentVersion),
      ...(options.enabled ? {} : { error: { code: 'disabled' as const, message: '当前运行环境不支持生产更新' } }),
    };
    const updater = options.updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = null;
    updater.on('checking-for-update', () => {
      if (this.options.enabled && this.operation === 'check') this.transition({ phase: 'checking' });
    });
    updater.on('update-not-available', info => {
      if (this.operation !== 'check') return;
      this.availableInfo = undefined;
      this.operation = 'idle';
      this.transition({
        phase: 'up-to-date',
        availableVersion: undefined,
        releaseName: undefined,
        releaseNotes: undefined,
        releaseDate: undefined,
        progress: undefined,
        error: undefined,
        checkedAt: this.now().toISOString(),
      });
    });
    updater.on('update-available', info => {
      if (this.operation !== 'check' || !isNewerVersion(info.version, this.state.currentVersion)) return;
      this.availableInfo = info;
      this.operation = 'idle';
      this.transition({
        phase: 'available',
        ...this.publicInfo(info),
        progress: undefined,
        error: undefined,
        checkedAt: this.now().toISOString(),
      });
    });
    updater.on('download-progress', progress => {
      if (this.operation !== 'download') return;
      this.transition({
        phase: 'downloading',
        progress: {
          percent: Math.min(100, progressValue(progress.percent)),
          transferred: progressValue(progress.transferred),
          total: progressValue(progress.total),
          bytesPerSecond: progressValue(progress.bytesPerSecond),
        },
        error: undefined,
      });
    });
    updater.on('update-downloaded', info => {
      if (this.operation !== 'download') return;
      this.availableInfo = info;
      this.operation = 'idle';
      const progress = this.state.progress;
      this.transition({
        phase: 'downloaded',
        ...this.publicInfo(info),
        progress: {
          percent: 100,
          transferred: progress?.total || progress?.transferred || 0,
          total: progress?.total || progress?.transferred || 0,
          bytesPerSecond: progress?.bytesPerSecond || 0,
        },
        error: undefined,
      });
    });
    updater.on('update-cancelled', info => {
      if (this.operation !== 'download') return;
      this.availableInfo = info;
      this.operation = 'idle';
      this.fail('download-failed', new Error('更新下载已取消'));
    });
    updater.on('error', error => {
      const phase = this.operation;
      if (phase === 'idle') return;
      this.operation = 'idle';
      const verification = /sha-?512|checksum|integrity|signature|校验|签名/i.test(error.message);
      const code: UpdateErrorCode = phase === 'install'
        ? 'install-failed'
        : phase === 'download'
          ? verification ? 'verification-failed' : 'download-failed'
          : 'check-failed';
      this.fail(code, error);
    });
  }

  getState(): UpdateState {
    return JSON.parse(JSON.stringify(this.state)) as UpdateState;
  }

  async check(reason: UpdateRequestReason): Promise<UpdateState> {
    if (!this.options.enabled) return this.getState();
    if (this.checkPromise) return this.checkPromise;
    if (this.downloadPromise || this.operation === 'install') return this.getState();
    this.operation = 'check';
    this.transition({
      phase: 'checking',
      requestedBy: reason,
      progress: undefined,
      error: undefined,
    });
    this.checkPromise = (async () => {
      try {
        const result = await this.options.updater.checkForUpdates();
        if (this.operation === 'check' && result?.updateInfo) {
          const info = result.updateInfo;
          if (isNewerVersion(info.version, this.state.currentVersion)) {
            this.availableInfo = info;
            this.operation = 'idle';
            this.transition({
              phase: 'available',
              ...this.publicInfo(info),
              error: undefined,
              checkedAt: this.now().toISOString(),
            });
          } else {
            this.operation = 'idle';
            this.transition({
              phase: 'up-to-date',
              error: undefined,
              checkedAt: this.now().toISOString(),
            });
          }
        }
      } catch (error) {
        if (this.operation === 'check') {
          this.operation = 'idle';
          this.fail('check-failed', error);
        }
      } finally {
        this.checkPromise = undefined;
      }
      return this.getState();
    })();
    return this.checkPromise;
  }

  async download(): Promise<UpdateState> {
    if (!this.options.enabled) return this.getState();
    if (this.downloadPromise) return this.downloadPromise;
    if (!this.availableInfo || !['available', 'failed'].includes(this.state.phase)) {
      return this.invalidState('尚未发现可下载的新版本');
    }
    this.operation = 'download';
    this.transition({ phase: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: undefined });
    this.downloadPromise = (async () => {
      try {
        await this.options.updater.downloadUpdate();
      } catch (error) {
        if (this.operation === 'download') {
          this.operation = 'idle';
          const verification = /sha-?512|checksum|integrity|signature|校验|签名/i.test(String(error));
          this.fail(verification ? 'verification-failed' : 'download-failed', error);
        }
      } finally {
        this.downloadPromise = undefined;
      }
      return this.getState();
    })();
    return this.downloadPromise;
  }

  async restartAndInstall(): Promise<UpdateState> {
    if (!this.options.enabled) return this.getState();
    if (this.state.phase !== 'downloaded') return this.invalidState('更新尚未下载完成');
    this.operation = 'install';
    this.transition({ phase: 'installing', error: undefined });
    try {
      this.options.updater.quitAndInstall(false, true);
    } catch (error) {
      this.operation = 'idle';
      this.fail('install-failed', error);
    }
    return this.getState();
  }

  private publicInfo(info: UpdaterInfo): Partial<UpdateState> {
    return {
      availableVersion: normalizeVersion(info.version),
      releaseName: info.releaseName ? publicText(info.releaseName, '') || undefined : undefined,
      releaseNotes: releaseText(info.releaseNotes),
      releaseDate: info.releaseDate && !Number.isNaN(Date.parse(info.releaseDate)) ? new Date(info.releaseDate).toISOString() : undefined,
    };
  }

  private invalidState(message: string): UpdateState {
    this.transition({ error: { code: 'invalid-state', message } });
    return this.getState();
  }

  private fail(code: UpdateErrorCode, error: unknown): void {
    this.transition({
      phase: 'failed',
      error: { code, message: publicText(error, '更新操作失败，请稍后重试') },
    });
  }

  private transition(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.options.publish(this.getState());
  }
}
