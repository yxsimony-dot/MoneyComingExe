import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(
  ROOT,
  'scripts',
  'probe-huggingface-domestic-futures-ticks.py',
);
const PYARROW_VERSION = '18.1.0';

function candidates() {
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  return [
    process.env.HUGGINGFACE_PROBE_PYTHON
      ? {
          command: process.env.HUGGINGFACE_PROBE_PYTHON,
          prefix: [],
          source: 'HUGGINGFACE_PROBE_PYTHON',
        }
      : null,
    {
      command: join(ROOT, '.venv', executable),
      prefix: [],
      source: 'project .venv',
    },
    {
      command: join(homedir(), 'moneycoming-data-probe', executable),
      prefix: [],
      source: 'user data-probe environment',
    },
    {
      command: process.platform === 'win32' ? 'python.exe' : 'python3',
      prefix: [],
      source: 'system Python',
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

function run(candidate, args, options = {}) {
  return spawnSync(candidate.command, [...candidate.prefix, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

function usable(candidate) {
  if (
    (candidate.command.includes('/') || candidate.command.includes('\\'))
    && !existsSync(candidate.command)
  ) {
    return false;
  }
  return run(candidate, ['--version']).status === 0;
}

function hasPyArrow(candidate) {
  return run(candidate, ['-c', 'import pyarrow']).status === 0;
}

const python = candidates().find(usable);
if (!python) {
  throw new Error(
    'No usable Python interpreter found; set HUGGINGFACE_PROBE_PYTHON to one.',
  );
}

let temporaryDependencyRoot = null;
let pythonPath = process.env.PYTHONPATH;
try {
  if (!hasPyArrow(python)) {
    temporaryDependencyRoot = mkdtempSync(
      join(tmpdir(), 'moneycoming-huggingface-pyarrow-'),
    );
    const install = run(
      python,
      [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '--no-input',
        '--only-binary=:all:',
        '--target',
        temporaryDependencyRoot,
        `pyarrow==${PYARROW_VERSION}`,
      ],
      { stdio: 'inherit' },
    );
    if (install.error) throw install.error;
    if (install.status !== 0) {
      throw new Error(
        `Temporary pyarrow installation failed with exit code ${install.status}.`,
      );
    }
    pythonPath = [temporaryDependencyRoot, pythonPath]
      .filter(Boolean)
      .join(delimiter);
  }

  const result = run(
    python,
    [SCRIPT, ...process.argv.slice(2)],
    {
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONPATH: pythonPath,
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${python.source} failed the Hugging Face probe with exit code ${result.status}.`,
    );
  }
} finally {
  if (temporaryDependencyRoot) {
    rmSync(temporaryDependencyRoot, { recursive: true, force: true });
  }
}
