import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = join(ROOT, 'data', 'gap-history-source-audit.json');
const PYTDX_PROBE_PATH = join(ROOT, 'data', 'pytdx-public-exhq-probe.json');
const MODELSCOPE_PROBE_PATH = join(ROOT, 'data', 'modelscope-tick-source-probe.json');
const KAGGLE_PROBE_PATH = join(
  ROOT,
  'data',
  'kaggle-high-frequency-futures-data-china-probe.json',
);
const HUGGINGFACE_PROBE_PATH = join(
  ROOT,
  'data',
  'huggingface-domestic-futures-ticks-probe.json',
);
const TUSHARE_PROBE_PATH = join(ROOT, 'data', 'tushare-ft-mins-probe.json');
const TONGHUASHUN_PROBE_PATH = join(
  ROOT,
  'data',
  'tonghuashun-local-export-probe.json',
);
const MYQUANT_PROBE_PATH = join(
  ROOT,
  'data',
  'myquant-local-minute-probe.json',
);
const EASYFUT_PROBE_PATH = join(
  ROOT,
  'data',
  'easyfut-futures-minute-probe.json',
);
const SINA_CONTRACT_PROBE_PATH = join(
  ROOT,
  'data',
  'sina-futures-minute-probe.json',
);
const SINA_ENDPOINT = (
  'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/'
  + 'var%20_M0_5=/InnerFuturesNewService.getFewMinLine?symbol=M0&type=5'
);
const EASTMONEY_ENDPOINT = (
  'https://push2his.eastmoney.com/api/qt/stock/kline/get'
  + '?secid=114.m0&klt=5&fqt=1&beg=20250701&end=20251019&lmt=1000000'
  + '&fields1=f1,f2,f3,f4,f5,f6'
  + '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
);
const TARGET_GAPS = [
  {
    scope: '除豆粕外十四个品种',
    firstDate: '2025-07-01',
    lastDate: '2025-10-19',
  },
  {
    scope: '豆粕主连',
    firstDate: '2025-07-01',
    lastDate: '2025-10-08',
  },
];
const TARGET_INSTRUMENT_COUNT = 15;
const TARGET_INSTRUMENTS = [
  'DCE.m 豆粕',
  'CZCE.RM 菜粕',
  'DCE.v PVC',
  'SHFE.rb 螺纹钢',
  'CZCE.FG 玻璃',
  'CZCE.OI 菜油',
  'DCE.p 棕榈油',
  'DCE.y 豆油',
  'SHFE.sp 纸浆',
  'DCE.c 玉米',
  'CZCE.SA 纯碱',
  'DCE.a 豆一',
  'CZCE.MA 甲醇',
  'CZCE.SR 白糖',
  'DCE.b 豆二',
];
const REDISTRIBUTION_INQUIRY_QUESTIONS = [
  {
    id: 'instrument-and-date-coverage',
    question: (
      '能否提供十五个目标期货品种的具体合约 5 分钟数据，'
      + '并完整覆盖 2025-07-01 至 2025-10-19（豆粕至少至 2025-10-08）？'
    ),
  },
  {
    id: 'git-storage',
    question: '是否书面允许将购买或授权的数据保存到本项目的私有或公开 Git 仓库？',
  },
  {
    id: 'exe-redistribution',
    question: '是否书面允许将数据作为离线资源随 MoneyComing EXE 和安装包复制、交付和更新？',
  },
  {
    id: 'derived-bars-redistribution',
    question: '是否书面允许从 Tick 聚合生成 1/5/60 分钟 K 线，并将这些派生数据随产品分发？',
  },
  {
    id: 'commercial-use',
    question: '是否书面允许在商业软件、收费服务或企业内部生产环境中使用这些数据？',
  },
  {
    id: 'authorization-and-provenance',
    question: '能否提供盖章合同、授权函或等效书面许可，并说明原始行情来源及自身取得的分发权？',
  },
];

function buildWrittenAuthorizationInquiry(modelscopeProbe) {
  const uploader = modelscopeProbe.source.uploader;
  const inventory = modelscopeProbe.source.repositoryInventory;
  const message = [
    `您好，${uploader.account}：`,
    '我们正在为 MoneyComing 桌面软件评估您在 ModelScope 发布的 chinese-commodity 期货 Tick 数据集。',
    (
      `仓库清单目前包含 ${inventory.archiveCount} 个 ZIP，`
      + `时间标识从 ${inventory.firstArchivePeriod} 到 ${inventory.lastArchivePeriod}。`
    ),
    (
      '我们的用途是为十五个商品期货品种生成主连 5 分钟和 60 分钟离线历史，'
      + '并在可取得时保留 1 分钟数据用于后台精确计算。'
    ),
    (
      '请书面说明原始行情提供方、数据取得方式，以及您是否拥有授权他人复制、'
      + '转换并再分发原始 Tick 和派生 K 线的权利。'
    ),
    (
      '同时请逐项确认：允许保存至 Git 仓库；允许作为离线资源随 EXE/安装包复制和交付；'
      + '允许商业使用；允许从 Tick 聚合并分发 1/5/60 分钟 K 线。'
    ),
    '若任一项有限制，请明确可允许的部署范围、用户数量、期限、署名要求和续费条件。',
  ].join('\n');
  return {
    status: 'awaiting-provider-written-response',
    product: 'MoneyComing 多品种主连离线历史看盘',
    recipient: {
      name: uploader.account,
      email: uploader.email,
      evidence: {
        commit: uploader.evidenceCommit,
        commitSubject: uploader.evidenceCommitSubject,
      },
    },
    subject: '咨询 chinese-commodity 期货 Tick 数据来源与再分发授权',
    requestedDataset: {
      instrumentCount: TARGET_INSTRUMENT_COUNT,
      sourceGranularity: '具体合约 Tick',
      derivedGranularities: ['1 分钟', '5 分钟', '60 分钟'],
      requiredFields: [
        '北京时间时间戳',
        '合约代码',
        '开盘价',
        '最高价',
        '最低价',
        '收盘价',
        '成交量',
        '持仓量',
      ],
      targetGaps: TARGET_GAPS,
      repositoryArchiveRange: {
        firstPeriod: inventory.firstArchivePeriod,
        lastPeriod: inventory.lastArchivePeriod,
        archiveCount: inventory.archiveCount,
      },
    },
    questions: REDISTRIBUTION_INQUIRY_QUESTIONS,
    message,
    acceptanceRule: (
      '只有覆盖范围、Git 存储、EXE/安装包再分发、派生数据分发、商业使用和上游权利链'
      + '全部获得明确书面确认后，候选数据才可进入发布基线。'
    ),
  };
}

function buildEnterpriseAuthorizationInquiry(reviewedOn) {
  return {
    status: 'ready-to-send-awaiting-provider-written-quotes',
    preparedOn: reviewedOn,
    document: 'docs/历史分钟数据OEM授权询价.md',
    product: 'MoneyComing 多品种主连离线历史看盘',
    requestedDataset: {
      targetInstrumentCount: TARGET_INSTRUMENT_COUNT,
      targetInstruments: TARGET_INSTRUMENTS,
      requiredSeries: '逐具体交割合约',
      requiredNativeGranularity: '5 分钟，或可完整聚合为 5 分钟的 1 分钟/Tick',
      minimumHistoryFirstDate: '2022-10-20',
      requiredHistoryLastDate: '2026-10-16',
      requiredFields: [
        '北京时间时间戳',
        '交易所',
        '具体合约代码',
        '开盘价',
        '最高价',
        '最低价',
        '收盘价',
        '成交量',
        '持仓量',
      ],
    },
    requiredWrittenRights: [
      '允许将原始交付物和派生 5/60 分钟 K 线保存到项目私有 Git、构建缓存和备份',
      '允许把派生 5/60 分钟 K 线作为离线资源随 MoneyComing EXE、安装包和升级包复制交付',
      '允许从具体合约数据计算主力映射、换月记录和盈亏结果',
      '允许商业软件、收费交付或企业内部生产使用',
      '明确授权地域、用户数量、期限、署名、加密、审计、续费和终止后的已发布版本处理方式',
      '说明原始行情来源及供应商拥有覆盖上述用途的上游授权',
    ],
    priorityProviders: [
      {
        sourceId: 'wenhua-historical-data-service',
        provider: '文华财经历史数据服务',
        contact: '400-811-3366',
        status: 'awaiting-written-oem-redistribution-quote',
      },
      {
        sourceId: 'wind-client-api-futures-intraday',
        provider: 'Wind Client API',
        contact: 'Service@wind.com.cn / 400-820-9463',
        status: 'awaiting-written-oem-redistribution-quote',
      },
      {
        sourceId: 'ifind-enterprise-data-interface',
        provider: '同花顺 iFinD 数据接口',
        contact: '952555',
        status: 'awaiting-written-oem-redistribution-quote',
      },
      {
        sourceId: 'rqdata-futures-minute',
        provider: 'RQData 企业数据服务',
        contact: 'bd@ricequant.com / 0755-22676337',
        status: 'awaiting-written-oem-redistribution-quote',
      },
      {
        sourceId: 'csmar-futures-high-frequency-data',
        provider: 'CSMAR 定制数据服务',
        contact: 'service@csmar.com / 400-639-8883',
        status: 'awaiting-written-oem-redistribution-quote',
      },
    ],
    acceptanceRule: (
      '报价、试用账号、普通数据库订阅或 API 可访问性均不构成发布许可；'
      + '只有合同或盖章授权逐项覆盖数据范围和全部必需权利后，'
      + '才允许下载真实数据并生成发布候选。'
    ),
  };
}

