import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDirectory = join(root, 'artifacts');
const changeName = 'extend-market-history-with-edb-token';
const outputJson = join(
  artifactsDirectory,
  'history-extension-final-acceptance.json',
);
const outputMarkdown = join(
  artifactsDirectory,
  'history-extension-final-acceptance.md',
);

const inputPaths = {
  baselineAudit: 'data/history-extension-baseline-audit.json',
  baselineReport: 'data/baseline-report.json',
  validationReport: 'data/baseline-validation-report.json',
  licenseAudit: 'data/market-history-license-audit.json',
  performance: 'artifacts/history-extension-performance.json',
  realBaseline: 'artifacts/real-baseline-offline-smoke.json',
  electronSmoke: 'artifacts/smoke.json',
  electronWindow: 'artifacts/offscreen-window.json',
  directExe: 'artifacts/offscreen-production-mode.json',
  installedExe: 'artifacts/installer-app-smoke.json',
  installer: 'artifacts/final-install-acceptance.json',
  upgrade: 'artifacts/nsis-upgrade-smoke.json',
  tasks: `openspec/changes/${changeName}/tasks.md`,
  packageManifest: 'package.json',
};

async function readJson(relativePath) {
  return JSON.parse(
    (await readFile(join(root, relativePath), 'utf8')).replace(/^\uFEFF/, ''),
  );
}

function runNodeScript(relativePath) {
  const result = spawnSync(
    process.execPath,
    [join(root, relativePath)],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(
    result.error,
    undefined,
    `${relativePath} 无法启动：${result.error?.message}`,
  );
  assert.equal(
    result.status,
    0,
    `${relativePath} 执行失败：${result.stderr || result.stdout}`,
  );
}

function runReleaseVerification() {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'verify-release.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(
    result.error,
    undefined,
    `verify:release 无法启动：${result.error?.message}`,
  );
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const message = result.status === 0
    ? '发布校验通过'
    : (stderr || stdout).split(/\r?\n/).filter(Boolean).at(-1);
  return {
    configuredCommand: 'npm run verify:release',
    executedCommand: 'node scripts/verify-release.mjs',
    passed: result.status === 0,
    exitCode: result.status,
    message,
    stdout,
    stderr,
  };
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory()
      ? await directorySize(path)
      : (await stat(path)).size;
  }
  return total;
}

function reportMap(report, label, expectedCount) {
  assert.equal(report.schemaVersion, 1, `${label} schemaVersion 必须为 1`);
  assert.equal(
    report.instruments.length,
    expectedCount,
    `${label} 必须包含 ${expectedCount} 个品种`,
  );
  return new Map(report.instruments.map(instrument => [
    instrument.instrumentId,
    instrument,
  ]));
}

function offscreenFlags(value, path = '', result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (key === 'offscreen' && typeof child === 'boolean') {
      result.push({ path: childPath, passed: child });
    } else {
      offscreenFlags(child, childPath, result);
    }
  }
  return result;
}

function acceptanceSummary(artifact, value, details = {}) {
  assert.equal(value.passed, true, `${artifact} 未通过`);
  const checks = offscreenFlags(value);
  assert.ok(checks.length > 0, `${artifact} 没有离屏验证记录`);
  assert.ok(
    checks.every(check => check.passed),
    `${artifact} 存在未通过的离屏验证`,
  );
  return {
    artifact,
    passed: true,
    offscreenCheckCount: checks.length,
    allWindowsOffscreen: true,
    ...details,
  };
}

function parsePendingTasks(markdown) {
  return [...markdown.matchAll(/^- \[ \] (\d+\.\d+) (.+)$/gm)]
    .map(match => ({
      id: match[1],
      description: match[2].trim(),
    }));
}

function periodText(period) {
  return `${period.first} 至 ${period.last}（${period.rows.toLocaleString('zh-CN')} 行）`;
}

function bytes(value) {
  return `${value.toLocaleString('zh-CN')} B`;
}

function milliseconds(value) {
  return `${value.toFixed(1)} ms`;
}

