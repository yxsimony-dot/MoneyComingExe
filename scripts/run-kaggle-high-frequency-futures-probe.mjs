import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'probe-kaggle-high-frequency-futures.py');

function candidates() {
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  return [
    process.env.KAGGLE_PROBE_PYTHON
      ? {
          command: process.env.KAGGLE_PROBE_PYTHON,
          prefix: [],
          source: 'KAGGLE_PROBE_PYTHON',
        }
      : null,
    {
      command: join(ROOT, '.venv', executable),
      prefix: [],
      source: '项目 .venv',
    },
    {
      command: join(homedir(), 'moneycoming-data-probe', executable),
      prefix: [],
      source: '用户数据探测隔离环境',
    },
    {
      command: process.platform === 'win32' ? 'python.exe' : 'python3',
      prefix: [],
      source: '系统 Python',
    },
    process.platform === 'win32'
      ? {
          command: 'py.exe',
          prefix: ['-3'],
          source: 'Windows Python Launcher',
        }
      : null,
  ].filter(Boolean);
}

function usable(candidate) {
  if (
    (candidate.command.includes('/') || candidate.command.includes('\\'))
    && !existsSync(candidate.command)
  ) {
    return false;
  }
  const result = spawnSync(candidate.command, [...candidate.prefix, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0;
}

const python = candidates().find(usable);
if (!python) {
  throw new Error(
    '未找到可用 Python；可通过 KAGGLE_PROBE_PYTHON 指定探测环境解释器',
  );
}

const result = spawnSync(
  python.command,
  [...python.prefix, SCRIPT, ...process.argv.slice(2)],
  {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`${python.source} 执行 Kaggle 数据探测失败，退出码 ${result.status}`);
}