function parseArguments(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    reviewedOn: new Date().toISOString().slice(0, 10),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--output' && value) {
      options.output = value;
      index += 1;
    } else if (argument === '--reviewed-on' && value) {
      options.reviewedOn = value;
      index += 1;
    } else {
      throw new Error(`未知参数或缺少参数值：${argument}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.reviewedOn)) {
    throw new Error(`--reviewed-on 必须使用 YYYY-MM-DD：${options.reviewedOn}`);
  }
  return {
    output: resolve(options.output),
    reviewedOn: options.reviewedOn,
  };
}

function parseJsonp(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) {
    throw new Error('新浪响应不包含 JSON 数组');
  }
  const rows = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(rows)) throw new Error('新浪响应主体不是数组');
  return rows;
}

async function readJson(path) {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

function coversGap(firstTimestamp, lastTimestamp, gap) {
  if (!firstTimestamp || !lastTimestamp) return false;
  return (
    firstTimestamp <= `${gap.firstDate} 00:00:00`
    && lastTimestamp >= `${gap.lastDate} 23:59:59`
  );
}

async function probeSinaRollingWindow() {
  const response = await fetch(SINA_ENDPOINT, {
    headers: {
      accept: 'text/plain, application/javascript, */*',
      'user-agent': 'MoneyComing gap source audit/1',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`新浪接口返回 HTTP ${response.status}`);
  }
  const rows = parseJsonp(text);
  const fields = rows.length > 0 ? Object.keys(rows[0]).sort() : [];
  const timestamps = rows
    .map(row => row?.d)
    .filter(value => typeof value === 'string')
    .sort();
  const firstTimestamp = timestamps[0] ?? null;
  const lastTimestamp = timestamps.at(-1) ?? null;
  const gapCoverage = TARGET_GAPS.map(gap => ({
    ...gap,
    covered: coversGap(firstTimestamp, lastTimestamp, gap),
  }));

  return {
    probeStatus: 'success',
    request: {
      symbol: 'M0',
      intervalMinutes: 5,
      endpoint: SINA_ENDPOINT,
    },
    response: {
      httpStatus: response.status,
      rows: rows.length,
      fields,
      firstTimestamp,
      lastTimestamp,
    },
    coverage: {
      targetGaps: gapCoverage,
      allTargetGapsCovered: gapCoverage.every(gap => gap.covered),
      conclusion: (
        gapCoverage.every(gap => gap.covered)
          ? '当前滚动窗口覆盖全部目标缺口。'
          : '当前滚动窗口不能覆盖 2025-07-01 至现有内置基线起点之间的目标缺口。'
      ),
    },
    retention: {
      rawResponsePersisted: false,
      rawRowsPersisted: false,
      note: '审计报告只保留行数、字段、首末时间和覆盖结论。',
    },
  };
}

async function probeEastmoneyHistory() {
  const response = await fetch(EASTMONEY_ENDPOINT, {
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: 'https://quote.eastmoney.com/',
      'user-agent': 'Mozilla/5.0 MoneyComing gap source audit/1',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    return {
      probeStatus: 'http-error',
      request: {
        symbol: '114.m0',
        intervalMinutes: 5,
        firstDate: '2025-07-01',
        lastDate: '2025-10-19',
        endpoint: EASTMONEY_ENDPOINT,
      },
      response: {
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
      },
      coverage: {
        targetGaps: TARGET_GAPS.map(gap => ({ ...gap, covered: false })),
        allTargetGapsCovered: false,
        conclusion: `公开历史接口返回 HTTP ${response.status}，未取得目标缺口记录。`,
      },
      retention: {
        rawResponsePersisted: false,
        rawRowsPersisted: false,
      },
    };
  }

  const payload = JSON.parse(text);
  const rows = Array.isArray(payload?.data?.klines) ? payload.data.klines : [];
  const timestamps = rows
    .map(row => (typeof row === 'string' ? row.split(',', 1)[0] : null))
    .filter(value => typeof value === 'string')
    .sort();
  const firstTimestamp = timestamps[0] ?? null;
  const lastTimestamp = timestamps.at(-1) ?? null;
  const gapCoverage = TARGET_GAPS.map(gap => ({
    ...gap,
    covered: coversGap(firstTimestamp, lastTimestamp, gap),
  }));

  return {
    probeStatus: 'success',
    request: {
      symbol: '114.m0',
      intervalMinutes: 5,
      firstDate: '2025-07-01',
      lastDate: '2025-10-19',
      endpoint: EASTMONEY_ENDPOINT,
    },
    response: {
      httpStatus: response.status,
      contentType: response.headers.get('content-type'),
      rows: rows.length,
      firstTimestamp,
      lastTimestamp,
    },
    coverage: {
      targetGaps: gapCoverage,
      allTargetGapsCovered: gapCoverage.every(gap => gap.covered),
      conclusion: (
        gapCoverage.every(gap => gap.covered)
          ? '接口响应时间范围覆盖全部目标缺口。'
          : '接口响应时间范围不能覆盖全部目标缺口。'
      ),
    },
    retention: {
      rawResponsePersisted: false,
      rawRowsPersisted: false,
      note: '审计报告只保留状态码、行数和首末时间。',
    },
  };
}

function candidateAssessments(
  sinaProbe,
  sinaContractProbe,
  eastmoneyProbe,
  pytdxProbe,
  modelscopeProbe,
  kaggleProbe,
  huggingfaceProbe,
  tushareProbe,
  tonghuashunProbe,
  myquantProbe,
  easyfutProbe,
  reviewedOn,
) {
  const sinaRowCount = sinaProbe.response?.rows;
  return [
    {
      sourceId: 'tushare-futures-minute',
      sourceName: 'Tushare Pro 期货分钟行情',
      accessAssessment: {
        minuteHistoryCapabilityDocumented: (
          tushareProbe.source.documentedIntervals.includes('5min')
        ),
        documentedIntervals: tushareProbe.source.documentedIntervals,
        documentedHistory: tushareProbe.source.documentedHistory,
        credentialOrPaidPermissionRequired: (
          tushareProbe.source.separatePermissionRequired
        ),
        tokenPresent: tushareProbe.environment.tokenPresent,
        probeStatus: tushareProbe.probeStatus,
        sampleRequest: tushareProbe.request,
        sampleAccessConfirmed: tushareProbe.coverage.sampleAccessConfirmed,
        concreteContractAttributionAvailable: (
          tushareProbe.coverage.specificContractAttributionAvailable
        ),
        targetGapCoverageConfirmed: (
          tushareProbe.coverage.targetGapCoverageConfirmed
        ),
        realGapProbePerformed: tushareProbe.response.requestPerformed,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: tushareProbe.conclusion.releaseEligibility,
        reason: tushareProbe.conclusion.note,
      },
      retention: tushareProbe.retention,
      evidence: [
        {
          type: 'local-summary-only-live-probe',
          path: 'data/tushare-ft-mins-probe.json',
          capturedAt: tushareProbe.capturedAt,
          probeStatus: tushareProbe.probeStatus,
        },
        {
          type: 'official-api-documentation',
          url: tushareProbe.source.apiDocumentationUrl,
        },
        {
          type: 'official-data-service-agreement',
          url: tushareProbe.source.dataServiceAgreementUrl,
        },
      ],
    },
    {
      sourceId: 'ftshare-futures-minutes',
      sourceName: 'FTShare 期货历史分钟 K 线',
      accessAssessment: {
        officialSkillCommit: 'f6840b1dbeaefebdac29c53479a9cd38c42a3459',
        endpoint: 'https://market.ft.tech/gateway/api/v2/market/data/futures_minutes',
        specificContractOnly: true,
        documentedIntervals: ['1min', '5min', '15min', '30min', '60min'],
        documentedMaximumNaturalDaySpanPerRequest: 3,
        documentedMaximumRowsPerContract: 1000,
        credentialRequired: true,
        apiKeyPresent: false,
        probeStatus: 'blocked-missing-api-key',
        probeHttpStatus: 403,
        sampleRequest: {
          symbol: 'M2509.DCE',
          interval: '5min',
          firstDate: '2025-07-01',
          lastDate: '2025-07-03',
          limit: 1000,
        },
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        clientCodeLicense: 'MIT',
        clientCodeLicenseAppliesToHostedMarketData: false,
        hostedDataRedistributionRightsGrantedByRepositoryLicense: false,
        commercialMarketDataUseRightsGrantedByRepositoryLicense: false,
        conclusion: (
          '官方 Skill 仓库明确说明 MIT 只覆盖代码和 Skill 实现，'
          + '不自动授予托管数据服务的访问额度、数据授权、再分发权或商业数据使用权。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-api-key-and-data-rights-unconfirmed',
        reason: (
          '正确的分钟接口支持具体合约 1/5/15/30/60 分钟 K 线，'
          + '但当前环境没有 FTSHARE_API_KEY，最小真实请求返回 HTTP 403，'
          + '无法确认十五个品种的目标缺口；官方仓库同时明确排除数据再分发和商业使用授权。'
        ),
      },
      retention: {
        rawResponsePersisted: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'pinned-official-skill-commit',
          url: (
            'https://github.com/FTShare-Lab/FTShare-skill/'
            + 'tree/f6840b1dbeaefebdac29c53479a9cd38c42a3459'
          ),
        },
        {
          type: 'official-futures-minutes-contract',
          url: (
            'https://github.com/FTShare-Lab/FTShare-skill/blob/'
            + 'f6840b1dbeaefebdac29c53479a9cd38c42a3459/'
            + 'ftshare-market-data/sub-skills/futures-minutes/SKILL.md'
          ),
        },
        {
          type: 'official-license-boundary',
          url: (
            'https://github.com/FTShare-Lab/FTShare-skill/blob/'
            + 'f6840b1dbeaefebdac29c53479a9cd38c42a3459/README.md#license'
          ),
        },
        {
          type: 'live-endpoint-metadata-probe',
          endpoint: (
            'https://market.ft.tech/gateway/'
            + 'api/v2/market/data/futures_minutes'
          ),
          reviewedOn,
          rawRowsPersisted: false,
        },
      ],
    },
    {
      sourceId: 'easyfut-tianqin-hosted-minute-api',
      sourceName: 'EasyFut/TianQin 托管分钟接口',
      accessAssessment: {
        skillRepositoryCommit: easyfutProbe.source.skillRepository.commit,
        endpoint: easyfutProbe.source.hostedService.baseUrl,
        specificContractOnly: true,
        documentedMaximumLength: (
          easyfutProbe.source.hostedService.documentedMaximumLength
        ),
        requestedContractCount: (
          easyfutProbe.batchResult.requestedContractCount
        ),
        successfulContractCount: (
          easyfutProbe.batchResult.successfulContractCount
        ),
        serverTimeoutCount: easyfutProbe.batchResult.serverTimeoutCount,
        serviceStabilityConfirmed: false,
        soybeanMealCalendarGapOverlapObserved: (
          easyfutProbe.coverage.soybeanMeal
            .combinedCalendarSpanCoversTargetGap
        ),
        soybeanMealTradingSessionCompletenessConfirmed: (
          easyfutProbe.coverage.soybeanMeal
            .tradingSessionCompletenessConfirmed
        ),
        allTargetInstrumentCoverageConfirmed: (
          easyfutProbe.coverage.allTargetInstrumentCoverageConfirmed
        ),
        targetGapCoverageConfirmed: (
          easyfutProbe.coverage.targetGapCoverageConfirmed
        ),
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        clientCodeLicense: easyfutProbe.source.clientRepository.license,
        clientCodeLicenseAppliesToHostedMarketData: (
          easyfutProbe.source.clientRepository
            .licenseAppliesToHostedMarketData
        ),
        skillRepositoryLicenseFound: (
          easyfutProbe.source.skillRepository.repositoryLicenseFound
        ),
        hostedDataTermsFound: (
          easyfutProbe.source.hostedService.hostedDataTermsFound
        ),
        upstreamMarketDataProvenanceDocumented: (
          easyfutProbe.source.hostedService
            .upstreamMarketDataProvenanceDocumented
        ),
        conclusion: (
          'EasyFut 客户端代码的 Apache-2.0 许可不覆盖托管接口返回的行情；'
          + 'Skill 仓库、运营方身份、上游来源和托管数据条款均不足以建立分发权利链。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: (
          easyfutProbe.rights
            .hostedMarketDataRedistributionPermissionConfirmed
        ),
        releaseEligibility: (
          easyfutProbe.releaseDecision.releaseEligibility
        ),
        reason: easyfutProbe.rights.reason,
      },
      retention: easyfutProbe.retention,
      evidence: [
        {
          type: 'local-summary-only-live-probe',
          path: 'data/easyfut-futures-minute-probe.json',
          reviewedOn: easyfutProbe.reviewedOn,
          rawRowsPersisted: easyfutProbe.retention.rawRowsPersisted,
        },
        {
          type: 'pinned-skill-repository-commit',
          url: (
            'https://github.com/PPsteven/skills/tree/'
            + `${easyfutProbe.source.skillRepository.commit}/tianqin-data`
          ),
        },
        {
          type: 'client-code-repository',
          url: easyfutProbe.source.clientRepository.url,
          license: easyfutProbe.source.clientRepository.license,
        },
      ],
    },
    {
      sourceId: 'tqsdk-history-download',
      sourceName: 'TqSdk 历史数据下载',
      accessAssessment: {
        minuteHistoryCapabilityDocumented: true,
        credentialOrPaidPermissionRequired: true,
        realGapProbePerformed: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-without-separate-written-authorization',
        reason: '专业版或试用账号的数据访问权限不等同于产品内静态行情再分发授权。',
      },
      evidence: [
        {
          type: 'official-download-documentation',
          url: 'https://doc.shinnytech.com/tqsdk/latest/reference/tqsdk.tools.download.html',
        },
        {
          type: 'official-market-data-documentation',
          url: 'https://doc.shinnytech.com/tqsdk/latest/usage/mddatas.html',
        },
      ],
    },
    {
      sourceId: 'rqdata-futures-minute',
      sourceName: 'RQData 期货分钟行情',
      accessAssessment: {
        minuteHistoryCapabilityDocumented: true,
        institutionalDataServiceDocumented: true,
        credentialOrPaidPermissionRequired: true,
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: false,
      },
      contact: {
        phone: '0755-22676337',
        email: 'bd@ricequant.com',
        page: 'https://www.ricequant.com/doc/rqdata-institution',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'awaiting-written-oem-redistribution-quote',
        reason: (
          '账号可查询历史分钟数据不代表允许把查询结果固化到本项目发布物中；'
          + '已列入企业 OEM/静态分发询价，但尚未取得书面合同。'
        ),
      },
      evidence: [
        {
          type: 'official-api-documentation',
          url: 'https://rqdatac2.readthedocs.io/en/latest/intro.html',
        },
        {
          type: 'official-institutional-data-service',
          url: 'https://www.ricequant.com/doc/rqdata-institution',
        },
      ],
    },
    {
      sourceId: 'itick-futures-kline-api',
      sourceName: 'iTick 期货历史 K 线接口',
      accessAssessment: {
        officialFuturesKlineApiDocumented: true,
        documentedIntervalsMinutes: [1, 5, 15, 30, 60],
        documentedEndTimestampParameter: true,
        tokenRequired: true,
        tokenPresent: false,
        realGapProbePerformed: true,
        probeStatus: 'blocked-missing-token',
        probeHttpStatus: 401,
        sampleRequest: {
          region: 'CN',
          code: 'M2509',
          kType: 2,
          limit: 5,
        },
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
      },
      licenseAssessment: {
        apiAccessTermsReviewed: false,
        returnedMarketDataRedistributionPermissionConfirmed: false,
        commercialStaticRedistributionPermissionConfirmed: false,
        conclusion: (
          '公开文档证明接口支持中国期货分钟 K 线和结束时间参数，'
          + '但当前环境没有 token，且接口文档本身不构成行情再分发授权。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-missing-token-and-data-rights-unconfirmed',
        reason: (
          '无 token 的真实请求返回 HTTP 401，尚未验证十五个品种及目标缺口；'
          + '也未取得允许写入 Git 并随商业 EXE/安装包分发返回行情的书面许可。'
        ),
      },
      retention: {
        rawResponsePersisted: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'official-futures-kline-documentation',
          url: 'https://docs.itick.org/en/rest-api/future/future-kline',
        },
        {
          type: 'official-futures-batch-kline-documentation',
          url: 'https://docs.itick.org/en/rest-api/future/future-klines',
        },
        {
          type: 'unauthenticated-live-endpoint-probe',
          endpoint: (
            'https://api.itick.org/future/kline'
            + '?region=CN&code=M2509&kType=2&limit=5'
          ),
          status: 401,
          reviewedOn,
          rawRowsPersisted: false,
        },
      ],
    },
    {
      sourceId: 'akshare-sina-rolling-window',
      sourceName: 'AKShare 封装与新浪期货分钟接口',
      accessAssessment: {
        minuteHistoryCapabilityDocumented: true,
        credentialOrPaidPermissionRequired: false,
        realGapProbePerformed: true,
        probe: sinaProbe,
        specificContractMatrix: {
          capturedAt: sinaContractProbe.capturedAt,
          targetInstrumentCount: sinaContractProbe.requestPlan.instrumentCount,
          requestedSymbolCount: sinaContractProbe.totals.requestedSymbolCount,
          nonEmptyResponseCount: sinaContractProbe.totals.nonEmptyResponseCount,
          gapOverlappingResponseCount: (
            sinaContractProbe.totals.gapOverlappingResponseCount
          ),
          czceFourDigitAndThreeDigitAliasesCompared: (
            sinaContractProbe.requestPlan.czceFourDigitAndThreeDigitAliasesCompared
          ),
          technicalGapCoverageConfirmed: (
            sinaContractProbe.releaseDecision.technicalGapCoverageConfirmed
          ),
          instrumentWindows: sinaContractProbe.instruments.map(instrument => ({
            instrumentId: instrument.instrumentId,
            displayName: instrument.displayName,
            firstObservedGapDate: instrument.firstObservedGapDate,
            lastObservedGapDate: instrument.lastObservedGapDate,
            observedGapTradingDateCount: instrument.observedGapTradingDateCount,
            technicalGapCompletenessConfirmed: (
              instrument.technicalGapCompletenessConfirmed
            ),
          })),
        },
        historicalPagingProbe: {
          sampleContract: 'M2509',
          dateAndPaginationArgumentsTested: true,
          argumentsChangedReturnedWindow: false,
          returnedRowsApproximately: 1023,
          legacyGetMinLineHistoryPagingConfirmed: false,
          conclusion: (
            '日期和分页参数没有突破相同的短滚动窗口；'
            + '旧 getMinLine 接口也未发现可复核的历史分页能力。'
          ),
        },
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-by-coverage-and-rights',
        reason: (
          'AKShare 代码许可不自动覆盖上游新浪行情；'
          + `主连实时探测只有 ${sinaRowCount ?? '未知数量'} 根滚动窗口。`
          + `具体合约矩阵虽取得 ${sinaContractProbe.totals.nonEmptyResponseCount} 个非空响应，`
          + '但各 1023 根左右的短窗口之间存在断档，日期和分页参数也未扩大窗口，'
          + '不能证明目标主连缺口完整，'
          + '且未取得随商业 EXE 再分发的书面授权。'
        ),
      },
      evidence: [
        {
          type: 'official-akshare-documentation',
          url: 'https://akshare.akfamily.xyz/data/futures/futures.html',
        },
        {
          type: 'live-endpoint-metadata-probe',
          endpoint: SINA_ENDPOINT,
        },
        {
          type: 'specific-contract-window-matrix-summary',
          path: 'data/sina-futures-minute-probe.json',
          capturedAt: sinaContractProbe.capturedAt,
          rawRowsPersisted: sinaContractProbe.retention.rawRowsPersisted,
        },
        {
          type: 'specific-contract-pagination-variant-summary',
          symbol: 'M2509',
          returnedRowsApproximately: 1023,
          reviewedOn,
          rawRowsPersisted: false,
        },
      ],
    },
    {
      sourceId: 'eastmoney-push2his-five-minute',
      sourceName: '东方财富 push2his 期货 5 分钟历史接口',
      accessAssessment: {
        publicEndpointProbePerformed: true,
        targetGapCoverageConfirmed: eastmoneyProbe.coverage.allTargetGapsCovered,
        realGapProbePerformed: true,
        probe: eastmoneyProbe,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-by-access-and-rights',
        reason: (
          `本次带浏览器标识和来源页的直接请求返回 HTTP ${
            eastmoneyProbe.response?.httpStatus ?? '未知状态'
          }，未取得目标缺口；`
          + '同时没有允许将该接口行情写入 Git 并随商业 EXE/安装包再分发的书面许可。'
        ),
      },
      evidence: [
        {
          type: 'live-endpoint-metadata-probe',
          endpoint: EASTMONEY_ENDPOINT,
          reviewedOn,
        },
      ],
    },
    {
      sourceId: 'pytdx-public-exhq',
      sourceName: 'pytdx 公共扩展行情服务器连续合约 5 分钟数据',
      accessAssessment: {
        publicEndpointProbePerformed: true,
        accountOrTokenRequiredByProbe: pytdxProbe.server.accountRequiredByProbe,
        targetInstrumentCount: pytdxProbe.coverage.targetInstrumentCount,
        targetGapCoverageConfirmed: (
          pytdxProbe.conclusion.targetGapAccessCapabilityConfirmed
        ),
        allTargetDateBoundsReached: pytdxProbe.coverage.allTargetDateBoundsReached,
        allRequiredFieldsComplete: pytdxProbe.coverage.allRequiredFieldsComplete,
        concreteContractAttributionAvailable: (
          pytdxProbe.coverage.continuousContractAttributionAvailable
        ),
        expiredSpecificContractHistoryAvailable: (
          pytdxProbe.coverage.expiredSpecificContractHistoryAvailable
        ),
        specificContractGapCapabilityConfirmed: (
          pytdxProbe.conclusion.specificContractGapCapabilityConfirmed
        ),
        historicalMainContractMappingCapabilityConfirmed: (
          pytdxProbe.conclusion.historicalMainContractMappingCapabilityConfirmed
        ),
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        clientCodeLicenseConfirmed: pytdxProbe.rights.clientCodeLicenseConfirmed,
        returnedMarketDataRedistributionPermissionConfirmed: (
          pytdxProbe.rights.returnedMarketDataRedistributionPermissionConfirmed
        ),
        codeLicenseAppliesToMarketData: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: (
          pytdxProbe.rights.returnedMarketDataRedistributionPermissionConfirmed
        ),
        releaseEligibility: 'blocked-no-contract-attribution-and-no-redistribution-rights',
        reason: (
          '真实探测确认十五个连续 L9 序列能够覆盖目标日期并返回完整 OHLC、成交量和持仓量，'
          + '但记录没有具体合约归属，已到期具体合约也不可查询，无法生成可审计的历史主力换月映射；'
          + '同时没有取得允许写入 Git 并随 EXE/安装包分发返回行情的书面授权。'
        ),
      },
      retention: pytdxProbe.retention,
      evidence: [
        {
          type: 'local-summary-only-live-probe',
          path: 'data/pytdx-public-exhq-probe.json',
          capturedAt: pytdxProbe.capturedAt,
          server: pytdxProbe.server,
        },
        {
          type: 'upstream-client-repository',
          url: pytdxProbe.environment.package.homePage,
        },
      ],
    },
    {
      sourceId: 'tonghuashun-local-client-export',
      sourceName: '本机同花顺期货通客户端与本地缓存',
      accessAssessment: {
        runningClientReviewed: tonghuashunProbe.uiReview.runningClientReviewed,
        databaseCount: tonghuashunProbe.databaseInventory.length,
        localHistoricalMinuteBarsFound: tonghuashunProbe.databaseInventory.some(
          database => database.historicalMinuteBarsFound,
        ),
        bulkHistoricalMinuteExportFound: (
          tonghuashunProbe.uiReview.documentedBulkHistoricalMinuteExportEntryFound
        ),
        targetGapCoverageConfirmed: (
          tonghuashunProbe.conclusion.targetGapCoverageConfirmed
        ),
        privateProtocolInspectionPerformed: (
          tonghuashunProbe.inspectionPolicy.privateProtocolReverseEngineeringPerformed
        ),
        privateTcpMarketPathObserved: (
          tonghuashunProbe.networkObservation.privateTcpMarketPathObserved
        ),
        publicHttpHistoricalKlineEndpointFound: (
          tonghuashunProbe.networkObservation.publicHttpHistoricalKlineEndpointFound
        ),
        observedRemotePorts: tonghuashunProbe.networkObservation.remotePorts,
        observedServiceHosts: tonghuashunProbe.networkObservation.serviceHosts,
        accessibilityExportOrHistoryControlFound: (
          tonghuashunProbe.uiReview.accessibilityExportOrHistoryControlFound
        ),
        nativeSdkProbePerformed: (
          tonghuashunProbe.inspectionPolicy.nativeSdkProbePerformed
        ),
        nativeSdkVersion: tonghuashunProbe.nativeSdkProbe.sdkVersion,
        nativeSdkAuthenticationSucceeded: (
          tonghuashunProbe.nativeSdkProbe.authenticationSucceeded
        ),
        nativeSdkSecurityDiscoverySucceeded: (
          tonghuashunProbe.nativeSdkProbe.securityDiscovery.succeeded
        ),
        nativeSdkHistoricalKlineRequestCount: (
          tonghuashunProbe.nativeSdkProbe.historicalKlineRequests.length
        ),
        nativeSdkSuccessfulHistoricalKlineRequestCount: (
          tonghuashunProbe.nativeSdkProbe.successfulHistoricalKlineRequestCount
        ),
        nativeSdkHistoricalKlineAccessConfirmed: (
          tonghuashunProbe.nativeSdkProbe.historicalKlineAccessConfirmed
        ),
        nativeSdkSessionFilePersistedAfterProbe: (
          tonghuashunProbe.nativeSdkProbe.sessionFilePersistedAfterProbe
        ),
        realGapProbePerformed: true,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: (
          tonghuashunProbe.conclusion.redistributionPermissionConfirmed
        ),
        releaseEligibility: tonghuashunProbe.conclusion.releaseEligibility,
        reason: tonghuashunProbe.conclusion.note,
      },
      retention: tonghuashunProbe.retention,
      evidence: [
        {
          type: 'local-summary-only-client-inspection',
          path: 'data/tonghuashun-local-export-probe.json',
          capturedOn: tonghuashunProbe.capturedOn,
          executable: tonghuashunProbe.application.executable,
          observationMethod: tonghuashunProbe.networkObservation.observationMethod,
          networkClassification: tonghuashunProbe.networkObservation.classification,
        },
        {
          type: 'local-summary-only-native-sdk-probe',
          path: 'data/tonghuashun-local-export-probe.json',
          startedAt: tonghuashunProbe.nativeSdkProbe.startedAt,
          completedAt: tonghuashunProbe.nativeSdkProbe.completedAt,
          sdkVersion: tonghuashunProbe.nativeSdkProbe.sdkVersion,
          authenticationSucceeded: (
            tonghuashunProbe.nativeSdkProbe.authenticationSucceeded
          ),
          historicalKlineRequests: (
            tonghuashunProbe.nativeSdkProbe.historicalKlineRequests
          ),
          retention: tonghuashunProbe.retention,
        },
      ],
    },
    {
      sourceId: 'local-myquant-main-continuous-one-minute',
      sourceName: '本机 MyQuant/gm.api 主连 1 分钟整理数据',
      accessAssessment: {
        localDatasetPresent: (
          myquantProbe.inventory.presentTargetInstrumentCount > 0
        ),
        seriesKind: myquantProbe.source.seriesKind,
        frequencyMinutes: myquantProbe.source.frequencyMinutes,
        specificContractAttributionAvailable: (
          myquantProbe.source.specificContractAttributionAvailable
        ),
        targetInstrumentCount: myquantProbe.inventory.targetInstrumentCount,
        presentTargetInstrumentCount: (
          myquantProbe.inventory.presentTargetInstrumentCount
        ),
        nonEmptyTargetInstrumentCount: (
          myquantProbe.inventory.nonEmptyTargetInstrumentCount
        ),
        firstTimestamp: myquantProbe.inventory.firstTimestamp,
        lastTimestamp: myquantProbe.inventory.lastTimestamp,
        targetGapOverlappingInstrumentCount: (
          myquantProbe.coverage.targetGapOverlappingInstrumentCount
        ),
        targetGapCoverageConfirmed: (
          myquantProbe.coverage.targetGapCoverageConfirmed
        ),
        documentedRecentNaturalDayLimit: (
          myquantProbe.source.observedAccountLimit.recentNaturalDays
        ),
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        accountDownloadPermissionObserved: (
          myquantProbe.rights.accountDownloadPermissionObserved
        ),
        accountDownloadPermissionGrantsRedistributionRights: (
          myquantProbe.rights
            .accountDownloadPermissionGrantsRedistributionRights
        ),
        writtenMarketDataRedistributionAuthorizationFound: (
          myquantProbe.rights
            .writtenMarketDataRedistributionAuthorizationFound
        ),
        conclusion: myquantProbe.rights.conclusion,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: (
          myquantProbe.releaseDecision.redistributionPermissionConfirmed
        ),
        releaseEligibility: (
          myquantProbe.releaseDecision.releaseEligibility
        ),
        reason: myquantProbe.releaseDecision.note,
      },
      retention: myquantProbe.retention,
      evidence: [
        {
          type: 'local-summary-only-dataset-inspection',
          path: 'data/myquant-local-minute-probe.json',
          capturedAt: myquantProbe.capturedAt,
          datasetDirectoryName: myquantProbe.source.datasetDirectoryName,
          coverageSummarySha256: (
            myquantProbe.source.documentation.coverageSummarySha256
          ),
        },
      ],
    },
    {
      sourceId: 'modelscope-ylzmota1-chinese-commodity-tick',
      sourceName: 'ModelScope ylzmota1/chinese-commodity 期货 Tick 数据集',
      accessAssessment: {
        datasetCommit: modelscopeProbe.source.commit,
        archiveTradingDays: modelscopeProbe.coverage.archiveTradingDays,
        firstArchiveTradingDate: modelscopeProbe.coverage.firstArchiveTradingDate,
        lastArchiveTradingDate: modelscopeProbe.coverage.lastArchiveTradingDate,
        targetInstrumentCount: modelscopeProbe.target.instrumentCount,
        targetGapCoverageConfirmed: (
          modelscopeProbe.releaseDecision.technicalGapCoverageConfirmed
        ),
        repositoryArchiveCount: (
          modelscopeProbe.source.repositoryInventory.archiveCount
        ),
        repositoryArchiveBytes: (
          modelscopeProbe.source.repositoryInventory.totalBytes
        ),
        repositoryFirstArchivePeriod: (
          modelscopeProbe.source.repositoryInventory.firstArchivePeriod
        ),
        repositoryLastArchivePeriod: (
          modelscopeProbe.source.repositoryInventory.lastArchivePeriod
        ),
        threeYearCoveragePotentialConfirmed: (
          modelscopeProbe.historicalStructure.threeYearCoveragePotentialConfirmed
        ),
        threeYearContinuousStructureConfirmed: (
          modelscopeProbe.historicalStructure.threeYearContinuousStructureConfirmed
        ),
        concreteContractAttributionAvailable: true,
        historicalMainContractMappingCapabilityConfirmed: (
          modelscopeProbe.coverage.allTargetGapsTechnicallyCovered
        ),
        boundedAggregationSamplePassed: (
          modelscopeProbe.releaseDecision.boundedAggregationSamplePassed
        ),
        boundedAggregationSampleInstrumentCount: (
          modelscopeProbe.sampleSuite.totals.instruments
        ),
        boundedAggregationSampleFileCount: (
          modelscopeProbe.sampleSuite.totals.files
        ),
        boundedAggregationSampleTradingDates: (
          modelscopeProbe.sampleSuite.requestedTradingDates
        ),
        boundedAggregationPassedInstrumentCount: (
          modelscopeProbe.sampleSuite.passedInstrumentCount
        ),
        boundedAggregationFiveMinuteBars: (
          modelscopeProbe.sampleSuite.totals.bars5
        ),
        boundedAggregationSixtyMinuteBars: (
          modelscopeProbe.sampleSuite.totals.bars60
        ),
        boundedAggregationReconciliationMismatches: (
          modelscopeProbe.sampleSuite.totals.fiveSixtyReconciliationMismatches
        ),
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        repositoryLicenseClaimPresent: (
          modelscopeProbe.rights.repositoryLicenseClaimPresent
        ),
        repositoryLicenseIdentifier: (
          modelscopeProbe.rights.repositoryLicenseIdentifier
        ),
        repositoryLicenseAppliesToFilesAsClaimedByCard: (
          modelscopeProbe.rights.repositoryLicenseAppliesToFilesAsClaimedByCard
        ),
        upstreamMarketDataProvenanceDocumented: (
          modelscopeProbe.rights.upstreamMarketDataProvenanceDocumented
        ),
        upstreamMarketDataRedistributionAuthorityDocumented: (
          modelscopeProbe.rights.upstreamMarketDataRedistributionAuthorityDocumented
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: (
          modelscopeProbe.releaseDecision.redistributionPermissionConfirmed
        ),
        releaseEligibility: 'blocked-upstream-provenance-and-redistribution-rights',
        reason: (
          '真实 Range 探测确认四个缺口归档可以完整覆盖十五个品种的目标缺口，'
          + '具体合约、每日主力映射、换月和 5/60 分钟聚合样本均通过技术校验；'
          + '仓库树和四个年度代表归档还确认了三年以上历史覆盖潜力；'
          + '但数据集卡只声明 Apache-2.0，未说明原始行情来源、取得方式或上游分发权利链，'
          + '因此不能把原始 Tick 或派生 K 线写入 Git、EXE 或安装包。'
        ),
      },
      retention: modelscopeProbe.retention,
      evidence: [
        {
          type: 'local-summary-only-range-probe',
          path: 'data/modelscope-tick-source-probe.json',
          capturedAt: modelscopeProbe.capturedAt,
          commit: modelscopeProbe.source.commit,
          normalizedDailyMappingSha256: (
            modelscopeProbe.coverage.normalizedDailyMappingSha256
          ),
          repositoryManifestSha256: (
            modelscopeProbe.source.repositoryInventory.normalizedManifestSha256
          ),
          representativePeriods: (
            modelscopeProbe.historicalStructure.representativePeriods
          ),
          sampleDerivedHashes: modelscopeProbe.sample.derivedHashes,
          sampleSuiteDerivedHashes: modelscopeProbe.sampleSuite.instruments.map(
            instrument => ({
              instrumentId: instrument.instrumentId,
              instrumentName: instrument.instrumentName,
              passed: instrument.passed,
              derivedHashes: instrument.derivedHashes,
            }),
          ),
        },
        {
          type: 'uploader-git-author-contact',
          account: modelscopeProbe.source.uploader.account,
          email: modelscopeProbe.source.uploader.email,
          commit: modelscopeProbe.source.uploader.evidenceCommit,
          commitSubject: modelscopeProbe.source.uploader.evidenceCommitSubject,
        },
        {
          type: 'dataset-card',
          url: modelscopeProbe.source.url,
          declaredLicense: (
            modelscopeProbe.source.datasetCard.declaredLicense
          ),
        },
      ],
    },
    {
      sourceId: 'modelscope-wzywuan-futures-kline-data',
      sourceName: 'ModelScope wzywuan/futures-kline-data',
      accessAssessment: {
        datasetId: 'wzywuan/futures-kline-data',
        description: '期货历史K线数据集',
        createdAt: '2026-01-06T16:09:19Z',
        lastModifiedAt: '2026-01-18T13:24:10Z',
        repositoryBytes: 197523731,
        downloadsAtReview: 2,
        visibility: 'gated',
        gatedMode: 'manual',
        loginRequired: true,
        fileTreeAccessStatus: 403,
        fileInventoryReviewed: false,
        documentedIntervals: [],
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        threeYearFiveMinuteCoverageConfirmed: false,
        threeYearSixtyMinuteCoverageConfirmed: false,
        realGapProbePerformed: false,
      },
      licenseAssessment: {
        datasetCardLicenseClaim: 'Apache License 2.0',
        datasetCardLicenseClaimPresent: true,
        upstreamMarketDataProvenanceDocumented: false,
        upstreamMarketDataRedistributionAuthorityDocumented: false,
        repositoryLicenseClaimSufficientForProductRedistribution: false,
        conclusion: (
          '公开元数据只声明 Apache License 2.0；数据集需登录并由作者手动审批，'
          + '文件清单、分钟周期、品种范围和上游行情权利链都无法在未授权状态下核验。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: (
          'awaiting-access-and-written-redistribution-authorization'
        ),
        reason: (
          '必须先取得数据集访问权限并检查实际文件，再由发布者书面确认 Git 存储、'
          + 'EXE/安装包交付、派生 5/60 分钟 K 线、商业使用及其上游再分发授权。'
        ),
      },
      retention: {
        rawResponsePersisted: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'official-modelscope-openapi-metadata',
          url: (
            'https://modelscope.cn/openapi/v1/datasets/'
            + 'wzywuan/futures-kline-data'
          ),
          reviewedOn,
        },
        {
          type: 'unauthorized-file-tree-probe',
          status: 403,
          reviewedOn,
        },
      ],
    },
    {
      sourceId: 'github-china-futures-5min-forks',
      sourceName: 'china-futures-5min-2015-2025 原仓库及公开 fork',
      accessAssessment: {
        repositoriesReviewed: [
          'Freddy-Hexas/china-futures-5min-2015-2025',
          'masaopin/china-futures-5min-2015-2025',
          'pandal0ve/china-futures-5min-2015-2025',
        ],
        originalHead: '1a402721d639432875504a343e2b9ffe9508cd36',
        forkHeads: {
          'masaopin/china-futures-5min-2015-2025': (
            '1a402721d639432875504a343e2b9ffe9508cd36'
          ),
          'pandal0ve/china-futures-5min-2015-2025': (
            '1a402721d639432875504a343e2b9ffe9508cd36'
          ),
        },
        latestDatasetDate: '2025-06-30',
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        repositoryLicenseIdentifier: 'CC0-1.0',
        repositoryLicenseClaimPresent: true,
        upstreamMarketDataProvenanceDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-no-new-gap-data-and-upstream-rights-unconfirmed',
        reason: (
          '两个公开 fork 的 HEAD 与原仓库完全相同，均未追加 2025-07-01 之后的数据，'
          + '因此不能补齐目标缺口；原始行情上游权利链也仍未说明。'
        ),
      },
      evidence: [
        {
          type: 'git-ls-remote-head-comparison',
          reviewedOn,
        },
        {
          type: 'local-public-source-audit',
          path: 'data/public-history-source-audit.json',
        },
      ],
    },
    {
      sourceId: 'github-tradingagents-for-futures-daily-data',
      sourceName: 'haoge10241024/TradingAgents_for_Futures 内置技术分析数据',
      accessAssessment: {
        repositoryReviewed: true,
        repositoryUrl: 'https://github.com/haoge10241024/TradingAgents_for_Futures',
        commit: '7eccff24ba128af4d9f4b88a7f68a03d1616a60c',
        targetInstrumentCount: 15,
        targetSymbols: [
          'A',
          'C',
          'FG',
          'M',
          'MA',
          'OI',
          'P',
          'PP',
          'RB',
          'RM',
          'SA',
          'SP',
          'SR',
          'V',
          'Y',
        ],
        allTargetDailyFilesPresent: true,
        committedDataGranularity: 'daily',
        committedMinuteDatasetPresent: false,
        soybeanMealDailyRows: 6156,
        soybeanMealFirstDate: '2000-07-18',
        soybeanMealLastDate: '2025-11-17',
        latestDailyDateMinAcrossTargets: '2025-11-14',
        updaterInterfaces: [
          'ak.futures_hist_em(period="daily")',
          'ak.futures_zh_daily_sina',
          'ak.get_futures_daily',
        ],
        targetGapCoverageConfirmed: false,
        threeYearFiveMinuteCoverageConfirmed: false,
        threeYearSixtyMinuteCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        codeLicense: 'MIT',
        codeLicenseAppliesToCommittedMarketData: false,
        upstreamMarketDataProvenanceDocumented: false,
        upstreamMarketDataRedistributionAuthorityDocumented: false,
        conclusion: (
          '仓库 MIT 许可覆盖软件代码；技术数据由 AKShare、新浪等日线接口生成，'
          + '仓库没有证明这些上游行情可以随商业产品再次分发。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-daily-only-and-upstream-rights-unconfirmed',
        reason: (
          '十五个目标品种都存在长区间 CSV，但内容是日线而非 5/60 分钟，'
          + '无法补齐当前分钟缺口；同时上游行情来源和再分发授权没有得到确认。'
        ),
      },
      retention: {
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/haoge10241024/TradingAgents_for_Futures/'
            + 'tree/7eccff24ba128af4d9f4b88a7f68a03d1616a60c'
          ),
        },
        {
          type: 'repository-license',
          url: (
            'https://github.com/haoge10241024/TradingAgents_for_Futures/'
            + 'blob/7eccff24ba128af4d9f4b88a7f68a03d1616a60c/LICENSE'
          ),
        },
        {
          type: 'daily-updater-implementation',
          url: (
            'https://github.com/haoge10241024/TradingAgents_for_Futures/'
            + 'blob/7eccff24ba128af4d9f4b88a7f68a03d1616a60c/'
            + 'modules/technical_updater.py'
          ),
        },
      ],
    },
    {
      sourceId: 'github-demondamon-rbhot-5m',
      sourceName: 'DemonDamon/futures-data-visualization-via-EChart 螺纹钢主连 5 分钟数据',
      accessAssessment: {
        repositoryReviewed: true,
        repositoryUrl: (
          'https://github.com/DemonDamon/'
          + 'futures-data-visualization-via-EChart'
        ),
        commit: '758766f266bf7e88f96a56af753ec077c2d2034b',
        committedDatasetPath: 'data/RBHot_5m.csv',
        committedDataGranularity: '5-minute',
        coveredSymbols: ['RB'],
        firstTimestamp: '2010-05-31',
        lastTimestamp: '2017-10-09',
        targetInstrumentCount: 15,
        coveredTargetInstrumentCount: 1,
        targetGapCoverageConfirmed: false,
        threeYearFiveMinuteCoverageConfirmedForAllTargets: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        repositoryLicenseFilePresent: false,
        codeLicenseConfirmed: false,
        datasetLicense: null,
        upstreamMarketDataProvenanceDocumented: false,
        upstreamMarketDataRedistributionAuthorityDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-stale-single-instrument-and-no-license',
        reason: (
          '仓库只提交了螺纹钢主连的旧 5 分钟文件，数据截止 2017-10-09，'
          + '既不覆盖十五个目标品种，也不能补齐 2025 年目标缺口；仓库还没有 LICENSE '
          + '或上游行情再分发依据。'
        ),
      },
      retention: {
        datasetCopiedIntoRepository: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/DemonDamon/'
            + 'futures-data-visualization-via-EChart/'
            + 'tree/758766f266bf7e88f96a56af753ec077c2d2034b'
          ),
        },
        {
          type: 'committed-dataset',
          url: (
            'https://github.com/DemonDamon/'
            + 'futures-data-visualization-via-EChart/'
            + 'blob/758766f266bf7e88f96a56af753ec077c2d2034b/'
            + 'data/RBHot_5m.csv'
          ),
        },
      ],
    },
    {
      sourceId: 'github-kevinsherry-cta-daily-data',
      sourceName: 'KevinSherry2016/CTA 日线合约截面数据',
      accessAssessment: {
        repositoryReviewed: true,
        repositoryUrl: 'https://github.com/KevinSherry2016/CTA',
        commit: '0e7a2b1496acdd1dfc9136f9f3b2a2f851d6a34b',
        approximateRepositoryBytes: 643_000_000,
        committedFileCount: 4222,
        sampleDatasetPath: 'daily_data/20250703.csv',
        committedDataGranularity: 'daily-contract-cross-section',
        committedMinuteDatasetPresent: false,
        targetGapCoverageConfirmed: false,
        threeYearFiveMinuteCoverageConfirmed: false,
        threeYearSixtyMinuteCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        repositoryLicenseFilePresent: false,
        codeLicenseConfirmed: false,
        datasetLicense: null,
        upstreamMarketDataProvenanceDocumented: false,
        upstreamMarketDataRedistributionAuthorityDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-daily-only-and-no-license',
        reason: (
          '仓库中的 daily_data 是按交易日保存的合约日线截面，不是 5/60 分钟 K 线，'
          + '无法补齐分钟缺口；仓库同时没有 LICENSE 或数据再分发授权说明。'
        ),
      },
      retention: {
        repositoryClonedIntoProject: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/KevinSherry2016/CTA/'
            + 'tree/0e7a2b1496acdd1dfc9136f9f3b2a2f851d6a34b'
          ),
        },
        {
          type: 'daily-contract-cross-section-sample',
          url: (
            'https://github.com/KevinSherry2016/CTA/'
            + 'blob/0e7a2b1496acdd1dfc9136f9f3b2a2f851d6a34b/'
            + 'daily_data/20250703.csv'
          ),
        },
      ],
    },
    {
      sourceId: 'github-quantiger-tdx-futures-data',
      sourceName: 'quantiger/tdx-futures-data 通达信抓取工具',
      accessAssessment: {
        repositoryReviewed: true,
        commit: '0fd59eb9ce1aa32fee7da099a348799edd65bd19',
        committedFileCount: 32,
        committedMarketDataFilesPresent: false,
        localTdxQuantApiRequired: true,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        readmeLicenseClaim: 'MIT',
        repositoryLicenseFilePresent: false,
        codeLicenseConfirmed: false,
        returnedMarketDataRedistributionPermissionConfirmed: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-tool-only-no-data-license',
        reason: (
          '仓库只有抓取代码和配置，没有提交行情文件；README 的 MIT 描述没有对应 LICENSE 文件，'
          + '即使代码许可后续确认，也不会自动授予本地通达信接口返回行情的再分发权。'
        ),
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/quantiger/tdx-futures-data/'
            + 'tree/0fd59eb9ce1aa32fee7da099a348799edd65bd19'
          ),
        },
      ],
    },
    {
      sourceId: 'github-irontowersh-future-highfreq',
      sourceName: 'irontowersh/future_highFreq',
      accessAssessment: {
        repositoryReviewed: true,
        repositoryUrl: 'https://github.com/irontowersh/future_highFreq',
        commit: 'd30d57fbab55ca56c95a50ac6c34de305aaa49dc',
        lastCommitAt: '2019-11-02T13:45:21+08:00',
        packagedExecutableOnly: true,
        sourceCodePresent: false,
        executable: {
          path: 'future_highFreq.exe',
          bytes: 726016,
          sha256: (
            '206526857432189E04F319BD3036D7DF84DB0D52417EEF93C42DB653FAE54374'
          ),
        },
        serverConnectedAccordingToReadme: false,
        claimedDataSources: ['天软科技', '掘金量化 3'],
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        repositoryLicenseFilePresent: false,
        codeLicenseConfirmed: false,
        upstreamRedistributionAuthorityDocumented: false,
        returnedMarketDataRedistributionPermissionConfirmed: false,
        conclusion: (
          '仓库没有 LICENSE，也没有源代码；README 对天软和掘金的来源说明'
          + '没有提供允许第三方再次分发行情的上游授权。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-disconnected-binary-and-no-license',
        reason: (
          'README 明确写明服务器端尚未接入，仓库也自 2019 年停止更新，'
          + '既不能补齐 2025 年目标缺口，也没有可用于产品发布的数据权利链。'
        ),
      },
      retention: {
        executableCopiedIntoRepository: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/irontowersh/future_highFreq/'
            + 'tree/d30d57fbab55ca56c95a50ac6c34de305aaa49dc'
          ),
        },
        {
          type: 'temporary-local-binary-metadata',
          path: (
            'C:\\Windows\\Temp\\MoneyComing-gap-source-probe'
            + '\\future_highFreq\\future_highFreq.exe'
          ),
          rawRowsPersisted: false,
        },
      ],
    },
    {
      sourceId: 'github-putt-futures-collect',
      sourceName: 'putt/futures-collect',
      accessAssessment: {
        repositoryReviewed: true,
        repositoryUrl: 'https://github.com/putt/futures-collect',
        commit: 'e89700eb7d92e309d866e7ef70a723a7c6664ec9',
        collectionEndpoint: (
          'InnerFuturesNewService.getFewMinLine'
        ),
        committedDatabase: {
          path: 'futures.db3',
          bytes: 2646016,
          sha256: (
            '0D11E2B05F145BB1AD76C3C710D2F1BD4B18EF8FEA2B051489537DC4E17D736A'
          ),
          tableCount: 43,
          rowCount: 27527,
          firstTimestamp: '2019-07-10 10:00:00',
          lastTimestamp: '2019-08-15 00:45:00',
        },
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        codeLicense: 'MIT',
        codeLicenseAppliesToCommittedMarketData: false,
        upstreamMarketDataProvider: '新浪',
        upstreamRedistributionAuthorityDocumented: false,
        returnedMarketDataRedistributionPermissionConfirmed: false,
        conclusion: (
          'MIT 许可可以覆盖仓库代码，但不会自动覆盖内置 SQLite 中的新浪行情；'
          + '仓库没有提供新浪允许再分发该数据库的证明。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-stale-data-and-upstream-rights-unconfirmed',
        reason: (
          '内置数据库只覆盖 2019-07-10 至 2019-08-15，'
          + '完全不覆盖 2025 年目标缺口；上游行情再分发权也未确认。'
        ),
      },
      retention: {
        databaseCopiedIntoRepository: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/putt/futures-collect/'
            + 'tree/e89700eb7d92e309d866e7ef70a723a7c6664ec9'
          ),
        },
        {
          type: 'temporary-local-database-metadata',
          path: (
            'C:\\Windows\\Temp\\MoneyComing-gap-source-probe'
            + '\\futures-collect\\futures.db3'
          ),
          rawRowsPersisted: false,
        },
      ],
    },
    {
      sourceId: 'github-bobbyshiyi-cnfutures',
      sourceName: 'BobbyShiyi/cnfutures',
      accessAssessment: {
        repositoryReviewed: true,
        repositoryUrl: 'https://github.com/BobbyShiyi/cnfutures',
        commit: '8a45a117008f1495070ef6e0b56bd321c809d761',
        lastCommitAt: '2026-08-07T15:47:43+08:00',
        documentedSourceFrequency: 'Level-2 快照聚合为 1 分钟',
        documentedEvaluationSpanMonths: 18,
        committedMarketDataPresent: false,
        committedCachePresent: false,
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        codeLicense: 'MIT',
        codeLicenseAppliesToMarketData: false,
        marketDataOwnership: 'proprietary',
        marketDataProvider: 'Turing Private Equity Fund Management (Hainan)',
        upstreamRedistributionAuthorityDocumented: false,
        returnedMarketDataRedistributionPermissionConfirmed: false,
        conclusion: (
          'MIT 只覆盖研究代码；README 明确写明购买的 Level-2 行情属于专有数据，'
          + '未包含在仓库中，也没有向第三方授予再分发权。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-code-only-proprietary-data-not-included',
        reason: (
          '仓库没有可拉取的行情文件，只有需要外部原始 L2 CSV 的聚合代码；'
          + '因此既不能补齐目标缺口，也不能据其 MIT 许可证分发机构购买的行情。'
        ),
      },
      retention: {
        proprietaryMarketDataDownloaded: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/BobbyShiyi/cnfutures/'
            + 'tree/8a45a117008f1495070ef6e0b56bd321c809d761'
          ),
        },
        {
          type: 'repository-readme-proprietary-data-notice',
          url: (
            'https://github.com/BobbyShiyi/cnfutures/blob/'
            + '8a45a117008f1495070ef6e0b56bd321c809d761/README.md'
          ),
        },
      ],
    },
    {
      sourceId: 'kaggle-wentinglu-highfrequency-futures-data-china',
      sourceName: 'Kaggle wentinglu/highfrequency-futures-data-china',
      accessAssessment: {
        datasetVersion: kaggleProbe.source.currentVersionNumber,
        datasetLastUpdated: kaggleProbe.source.lastUpdated,
        datasetFileCount: kaggleProbe.source.fileCount,
        targetInstrumentCount: kaggleProbe.target.instrumentCount,
        allTargetFilesPresent: kaggleProbe.target.allTargetFilesPresent,
        sampleFile: kaggleProbe.sample.file,
        sampleRows: kaggleProbe.sample.rowCount,
        sampleFirstTimestamp: kaggleProbe.sample.minimumTimestamp,
        sampleLastTimestamp: kaggleProbe.sample.maximumTimestamp,
        normalizedPriceScaleObserved: (
          kaggleProbe.sample.normalizedPriceScaleObserved
        ),
        absolutePriceScaleAvailable: (
          kaggleProbe.coverage.absolutePriceScaleAvailable
        ),
        concreteContractAttributionAvailable: (
          kaggleProbe.coverage.concreteContractAttributionAvailable
        ),
        historicalMainContractMappingCapabilityConfirmed: (
          kaggleProbe.coverage.historicalMainContractMappingCapabilityConfirmed
        ),
        targetGapCoverageConfirmed: (
          kaggleProbe.coverage.targetGapCoverageConfirmed
        ),
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        datasetLicense: kaggleProbe.rights.datasetLicenseIdentifier,
        datasetLicenseClaimPresent: (
          kaggleProbe.rights.datasetLicenseClaimPresent
        ),
        upstreamMarketDataProviderDocumented: (
          kaggleProbe.rights.upstreamMarketDataProviderDocumented
        ),
        upstreamRedistributionAuthorityDocumented: (
          kaggleProbe.rights.upstreamRedistributionAuthorityDocumented
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: kaggleProbe.conclusion.releaseEligibility,
        reason: kaggleProbe.conclusion.note,
      },
      retention: kaggleProbe.retention,
      evidence: [
        {
          type: 'local-summary-only-live-probe',
          path: 'data/kaggle-high-frequency-futures-data-china-probe.json',
          capturedAt: kaggleProbe.capturedAt,
          datasetRef: kaggleProbe.source.datasetRef,
          datasetVersion: kaggleProbe.source.currentVersionNumber,
          normalizedManifestSha256: (
            kaggleProbe.source.normalizedManifestSha256
          ),
          sampleArchiveSha256: kaggleProbe.sample.download.sha256,
          sampleCsvSha256: kaggleProbe.sample.rawCsvSha256,
        },
        {
          type: 'dataset-page',
          url: `https://www.kaggle.com/datasets/${kaggleProbe.source.datasetRef}`,
          declaredLicense: kaggleProbe.source.declaredLicense,
        },
      ],
    },
    {
      sourceId: 'huggingface-edisonfu2025-domestic-futures-ticks',
      sourceName: 'Hugging Face EdisonFU2025/Domestic_Futures_ticks',
      accessAssessment: {
        datasetCommit: huggingfaceProbe.source.commit,
        targetInstrumentCount: huggingfaceProbe.target.instrumentCount,
        presentInstrumentCount: huggingfaceProbe.target.presentInstrumentCount,
        allTargetFilesPresent: huggingfaceProbe.target.allTargetFilesPresent,
        missingSymbols: huggingfaceProbe.target.missingSymbols,
        sampleFile: huggingfaceProbe.sample.file,
        sampleRows: huggingfaceProbe.sample.rowCount,
        sampleFirstTimestamp: huggingfaceProbe.sample.minimumTimestamp,
        sampleLastTimestamp: huggingfaceProbe.sample.maximumTimestamp,
        concreteContractAttributionAvailable: (
          huggingfaceProbe.coverage.concreteContractAttributionAvailable
        ),
        historicalMainContractMappingCapabilityConfirmed: (
          huggingfaceProbe.coverage.historicalMainContractMappingCapabilityConfirmed
        ),
        targetGapCoverageConfirmed: (
          huggingfaceProbe.coverage.allTargetGapCoverageConfirmed
        ),
        threeYearHistoryConfirmed: (
          huggingfaceProbe.coverage.threeYearHistoryConfirmed
        ),
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        datasetLicense: huggingfaceProbe.rights.datasetLicenseIdentifier,
        datasetLicenseClaimPresent: (
          huggingfaceProbe.rights.datasetLicenseClaimPresent
        ),
        upstreamMarketDataProviderDocumented: (
          huggingfaceProbe.rights.upstreamMarketDataProviderDocumented
        ),
        upstreamRedistributionAuthorityDocumented: (
          huggingfaceProbe.rights.upstreamRedistributionAuthorityDocumented
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: (
          huggingfaceProbe.conclusion.redistributionPermissionConfirmed
        ),
        releaseEligibility: huggingfaceProbe.conclusion.releaseEligibility,
        reason: huggingfaceProbe.conclusion.note,
      },
      retention: huggingfaceProbe.retention,
      evidence: [
        {
          type: 'local-summary-only-live-probe',
          path: 'data/huggingface-domestic-futures-ticks-probe.json',
          capturedAt: huggingfaceProbe.capturedAt,
          datasetId: huggingfaceProbe.source.datasetId,
          commit: huggingfaceProbe.source.commit,
          normalizedManifestSha256: (
            huggingfaceProbe.source.normalizedManifestSha256
          ),
          sampleSha256: huggingfaceProbe.sample.download.sha256,
        },
        {
          type: 'dataset-page',
          url: huggingfaceProbe.source.url,
          declaredLicense: huggingfaceProbe.source.declaredLicense,
        },
      ],
    },
    {
      sourceId: 'huggingface-shanehans-cn-commodity-level1-hist',
      sourceName: 'Hugging Face shanehans/cn_commodity_level1_hist',
      accessAssessment: {
        datasetReviewed: true,
        commit: 'b461ae494b9bfd7eb0f575c8ddb47e667d7db74f',
        archives: ['2023.zip'],
        documentedYearCoverage: [2023],
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        datasetCardLicense: 'MIT',
        upstreamMarketDataProvenanceDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-no-target-gap-and-upstream-rights-unconfirmed',
        reason: (
          '仓库只提供 2023.zip，不能覆盖 2025 年目标缺口；数据集卡也未说明原始 Level1 '
          + '行情提供方及上传者取得的再分发权。'
        ),
      },
      evidence: [
        {
          type: 'dataset-api-inventory',
          url: 'https://huggingface.co/datasets/shanehans/cn_commodity_level1_hist',
          reviewedOn,
        },
      ],
    },
    {
      sourceId: 'zenodo-15726389-chinese-commodity-high-frequency',
      sourceName: 'Zenodo 15726389 中国商品期货高频数据',
      accessAssessment: {
        recordReviewed: true,
        coveredFirstDate: '2022-08-01',
        coveredLastDate: '2023-08-01',
        parquetBytes: 171359171,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: true,
      },
      licenseAssessment: {
        recordLicense: 'CC-BY-4.0',
        recordLicenseClaimPresent: true,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-no-target-gap',
        reason: '记录具有明确 CC BY 4.0 声明，但只覆盖 2022-08-01 至 2023-08-01，无法补齐 2025 年缺口。',
      },
      evidence: [
        {
          type: 'zenodo-record',
          url: 'https://zenodo.org/records/15726389',
          reviewedOn,
        },
      ],
    },
    {
      sourceId: 'official-exchange-history',
      sourceName: '大商所、郑商所、上期所官方历史数据',
      accessAssessment: {
        publicHistoryPagesReviewed: true,
        targetGapContractFiveMinuteArchiveConfirmed: false,
        realGapProbePerformed: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-no-confirmed-five-minute-gap-archive',
        reason: '未确认官方公开档案同时覆盖目标 5 分钟缺口并明确允许随当前产品再分发。',
      },
      evidence: [
        { type: 'official-exchange-site', url: 'https://www.dce.com.cn/' },
        { type: 'official-exchange-site', url: 'https://www.czce.com.cn/' },
        { type: 'official-exchange-site', url: 'https://www.shfe.com.cn/' },
      ],
    },
    {
      sourceId: 'github-chenzhuanxin-china-futures-data-terminal',
      sourceName: 'chenzhuanxin/china-futures-data-terminal',
      accessAssessment: {
        repositoryReviewed: true,
        repositoryUrl: 'https://github.com/chenzhuanxin/china-futures-data-terminal',
        commit: '5832bbefaf5d6f57d816df365de8d899da2fa2ce',
        committedMinuteDatasetPresent: false,
        committedDailyJsonFiles: 254,
        committedDataApproximateBytes: 42 * 1024 * 1024,
        minuteAccessMode: '运行时调用新浪 getFewMinLine 短滚动窗口',
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: false,
      },
      licenseAssessment: {
        codeLicense: 'MIT',
        codeLicenseAppliesToMarketData: false,
        datasetLicense: 'not-commercially-redistributable',
        conclusion: (
          '代码采用 MIT；仓库附加说明把行情版权归于东方财富、新浪，'
          + '并将数据限定为学习研究用途，不能据此用于商业产品再分发。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-no-minute-dataset-and-no-commercial-rights',
        reason: '仓库内只有日线 JSON；分钟数据依赖短滚动接口，既不覆盖目标缺口，也没有商业再分发权。',
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/chenzhuanxin/china-futures-data-terminal/'
            + 'tree/5832bbefaf5d6f57d816df365de8d899da2fa2ce'
          ),
        },
        {
          type: 'repository-license-and-rights-notice',
          url: (
            'https://github.com/chenzhuanxin/china-futures-data-terminal/'
            + 'blob/5832bbefaf5d6f57d816df365de8d899da2fa2ce/LICENSE'
          ),
        },
      ],
    },
    {
      sourceId: 'github-feimax2026-china-futures-data',
      sourceName: 'feimax2026/china-futures-data',
      accessAssessment: {
        repositoryReviewed: true,
        repositoryUrl: 'https://github.com/feimax2026/china-futures-data',
        commit: 'd3e3a9ee423101ecf6e2860b4c48dabe4202cac4',
        committedMinuteDatasetPresent: false,
        committedDataDirectoryPresent: false,
        implementedHistoryMode: 'AKShare/Sina 日线',
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: false,
      },
      licenseAssessment: {
        codeLicense: null,
        codeLicenseConfirmed: false,
        datasetLicense: null,
        datasetRedistributionPermissionConfirmed: false,
        conclusion: '仓库没有 LICENSE，也没有提交可审计的数据文件或分钟历史。',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-no-license-no-minute-dataset',
        reason: '缺少代码和数据许可，且仓库不包含可覆盖目标缺口的分钟数据。',
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/feimax2026/china-futures-data/'
            + 'tree/d3e3a9ee423101ecf6e2860b4c48dabe4202cac4'
          ),
        },
      ],
    },
    {
      sourceId: 'github-farfromexact-china-commodities-engine',
      sourceName: 'farfromexact/China-Commodities-Engine',
      accessAssessment: {
        repositoryReviewed: true,
        repositoryUrl: 'https://github.com/farfromexact/China-Commodities-Engine',
        commit: 'af640f11ff3f55c2aef82b11f3203147010a2c7f',
        committedMinuteDatasetPresent: false,
        documentedHistoryScope: '日终数据和夜盘快照',
        minuteTickOrOrderBookHistoryExplicitlyOutOfScope: true,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: false,
      },
      licenseAssessment: {
        codeLicense: null,
        codeLicenseConfirmed: false,
        datasetLicense: null,
        datasetRedistributionPermissionConfirmed: false,
        conclusion: '仓库没有 LICENSE；README 所述范围也不包含分钟历史。',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-out-of-scope-and-unlicensed',
        reason: '该项目明确不建设分钟、逐笔或盘口历史，无法补齐目标缺口，且没有可用许可。',
      },
      evidence: [
        {
          type: 'pinned-repository-commit',
          url: (
            'https://github.com/farfromexact/China-Commodities-Engine/'
            + 'tree/af640f11ff3f55c2aef82b11f3203147010a2c7f'
          ),
        },
        {
          type: 'repository-readme',
          url: (
            'https://github.com/farfromexact/China-Commodities-Engine/'
            + 'blob/af640f11ff3f55c2aef82b11f3203147010a2c7f/README.md'
          ),
        },
      ],
    },
    {
      sourceId: 'wstock-static-futures-minute-data',
      sourceName: 'WSTOCK 国内期货分钟历史数据',
      accessAssessment: {
        providerPageReviewed: true,
        advertisedHistoryStartYear: 2003,
        advertisedIntervalsMinutes: [1, 5, 15, 30, 60, 120],
        advertisedSpecificContracts: true,
        advertisedContinuousContracts: true,
        advertisedFormats: [
          'CSV',
          'TXT',
          'Excel',
          '数据库',
          '同花顺',
          '通达信',
        ],
        targetInstrumentCoverageClaimed: true,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: false,
      },
      licenseAssessment: {
        publicTermsReviewed: true,
        selfUseOnly: true,
        redistributionExplicitlyProhibited: true,
        commercialStaticRedistributionPermissionConfirmed: false,
        conclusion: (
          '公开使用条款写明从该站取得的数据和服务仅能自用，'
          + '不得以任何形式传播，因此普通购买不能用于 MoneyComing 数据发布。'
        ),
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-public-terms-prohibit-redistribution',
        reason: (
          '供应商宣传的年份、周期、品种和格式在技术上可能满足需求，'
          + '但公开条款直接禁止传播；除非另行取得覆盖 Git、EXE、安装包和商业使用的书面授权。'
        ),
      },
      retention: {
        sampleDownloaded: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'provider-futures-product-page',
          url: 'https://www.wstock.net/wstock/futures.htm',
          reviewedOn,
        },
        {
          type: 'provider-terms-prohibiting-redistribution',
          url: 'https://www.wstock.net/wstock/terms.htm',
          reviewedOn,
        },
      ],
    },
    {
      sourceId: 'wikitter-static-minute-data',
      sourceName: 'Wikitter 商品期货合约 K 线分钟数据',
      accessAssessment: {
        providerPageReviewed: true,
        advertisedMinuteIntervals: [1, 3, 5, 10, 15, 30, 60],
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        sampleStatus: '商品期货页面列出的样本链接在审计时返回 404',
        sampleReviewedOn: reviewedOn,
        realGapProbePerformed: false,
      },
      contact: {
        qq: '365815656',
        wechat: '365815656',
        email: 'wikitter@foxmail.com',
        page: 'https://wikitter.com/contact',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'awaiting-written-quote-and-authorization',
        reason: '销售页面证明存在分钟数据产品，但未公开允许写入 Git 或随商业 EXE/安装包再分发。',
      },
      evidence: [
        {
          type: 'provider-product-page',
          url: (
            'https://wikitter.com/data/'
            + '%E6%9C%9F%E8%B4%A7%E5%95%86%E5%93%81%E5%90%88%E7%BA%A6K%E7%BA%BF'
            + '%E5%88%86%E9%92%9F%E6%95%B0%E6%8D%AE.html'
          ),
        },
        {
          type: 'provider-contact-page',
          url: 'https://wikitter.com/contact',
        },
      ],
    },
    {
      sourceId: 'caifutong-static-minute-data',
      sourceName: '财富通期货分钟数据',
      accessAssessment: {
        providerPageReviewed: true,
        advertisedMainContinuousData: true,
        advertisedContractFiveMinuteData: true,
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        sampleStatus: '已发现的 5 分钟样本只覆盖 2018 年 11 月的部分区间',
        sampleReviewedOn: reviewedOn,
        realGapProbePerformed: false,
      },
      contact: {
        phone: '15927130262',
        qq: '1702516511',
        page: 'http://www.qiquanshuju.com/html/lxwm/',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'awaiting-written-quote-and-authorization',
        reason: '产品页展示分钟数据能力，但目标十五品种、目标缺口和再分发权都尚未获得书面确认。',
      },
      evidence: [
        {
          type: 'provider-product-page',
          url: 'http://www.qiquanshuju.com/html/5/607.html',
        },
        {
          type: 'provider-contact-page',
          url: 'http://www.qiquanshuju.com/html/lxwm/',
        },
      ],
    },
    {
      sourceId: 'cmes-static-minute-data',
      sourceName: 'CMES 国内期货分钟数据',
      accessAssessment: {
        providerPageReviewed: true,
        advertisedHistoryStartYear: 2005,
        advertisedUpdatedToCurrent: true,
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        sampleStatus: '未取得覆盖目标缺口的可验证样本',
        sampleReviewedOn: reviewedOn,
        realGapProbePerformed: false,
      },
      contact: {
        qq: '3646144134',
        page: 'https://www.cmes.org/qihuoxinwen/1332.html',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'awaiting-written-quote-and-authorization',
        reason: '供应商页面宣称有长期分钟数据，但未确认目标品种字段、实际缺口覆盖和产品再分发许可。',
      },
      evidence: [
        {
          type: 'provider-product-page',
          url: 'https://www.cmes.org/qihuoxinwen/1332.html',
        },
        {
          type: 'provider-contact-page',
          url: 'https://www.cmes.org/qhgs/1411.html',
        },
      ],
    },
    {
      sourceId: 'csmar-futures-high-frequency-data',
      sourceName: 'CSMAR 中国商品期货高频数据',
      accessAssessment: {
        providerPageReviewed: true,
        commodityFuturesDataAdvertised: true,
        customizedDataServiceAdvertised: true,
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        sampleStatus: '需通过产品咨询确认分钟频率、字段、覆盖范围和交付格式',
        sampleReviewedOn: reviewedOn,
        realGapProbePerformed: false,
      },
      contact: {
        phone: '400-639-8883',
        email: 'service@csmar.com',
        page: 'https://www.csmar.com/channels/31.html',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        standardDatabaseLicenseAllowsThirdPartyTransfer: false,
        releaseEligibility: (
          'awaiting-separate-oem-license-standard-license-prohibits-transfer'
        ),
        reason: (
          '官方产品包含商品期货和定制数据服务，但官方数据库使用说明将普通许可'
          + '限定为注册用户内部使用并禁止向第三方转移、出售或公开；'
          + '只能另行商谈明确覆盖 MoneyComing 离线分发的 OEM 合同。'
        ),
      },
      evidence: [
        {
          type: 'official-provider-product-page',
          url: 'https://www.csmar.com/channels/31.html',
        },
        {
          type: 'official-provider-financial-data-service',
          url: (
            'https://csmar.com/channels/'
            + '%E9%87%91%E8%9E%8D%E6%95%B0%E6%8D%AE%E6%9C%8D%E5%8A%A1.html'
          ),
        },
        {
          type: 'official-database-user-guide-license-notice',
          url: 'https://rs.csmar.com/',
        },
      ],
    },
    {
      sourceId: 'wenhua-historical-data-service',
      sourceName: '文华财经历史数据服务',
      accessAssessment: {
        officialHistoricalDataServiceDocumented: true,
        domesticFuturesHistoryFromListingAdvertised: true,
        documentedNativeOneMinuteBars: true,
        documentedTickData: true,
        documentedApiAccess: true,
        specificContractCoverageConfirmed: false,
        openInterestFieldConfirmed: false,
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: false,
      },
      contact: {
        phone: '400-811-3366',
        page: 'https://www.wenhua.com.cn/guide/lssj.htm',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'awaiting-written-oem-redistribution-quote',
        reason: (
          '官方历史数据服务证明具备长期国内期货 K 线、Tick 和 API 能力，'
          + '但普通购买或单机 API 访问没有公开授予 Git 存储、'
          + '派生 K 线再分发及随 EXE/安装包离线交付权。'
        ),
      },
      retention: {
        sampleDownloaded: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'official-historical-data-service',
          url: 'https://www.wenhua.com.cn/guide/lssj.htm',
          reviewedOn,
        },
      ],
    },
    {
      sourceId: 'wind-client-api-futures-intraday',
      sourceName: 'Wind Client API 期货高频历史数据',
      accessAssessment: {
        officialClientApiDocumented: true,
        highFrequencyHistoricalDataAdvertised: true,
        futuresCoverageAdvertised: true,
        specificContractCoverageConfirmed: false,
        openInterestFieldConfirmed: false,
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: false,
      },
      contact: {
        phone: '400-820-9463',
        email: 'Service@wind.com.cn',
        page: 'https://www.wind.com.cn/portal/zh/WDS/ClientApi.html',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'awaiting-written-oem-redistribution-quote',
        reason: (
          'Client API 的查询和研究能力不等同于把历史分钟数据固化进第三方桌面软件；'
          + '尚需 Wind 与相关交易所权利链共同覆盖静态离线再分发。'
        ),
      },
      retention: {
        sampleDownloaded: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'official-client-api-product-page',
          url: 'https://www.wind.com.cn/portal/zh/WDS/ClientApi.html',
          reviewedOn,
        },
        {
          type: 'official-contact-page',
          url: 'https://www.wind.com.cn/portal/zh/WDS/ContactUs.html',
          reviewedOn,
        },
      ],
    },
    {
      sourceId: 'ifind-enterprise-data-interface',
      sourceName: '同花顺 iFinD 企业数据接口',
      accessAssessment: {
        officialDataInterfaceDocumented: true,
        futuresIntradayDataAdvertised: true,
        specificContractCoverageConfirmed: false,
        openInterestFieldConfirmed: false,
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
        realGapProbePerformed: false,
      },
      contact: {
        phone: '952555',
        page: 'https://quantapi.51ifind.com/',
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'awaiting-written-oem-redistribution-quote',
        reason: (
          'iFinD 企业数据接口是合法商务路径，但 API 访问或终端订阅本身未公开允许'
          + '将返回行情写入 Git 并作为 MoneyComing 离线资源再分发。'
        ),
      },
      retention: {
        sampleDownloaded: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      evidence: [
        {
          type: 'official-data-interface-documentation',
          url: 'https://quantapi.51ifind.com/',
          reviewedOn,
        },
        {
          type: 'official-service-contact',
          url: 'https://ft.10jqka.com.cn/ifindpc/',
          reviewedOn,
        },
      ],
    },
    {
      sourceId: 'one-time-written-static-data-license',
      sourceName: '一次性书面静态数据授权',
      accessAssessment: {
        capableOfCoveringTargetGap: true,
        authorizationObtained: false,
        realGapProbePerformed: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'eligible-only-after-written-authorization',
        reason: '需要授权方明确覆盖目标合约、时间区间、Git 存储和 EXE/安装包再分发后才能进入候选基线。',
      },
      evidence: [],
    },
  ];
}