function markdownReport(report) {
  const instrumentRows = report.instruments.map(instrument => (
    `| ${instrument.name} | ${periodText(instrument.periods.bars1)}`
    + ` | ${periodText(instrument.periods.bars5)}`
    + ` | ${periodText(instrument.periods.bars60)}`
    + ` | ${instrument.rolloverRows} |`
  )).join('\n');
  const sourceRows = report.instruments.map(instrument => (
    `| ${instrument.name} | ${instrument.sourceRanges[0].provider}`
    + `，${instrument.sourceRanges[0].first} 至 ${instrument.sourceRanges[0].last}`
    + ` | ${instrument.authorization.conclusion} |`
  )).join('\n');
  const guiRows = Object.entries(report.guiAcceptance).map(([name, item]) => (
    `| ${name} | ${item.passed ? '通过' : '失败'}`
    + ` | ${item.allWindowsOffscreen ? '全部离屏' : '存在屏内窗口'}`
    + ` | \`${item.artifact}\` |`
  )).join('\n');
  const blockerRows = report.blockedTasks.map(task => (
    `- \`${task.id}\` ${task.description}`
  )).join('\n');
  const current = report.performance.current;
  const synthetic = report.performance.syntheticThreeYear;

  return `# 历史扩展最终验收报告

生成时间：${report.generatedAt}

OpenSpec 变更：\`${report.changeName}\`

## 结论

- \`releaseEligible: ${report.releaseEligible}\`
- 十五个现有内置品种均可离线加载、切换并计算盈亏，安装、升级和快捷方式测试均通过离屏验收。
- 当前 5/60 分钟历史仍不足三个自然年，历史扩展候选的数据再分发授权尚未确认，因此没有替换现有 EDB 内置基线。
- 用户对本机操作的同意不替代第三方行情的复制和随产品再分发授权。

## 十五品种实际数据

| 品种 | 1 分钟首末时间与行数 | 5 分钟首末时间与行数 | 60 分钟首末时间与行数 | 换月数 |
| --- | --- | --- | --- | ---: |
${instrumentRows}

## 来源区间与授权结论

| 品种 | 当前内置来源区间 | 历史扩展授权结论 |
| --- | --- | --- |
${sourceRows}

## 构建体积

| 资源 | 大小 |
| --- | ---: |
| 当前 data 目录 | ${bytes(report.build.currentDataBytes)} |
| 当前 instruments 目录 | ${bytes(report.build.currentInstrumentBytes)} |
| 安装包 | ${bytes(report.build.installer.bytes)} |
| MoneyComing.exe | ${bytes(report.build.executable.bytes)} |
| app.asar | ${bytes(report.build.appAsar.bytes)} |
| 三年合成安装包估算 | ${bytes(report.performance.storage.estimatedSyntheticInstallerBytes)} |

## 三年合成性能

合成数据只用于压力测试，不是真实行情，不能用于交易、回测、基线替换或对外分发。

| 指标 | 当前基线 | 三年合成基线 |
| --- | ---: | ---: |
| data 目录 | ${bytes(report.performance.storage.currentDataBytes)} | ${bytes(report.performance.storage.syntheticDataBytes)} |
| 启动到 data-ready | ${milliseconds(current.startupMs)} | ${milliseconds(synthetic.startupMs)} |
| 品种切换 P95 | ${milliseconds(current.switchP95Ms)} | ${milliseconds(synthetic.switchP95Ms)} |
| 峰值 working set | ${bytes(current.peakWorkingSetBytes)} | ${bytes(synthetic.peakWorkingSetBytes)} |

## GUI 与安装验收

| 验收项 | 结果 | 窗口位置 | 证据 |
| --- | --- | --- | --- |
${guiRows}

## 发布校验

- 命令：\`${report.releaseVerification.configuredCommand}\`
- 结果：${report.releaseVerification.passed ? '通过' : '失败'}
- 真实信息：\`${report.releaseVerification.message}\`
- 当前 metadata schemaVersion：${report.metadataSchemaVersions.join('、')}

## 保持阻塞的任务

${blockerRows}

## 证据

${Object.values(report.inputs).map(path => `- \`${path}\``).join('\n')}
`;
}

runNodeScript('scripts/audit-market-baselines.mjs');

const [
  baselineAudit,
  baselineReport,
  validationReport,
  licenseAudit,
  performance,
  realBaseline,
  electronSmoke,
  electronWindow,
  directExe,
  installedExe,
  installer,
  upgrade,
  packageManifest,
  tasksMarkdown,
] = await Promise.all([
  readJson(inputPaths.baselineAudit),
  readJson(inputPaths.baselineReport),
  readJson(inputPaths.validationReport),
  readJson(inputPaths.licenseAudit),
  readJson(inputPaths.performance),
  readJson(inputPaths.realBaseline),
  readJson(inputPaths.electronSmoke),
  readJson(inputPaths.electronWindow),
  readJson(inputPaths.directExe),
  readJson(inputPaths.installedExe),
  readJson(inputPaths.installer),
  readJson(inputPaths.upgrade),
  readJson(inputPaths.packageManifest),
  readFile(join(root, inputPaths.tasks), 'utf8'),
]);

assert.equal(
  baselineAudit.instrumentCount,
  15,
  '最终验收必须包含 15 个品种',
);
const baselineById = reportMap(
  baselineReport,
  'baseline-report.json',
  baselineAudit.instrumentCount,
);
const validationById = reportMap(
  validationReport,
  'baseline-validation-report.json',
  baselineAudit.instrumentCount,
);
const installedById = new Map(realBaseline.instruments.map(instrument => [
  instrument.instrumentId,
  instrument,
]));
assert.equal(installedById.size, 15, '离线安装版必须验收 15 个品种');

const rightsConfirmed = (
  licenseAudit.releaseDecision
    ?.allCandidateMarketDataRedistributionRightsConfirmed === true
);
const baselineReplacementAllowed = (
  licenseAudit.releaseDecision?.baselineReplacementAllowed === true
);
const authorizationConclusion = rightsConfirmed && baselineReplacementAllowed
  ? '历史扩展候选已通过再分发授权，可继续执行质量与发布校验。'
  : '扩展候选再分发权未确认；保持现有 EDB 内置基线，不替换、不写入发布包。';

const instruments = baselineAudit.instruments.map(instrument => {
  const baseline = baselineById.get(instrument.instrumentId);
  const validation = validationById.get(instrument.instrumentId);
  const installed = installedById.get(instrument.instrumentId);
  assert.ok(baseline, `${instrument.name} 缺少 baseline-report 记录`);
  assert.ok(validation, `${instrument.name} 缺少 validation-report 记录`);
  assert.ok(installed, `${instrument.name} 缺少安装版离线验收记录`);
  assert.ok(
    Object.values(validation.checks ?? {}).every(value => value === true),
    `${instrument.name} 基线校验未全部通过`,
  );
  assert.ok(
    installed.profitLoss
      && installed.profitLoss.incompleteTrades === 0
      && (
        installed.profitLoss.completedTrades > 0
        || installed.profitLoss.hasExplicitNoCompletedTrades === true
      ),
    `${instrument.name} 盈亏计算验收未通过`,
  );
  for (const [auditKey, reportKey] of [
    ['bars1', 'minuteRows'],
    ['bars5', 'fiveMinuteRows'],
    ['bars60', 'sixtyMinuteRows'],
  ]) {
    assert.equal(
      instrument.periods[auditKey].rows,
      baseline[reportKey],
      `${instrument.name} ${auditKey} 行数与 baseline-report 不一致`,
    );
    assert.equal(
      instrument.periods[auditKey].rows,
      validation[reportKey],
      `${instrument.name} ${auditKey} 行数与 validation-report 不一致`,
    );
    assert.equal(
      instrument.periods[auditKey].rows,
      installed[reportKey],
      `${instrument.name} ${auditKey} 行数与安装版验收不一致`,
    );
  }
  const periods = Object.values(instrument.periods);
  const first = periods.map(period => period.first).sort().at(0);
  const last = periods.map(period => period.last).sort().at(-1);
  return {
    instrumentId: instrument.instrumentId,
    name: instrument.name,
    mainSymbol: instrument.mainSymbol,
    metadataSchemaVersion: instrument.metadata.schemaVersion,
    sourceLatestAt: instrument.sourceLatestAt,
    periods: instrument.periods,
    mappingRows: instrument.mainContractMappings.rows,
    rolloverRows: instrument.rollovers.rows,
    sourceRanges: [
      {
        sourceId: 'existing-builtin-edb-baseline',
        provider: instrument.metadata.source.provider,
        endpoint: instrument.metadata.source.endpoint,
        symbol: instrument.metadata.source.symbol,
        first,
        last,
        periods: instrument.periods,
        status: 'existing-built-in-baseline-kept-unchanged',
      },
    ],
    authorization: {
      historyExtensionRedistributionPermissionConfirmed: rightsConfirmed,
      baselineReplacementAllowed,
      releaseEligible: false,
      conclusion: authorizationConclusion,
    },
  };
});

const releaseVerification = runReleaseVerification();
const blockedTaskIds = new Set(['4.2', '4.6', '6.3', '6.4']);
const blockedTasks = parsePendingTasks(tasksMarkdown)
  .filter(task => blockedTaskIds.has(task.id));
assert.deepEqual(
  blockedTasks.map(task => task.id).sort(),
  [...blockedTaskIds].sort(),
  '最终报告要求的四个真实数据任务必须保持阻塞',
);

const installerPath = join(
  root,
  'release',
  `MoneyComing-Setup-${packageManifest.version}-x64.exe`,
);
const executablePath = join(root, 'release', 'win-unpacked', 'MoneyComing.exe');
const appAsarPath = join(
  root,
  'release',
  'win-unpacked',
  'resources',
  'app.asar',
);
const [
  currentDataBytes,
  currentInstrumentBytes,
  installerInfo,
  executableInfo,
  appAsarInfo,
] = await Promise.all([
  directorySize(join(root, 'data')),
  directorySize(join(root, 'data', 'instruments')),
  stat(installerPath),
  stat(executablePath),
  stat(appAsarPath),
]);

const guiAcceptance = {
  Electron应用冒烟: acceptanceSummary(
    inputPaths.electronSmoke,
    electronSmoke,
    { startupMs: electronSmoke.startupMs },
  ),
  Electron窗口几何: acceptanceSummary(
    inputPaths.electronWindow,
    electronWindow,
  ),
  直接EXE生产模式: acceptanceSummary(
    inputPaths.directExe,
    directExe,
    {
      testMode: directExe.testMode,
      geometryOnlyTestMode: directExe.geometryOnlyTestMode,
    },
  ),
  安装版EXE: acceptanceSummary(
    inputPaths.installedExe,
    installedExe,
    { startupMs: installedExe.startupMs },
  ),
  安装与快捷方式: acceptanceSummary(
    inputPaths.installer,
    installer,
    {
      instrumentCount: installer.instruments.length,
      shortcutOffscreen: installer.offscreen.shortcut.offscreen,
      uninstalled: installer.uninstalled,
    },
  ),
  安装升级: acceptanceSummary(
    inputPaths.upgrade,
    upgrade,
    {
      oldVersion: upgrade.oldVersion,
      newVersion: upgrade.newVersion,
      snapshotPreserved: upgrade.snapshotPreserved,
      uninstalled: upgrade.uninstalled,
    },
  ),
  十五品种离线盈亏: acceptanceSummary(
    inputPaths.realBaseline,
    realBaseline,
    {
      instrumentCount: realBaseline.instruments.length,
      profitLossValidated: true,
      peakWorkingSetBytes: realBaseline.peakWorkingSetBytes,
    },
  ),
};

const releaseEligible = (
  rightsConfirmed
  && baselineReplacementAllowed
  && blockedTasks.length === 0
  && releaseVerification.passed
);
assert.equal(
  releaseEligible,
  false,
  '当前未完成真实数据授权和回填时不得生成可发布结论',
);

const report = {
  schemaVersion: 1,
  purpose: 'history-extension-final-acceptance',
  generatedAt: new Date().toISOString(),
  changeName,
  releaseEligible,
  decision: {
    historyExtensionRedistributionPermissionConfirmed: rightsConfirmed,
    baselineReplacementAllowed,
    existingBaselineChanged: false,
    conclusion: '保持现有内置基线；三年真实历史扩展不得发布。',
  },
  inputs: inputPaths,
  metadataSchemaVersions: [
    ...new Set(instruments.map(instrument => instrument.metadataSchemaVersion)),
  ].sort(),
  instruments,
  build: {
    version: packageManifest.version,
    currentDataBytes,
    currentInstrumentBytes,
    installer: {
      path: relative(root, installerPath).replaceAll('\\', '/'),
      bytes: installerInfo.size,
    },
    executable: {
      path: relative(root, executablePath).replaceAll('\\', '/'),
      bytes: executableInfo.size,
    },
    appAsar: {
      path: relative(root, appAsarPath).replaceAll('\\', '/'),
      bytes: appAsarInfo.size,
    },
  },
  performance: {
    artifact: inputPaths.performance,
    syntheticDisclaimer: performance.syntheticMethod.disclaimer,
    storage: performance.storage,
    current: {
      startupMs: performance.performance.current.startupMs,
      switchP95Ms: performance.performance.current.switchSummary.p95Ms,
      peakWorkingSetBytes: performance.performance.current.peakWorkingSetBytes,
    },
    syntheticThreeYear: {
      startupMs: performance.performance.syntheticThreeYear.startupMs,
      switchP95Ms:
        performance.performance.syntheticThreeYear.switchSummary.p95Ms,
      peakWorkingSetBytes:
        performance.performance.syntheticThreeYear.peakWorkingSetBytes,
    },
  },
  guiAcceptance,
  releaseVerification,
  blockedTasks,
};

for (const instrument of report.instruments) {
  instrument.authorization.releaseEligible = report.releaseEligible;
}

await mkdir(artifactsDirectory, { recursive: true });
await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(outputMarkdown, markdownReport(report), 'utf8');

console.log(JSON.stringify({
  generatedAt: report.generatedAt,
  instrumentCount: report.instruments.length,
  releaseEligible: report.releaseEligible,
  releaseVerification: report.releaseVerification.message,
  blockedTasks: report.blockedTasks.map(task => task.id),
  outputs: [
    relative(root, outputJson).replaceAll('\\', '/'),
    relative(root, outputMarkdown).replaceAll('\\', '/'),
  ],
}, null, 2));
