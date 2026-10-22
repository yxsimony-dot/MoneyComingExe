import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = join(ROOT, 'data', 'tushare-ft-mins-probe.json');
const API_URL = 'https://api.tushare.pro';
const API_DOCUMENTATION_URL = 'https://tushare.pro/document/2?doc_id=313';
const DATA_SERVICE_AGREEMENT_URL = 'https://tushare.pro/document/1?doc_id=405';
const TOKEN_ENVIRONMENT_NAMES = ['TUSHARE_TOKEN', 'TS_TOKEN'];
const SAMPLE_REQUEST = {
  apiName: 'ft_mins',
  tsCode: 'M2509.DCE',
  freq: '5min',
  startDate: '2025-07-01 09:00:00',
  endDate: '2025-07-01 15:00:00',
  fields: [
    'ts_code',
    'trade_time',
    'open',
    'high',
    'low',
    'close',
    'vol',
    'amount',
    'oi',
  ],
};

function parseArguments(argv) {
  const options = {
    output: DEFAULT_OUTPUT,
    timeoutMs: 30_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--output' && value) {
      options.output = value;
      index += 1;
    } else if (argument === '--timeout-ms' && value) {
      options.timeoutMs = Number(value);
      index += 1;
    } else {
      throw new Error(`未知参数或缺少参数值：${argument}`);
    }
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms 必须是大于 0 的数字');
  }
  return {
    output: resolve(options.output),
    timeoutMs: options.timeoutMs,
  };
}

function resolveToken() {
  for (const environmentName of TOKEN_ENVIRONMENT_NAMES) {
    const token = process.env[environmentName]?.trim();
    if (token) {
      return {
        environmentName,
        token,
      };
    }
  }
  return null;
}

function baseReport(tokenEnvironmentName) {
  return {
    schemaVersion: 1,
    purpose: 'tushare-ft-mins-gap-source-probe',
    capturedAt: new Date().toISOString(),
    source: {
      name: 'Tushare Pro 期货历史分钟行情',
      apiUrl: API_URL,
      apiDocumentationUrl: API_DOCUMENTATION_URL,
      dataServiceAgreementUrl: DATA_SERVICE_AGREEMENT_URL,
      documentedIntervals: ['1min', '5min', '15min', '30min', '60min'],
      documentedMaximumRowsPerRequest: 8000,
      documentedHistory: '超过 10 年',
      separatePermissionRequired: true,
    },
    request: SAMPLE_REQUEST,
    environment: {
      tokenEnvironmentNamesChecked: TOKEN_ENVIRONMENT_NAMES,
      tokenPresent: Boolean(tokenEnvironmentName),
      tokenEnvironmentName,
      tokenPersistedInReport: false,
    },
    rights: {
      defaultDataServiceLicenseScope: '个人、不可转让、非商业用途',
      gitStorageAllowed: false,
      packagedApplicationRedistributionAllowed: false,
      derivedBarsRedistributionAllowed: false,
      commercialUseAllowed: false,
      separateWrittenAuthorizationRequired: true,
    },
    retention: {
      rawResponsePersisted: false,
      rawRowsPersisted: false,
      tokenPersisted: false,
      summaryOnly: true,
    },
  };
}

function summarizeResponse(payload) {
  const fields = Array.isArray(payload?.data?.fields) ? payload.data.fields : [];
  const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
  const tradeTimeIndex = fields.indexOf('trade_time');
  const timestamps = tradeTimeIndex >= 0
    ? items
      .map(item => item[tradeTimeIndex])
      .filter(value => typeof value === 'string')
      .sort()
    : [];
  return {
    apiCode: payload?.code ?? null,
    apiMessage: payload?.msg ?? null,
    fields,
    rowCount: items.length,
    firstTimestamp: timestamps.at(0) ?? null,
    lastTimestamp: timestamps.at(-1) ?? null,
    requiredFieldsComplete: SAMPLE_REQUEST.fields.every(field => fields.includes(field)),
  };
}

async function probe(token, timeoutMs) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'MoneyComing Tushare source audit/1',
    },
    body: JSON.stringify({
      api_name: SAMPLE_REQUEST.apiName,
      token,
      params: {
        ts_code: SAMPLE_REQUEST.tsCode,
        freq: SAMPLE_REQUEST.freq,
        start_date: SAMPLE_REQUEST.startDate,
        end_date: SAMPLE_REQUEST.endDate,
      },
      fields: SAMPLE_REQUEST.fields.join(','),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json();
  return {
    httpStatus: response.status,
    contentType: response.headers.get('content-type'),
    ...summarizeResponse(payload),
  };
}

const options = parseArguments(process.argv.slice(2));
const token = resolveToken();
const report = baseReport(token?.environmentName ?? null);

if (!token) {
  Object.assign(report, {
    probeStatus: 'blocked-no-token',
    response: {
      requestPerformed: false,
      httpStatus: null,
      apiCode: null,
      apiMessage: null,
      fields: [],
      rowCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      requiredFieldsComplete: false,
    },
    coverage: {
      sampleAccessConfirmed: false,
      specificContractAttributionAvailable: true,
      targetGapCoverageConfirmed: false,
    },
    conclusion: {
      releaseEligibility: 'blocked-no-token-and-non-commercial-license',
      note: (
        '本机未发现 TUSHARE_TOKEN 或 TS_TOKEN，未执行行情请求；'
        + '即使后续开通期货历史分钟权限，公开数据服务协议仍只授予个人、'
        + '不可转让、非商业用途，不能直接用于 Git、EXE 或安装包再分发。'
      ),
    },
  });
} else {
  try {
    const response = await probe(token.token, options.timeoutMs);
    const sampleAccessConfirmed = (
      response.httpStatus === 200
      && response.apiCode === 0
      && response.rowCount > 0
      && response.requiredFieldsComplete
    );
    Object.assign(report, {
      probeStatus: sampleAccessConfirmed ? 'success' : 'api-rejected-or-empty',
      response: {
        requestPerformed: true,
        ...response,
      },
      coverage: {
        sampleAccessConfirmed,
        specificContractAttributionAvailable: true,
        targetGapCoverageConfirmed: false,
      },
      conclusion: {
        releaseEligibility: (
          sampleAccessConfirmed
            ? 'blocked-non-commercial-license'
            : 'blocked-api-access-and-non-commercial-license'
        ),
        note: (
          sampleAccessConfirmed
            ? '单日具体合约 5 分钟样本访问成功，但公开许可仅限个人非商业使用，不能进入发布基线。'
            : 'Tushare 请求未取得可用样本，且公开许可仅限个人非商业使用，不能进入发布基线。'
        ),
      },
    });
  } catch (error) {
    Object.assign(report, {
      probeStatus: 'failed',
      response: {
        requestPerformed: true,
        error: error instanceof Error ? error.message : String(error),
        httpStatus: null,
        apiCode: null,
        apiMessage: null,
        fields: [],
        rowCount: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        requiredFieldsComplete: false,
      },
      coverage: {
        sampleAccessConfirmed: false,
        specificContractAttributionAvailable: true,
        targetGapCoverageConfirmed: false,
      },
      conclusion: {
        releaseEligibility: 'blocked-probe-failed-and-non-commercial-license',
        note: 'Tushare 实时探测失败，且公开许可仅限个人非商业使用，不能进入发布基线。',
      },
    });
  }
}

await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`已生成 Tushare 期货分钟探测摘要：${options.output}`);