const options = parseArguments(process.argv.slice(2));
const [
  pytdxProbe,
  modelscopeProbe,
  kaggleProbe,
  huggingfaceProbe,
  tushareProbe,
  tonghuashunProbe,
  myquantProbe,
  easyfutProbe,
  sinaContractProbe,
] = await Promise.all([
  readJson(PYTDX_PROBE_PATH),
  readJson(MODELSCOPE_PROBE_PATH),
  readJson(KAGGLE_PROBE_PATH),
  readJson(HUGGINGFACE_PROBE_PATH),
  readJson(TUSHARE_PROBE_PATH),
  readJson(TONGHUASHUN_PROBE_PATH),
  readJson(MYQUANT_PROBE_PATH),
  readJson(EASYFUT_PROBE_PATH),
  readJson(SINA_CONTRACT_PROBE_PATH),
]);
if (pytdxProbe.purpose !== 'pytdx-public-exhq-five-minute-history-probe') {
  throw new Error('pytdx 公共扩展行情探测报告类型不符合预期');
}
if (modelscopeProbe.purpose !== 'modelscope-chinese-commodity-tick-gap-source-probe') {
  throw new Error('ModelScope Tick 来源探测报告类型不符合预期');
}
if (kaggleProbe.purpose !== 'kaggle-high-frequency-futures-data-china-probe') {
  throw new Error('Kaggle 期货分钟数据探测报告类型不符合预期');
}
if (
  huggingfaceProbe.purpose
  !== 'huggingface-domestic-futures-ticks-gap-source-probe'
) {
  throw new Error('Hugging Face 国内期货 Tick 探测报告类型不符合预期');
}
if (tushareProbe.purpose !== 'tushare-ft-mins-gap-source-probe') {
  throw new Error('Tushare 期货分钟探测报告类型不符合预期');
}
if (tonghuashunProbe.purpose !== 'tonghuashun-local-export-capability-probe') {
  throw new Error('同花顺本地导出能力探测报告类型不符合预期');
}
if (
  myquantProbe.purpose
  !== 'myquant-local-main-continuous-one-minute-probe'
) {
  throw new Error('MyQuant 本地分钟数据探测报告类型不符合预期');
}
if (easyfutProbe.purpose !== 'easyfut-tianqin-hosted-minute-api-probe') {
  throw new Error('EasyFut/TianQin 托管分钟接口探测报告类型不符合预期');
}
if (
  sinaContractProbe.purpose
  !== 'sina-futures-specific-contract-five-minute-window-probe'
) {
  throw new Error('新浪具体合约分钟窗口探测报告类型不符合预期');
}

const failedLiveProbe = (sourceName, request, error) => ({
  probeStatus: 'failed',
  request,
  error: error instanceof Error ? error.message : String(error),
  coverage: {
    targetGaps: TARGET_GAPS.map(gap => ({ ...gap, covered: false })),
    allTargetGapsCovered: false,
    conclusion: `${sourceName}实时探测失败，不能据此确认目标缺口覆盖。`,
  },
  retention: {
    rawResponsePersisted: false,
    rawRowsPersisted: false,
  },
});

const [sinaProbe, eastmoneyProbe] = await Promise.all([
  probeSinaRollingWindow().catch(error => failedLiveProbe(
    '新浪',
    {
      symbol: 'M0',
      intervalMinutes: 5,
      endpoint: SINA_ENDPOINT,
    },
    error,
  )),
  probeEastmoneyHistory().catch(error => failedLiveProbe(
    '东方财富',
    {
      symbol: '114.m0',
      intervalMinutes: 5,
      firstDate: '2025-07-01',
      lastDate: '2025-10-19',
      endpoint: EASTMONEY_ENDPOINT,
    },
    error,
  )),
]);

const assessments = candidateAssessments(
  sinaProbe,
  sinaContractProbe,
  eastmoneyProbe,
  pytdxProbe,
  modelscopeProbe,
  kaggleProbe,
  huggingfaceProbe,
  tushareProbe,
  tonghuashunProbe,
  myquantProbe,
  easyfutProbe,
  options.reviewedOn,
);
const releasableGapSourceFound = assessments.some(assessment => (
  assessment.redistributionAssessment.redistributionPermissionConfirmed
  && (
    assessment.accessAssessment.targetGapCoverageWithUpstreamRightsFound
    || assessment.accessAssessment.targetGapCoverageConfirmed
    || assessment.accessAssessment.capableOfCoveringTargetGap
    || assessment.accessAssessment.probe?.coverage?.allTargetGapsCovered
  )
));

const report = {
  schemaVersion: 1,
  purpose: 'target-gap-history-source-audit',
  reviewedOn: options.reviewedOn,
  targetGaps: TARGET_GAPS,
  policy: {
    accessCapabilityDoesNotGrantRedistributionRights: true,
    rawProbeMarketDataMayEnterRepository: false,
    rawProbeMarketDataMayEnterPackagedApplication: false,
  },
  inputs: {
    pytdxProbe: {
      path: 'data/pytdx-public-exhq-probe.json',
      capturedAt: pytdxProbe.capturedAt,
      probeStatus: pytdxProbe.probeStatus,
      summaryOnly: pytdxProbe.retention.summaryOnly,
    },
    modelscopeProbe: {
      path: 'data/modelscope-tick-source-probe.json',
      capturedAt: modelscopeProbe.capturedAt,
      commit: modelscopeProbe.source.commit,
      technicalGapCoverageConfirmed: (
        modelscopeProbe.releaseDecision.technicalGapCoverageConfirmed
      ),
      boundedAggregationSamplePassed: (
        modelscopeProbe.releaseDecision.boundedAggregationSamplePassed
      ),
      boundedAggregationPassedInstrumentCount: (
        modelscopeProbe.sampleSuite.passedInstrumentCount
      ),
      boundedAggregationSampleFileCount: (
        modelscopeProbe.sampleSuite.totals.files
      ),
      redistributionPermissionConfirmed: (
        modelscopeProbe.releaseDecision.redistributionPermissionConfirmed
      ),
      summaryOnly: modelscopeProbe.retention.reportContainsRawTickRows === false,
    },
    kaggleProbe: {
      path: 'data/kaggle-high-frequency-futures-data-china-probe.json',
      capturedAt: kaggleProbe.capturedAt,
      datasetVersion: kaggleProbe.source.currentVersionNumber,
      targetGapCoverageConfirmed: (
        kaggleProbe.coverage.targetGapCoverageConfirmed
      ),
      absolutePriceScaleAvailable: (
        kaggleProbe.coverage.absolutePriceScaleAvailable
      ),
      concreteContractAttributionAvailable: (
        kaggleProbe.coverage.concreteContractAttributionAvailable
      ),
      summaryOnly: kaggleProbe.retention.summaryOnly,
    },
    huggingfaceProbe: {
      path: 'data/huggingface-domestic-futures-ticks-probe.json',
      capturedAt: huggingfaceProbe.capturedAt,
      commit: huggingfaceProbe.source.commit,
      presentInstrumentCount: huggingfaceProbe.target.presentInstrumentCount,
      targetGapCoverageConfirmed: (
        huggingfaceProbe.coverage.allTargetGapCoverageConfirmed
      ),
      concreteContractAttributionAvailable: (
        huggingfaceProbe.coverage.concreteContractAttributionAvailable
      ),
      redistributionPermissionConfirmed: (
        huggingfaceProbe.conclusion.redistributionPermissionConfirmed
      ),
      summaryOnly: huggingfaceProbe.retention.summaryOnly,
    },
    tushareProbe: {
      path: 'data/tushare-ft-mins-probe.json',
      capturedAt: tushareProbe.capturedAt,
      probeStatus: tushareProbe.probeStatus,
      tokenPresent: tushareProbe.environment.tokenPresent,
      sampleAccessConfirmed: tushareProbe.coverage.sampleAccessConfirmed,
      targetGapCoverageConfirmed: (
        tushareProbe.coverage.targetGapCoverageConfirmed
      ),
      summaryOnly: tushareProbe.retention.summaryOnly,
    },
    tonghuashunProbe: {
      path: 'data/tonghuashun-local-export-probe.json',
      capturedOn: tonghuashunProbe.capturedOn,
      localThreeYearFiveMinuteExportCapabilityConfirmed: (
        tonghuashunProbe.conclusion.localThreeYearFiveMinuteExportCapabilityConfirmed
      ),
      targetGapCoverageConfirmed: tonghuashunProbe.conclusion.targetGapCoverageConfirmed,
      privateTcpMarketPathObserved: (
        tonghuashunProbe.networkObservation.privateTcpMarketPathObserved
      ),
      publicHttpHistoricalKlineEndpointFound: (
        tonghuashunProbe.networkObservation.publicHttpHistoricalKlineEndpointFound
      ),
      nativeSdkVersion: tonghuashunProbe.nativeSdkProbe.sdkVersion,
      nativeSdkAuthenticationSucceeded: (
        tonghuashunProbe.nativeSdkProbe.authenticationSucceeded
      ),
      nativeSdkSecurityDiscoverySucceeded: (
        tonghuashunProbe.nativeSdkProbe.securityDiscovery.succeeded
      ),
      nativeSdkHistoricalKlineAccessConfirmed: (
        tonghuashunProbe.nativeSdkProbe.historicalKlineAccessConfirmed
      ),
      nativeSdkSuccessfulHistoricalKlineRequestCount: (
        tonghuashunProbe.nativeSdkProbe.successfulHistoricalKlineRequestCount
      ),
      nativeSdkSessionFilePersistedAfterProbe: (
        tonghuashunProbe.nativeSdkProbe.sessionFilePersistedAfterProbe
      ),
      summaryOnly: tonghuashunProbe.retention.summaryOnly,
    },
    myquantProbe: {
      path: 'data/myquant-local-minute-probe.json',
      capturedAt: myquantProbe.capturedAt,
      targetInstrumentCount: myquantProbe.inventory.targetInstrumentCount,
      presentTargetInstrumentCount: (
        myquantProbe.inventory.presentTargetInstrumentCount
      ),
      firstTimestamp: myquantProbe.inventory.firstTimestamp,
      lastTimestamp: myquantProbe.inventory.lastTimestamp,
      targetGapOverlappingInstrumentCount: (
        myquantProbe.coverage.targetGapOverlappingInstrumentCount
      ),
      targetGapCoverageConfirmed: (
        myquantProbe.coverage.targetGapCoverageConfirmed
      ),
      redistributionPermissionConfirmed: (
        myquantProbe.releaseDecision.redistributionPermissionConfirmed
      ),
      summaryOnly: myquantProbe.retention.summaryOnly,
    },
    easyfutProbe: {
      path: 'data/easyfut-futures-minute-probe.json',
      reviewedOn: easyfutProbe.reviewedOn,
      successfulContractCount: (
        easyfutProbe.batchResult.successfulContractCount
      ),
      serverTimeoutCount: easyfutProbe.batchResult.serverTimeoutCount,
      soybeanMealCalendarGapOverlapObserved: (
        easyfutProbe.coverage.soybeanMeal
          .combinedCalendarSpanCoversTargetGap
      ),
      allTargetInstrumentCoverageConfirmed: (
        easyfutProbe.coverage.allTargetInstrumentCoverageConfirmed
      ),
      redistributionPermissionConfirmed: (
        easyfutProbe.releaseDecision.redistributionPermissionConfirmed
      ),
      summaryOnly: easyfutProbe.retention.summaryOnly,
    },
    sinaContractProbe: {
      path: 'data/sina-futures-minute-probe.json',
      capturedAt: sinaContractProbe.capturedAt,
      instrumentCount: sinaContractProbe.requestPlan.instrumentCount,
      requestedSymbolCount: sinaContractProbe.totals.requestedSymbolCount,
      nonEmptyResponseCount: sinaContractProbe.totals.nonEmptyResponseCount,
      gapOverlappingResponseCount: (
        sinaContractProbe.totals.gapOverlappingResponseCount
      ),
      technicalGapCoverageConfirmed: (
        sinaContractProbe.releaseDecision.technicalGapCoverageConfirmed
      ),
      redistributionPermissionConfirmed: (
        sinaContractProbe.releaseDecision.redistributionPermissionConfirmed
      ),
      summaryOnly: sinaContractProbe.retention.summaryOnly,
    },
  },
  writtenAuthorizationInquiry: buildWrittenAuthorizationInquiry(modelscopeProbe),
  enterpriseAuthorizationInquiry: buildEnterpriseAuthorizationInquiry(
    options.reviewedOn,
  ),
  assessments,
  releaseDecision: {
    redistributionPermissionConfirmed: releasableGapSourceFound,
    releasableGapSourceFound,
    realBaselineGapPublicationMustRemainIncomplete: !releasableGapSourceFound,
    baselineReplacementAllowed: false,
    task4_2MayBeMarkedComplete: false,
    note: (
      releasableGapSourceFound
        ? '存在覆盖目标缺口且允许再分发的来源，仍需通过后续质量校验。'
        : '尚未找到覆盖目标缺口且允许随产品再分发的来源；真实缺口回填和基线替换保持未完成。'
    ),
  },
};

await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`已生成目标缺口来源审计：${options.output}`);
