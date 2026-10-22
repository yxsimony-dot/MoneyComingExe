import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = join(ROOT, 'data', 'market-history-license-audit.json');

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

async function readJson(path) {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

const options = parseArguments(process.argv.slice(2));
const tdxProbePath = join(ROOT, 'data', 'tdx-tq-history-probe.json');
const publicSourcePath = join(ROOT, 'data', 'public-history-source-audit.json');
const pytdxProbePath = join(ROOT, 'data', 'pytdx-public-exhq-probe.json');
const modelscopeProbePath = join(ROOT, 'data', 'modelscope-tick-source-probe.json');
const kaggleProbePath = join(
  ROOT,
  'data',
  'kaggle-high-frequency-futures-data-china-probe.json',
);
const huggingfaceProbePath = join(
  ROOT,
  'data',
  'huggingface-domestic-futures-ticks-probe.json',
);
const tushareProbePath = join(ROOT, 'data', 'tushare-ft-mins-probe.json');
const tonghuashunProbePath = join(
  ROOT,
  'data',
  'tonghuashun-local-export-probe.json',
);
const [
  tdxProbe,
  publicSource,
  pytdxProbe,
  modelscopeProbe,
  kaggleProbe,
  huggingfaceProbe,
  tushareProbe,
  tonghuashunProbe,
] = await Promise.all([
  readJson(tdxProbePath),
  readJson(publicSourcePath),
  readJson(pytdxProbePath),
  readJson(modelscopeProbePath),
  readJson(kaggleProbePath),
  readJson(huggingfaceProbePath),
  readJson(tushareProbePath),
  readJson(tonghuashunProbePath),
]);

if (tdxProbe.purpose !== 'tdx-tq-single-instrument-five-minute-history-probe') {
  throw new Error('通达信探测报告类型不符合预期');
}
if (publicSource.purpose !== 'public-contract-five-minute-source-probe') {
  throw new Error('公开历史来源报告类型不符合预期');
}
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

const assessments = [
  {
    sourceId: 'tdxaidata-client-code',
    subject: 'tdxaidata Python 包、封装代码和随包动态库',
    codeLicense: {
      identifier: 'MIT',
      confirmed: true,
      evidence: tdxProbe.packageArtifacts.license,
    },
    marketDataRights: {
      coveredByCodeLicense: false,
      redistributionPermissionConfirmed: false,
      releaseEligibility: 'not-applicable-to-returned-market-data',
      reason: 'MIT 许可覆盖软件代码，不自动授予接口返回行情的复制或再分发权。',
    },
  },
  {
    sourceId: 'tdx-tq-market-data',
    subject: '通达信 TQ/TdxAiData 返回的期货行情',
    codeLicense: {
      identifier: null,
      confirmed: false,
      note: '本项审计对象是服务返回数据，不是客户端代码。',
    },
    marketDataRights: {
      queryCapabilityConfirmed: tdxProbe.conclusion.shortRangeRecordsConfirmed,
      redistributionPermissionConfirmed: false,
      releaseEligibility: 'blocked-without-separate-written-authorization',
      reason: (
        '官方用户协议限制未经授权复制、制作衍生作品、公开传播运行数据及客户端/服务端交互数据；'
        + '当前未取得允许提交 Git 并随 EXE/安装包再分发的单独书面授权。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'official-documentation',
        url: 'https://help.tdx.com.cn/quant/docs/markdown/mindoc-1hjbgqpdhv114.html',
        conclusion: '后台模式需要数据服务 Key，接口能力本身不构成行情再分发授权。',
      },
      {
        type: 'official-api-documentation',
        url: 'https://help.tdx.com.cn/quant/docs/markdown/mindoc-1ctuhthaq5qmg/mindoc-1h10g60jt68sc.html',
        conclusion: '长时间段分钟数据可能消耗较多积分；未公开本次短区间扣点和每秒限流数字。',
      },
      {
        type: 'official-user-agreement',
        url: 'https://www.tdx.com.cn/about/yhxy/index.html?tabindex=0',
        clause: '10',
        conclusion: '未获得单独授权前，不得将查询结果放入 Git、EXE 或安装包。',
      },
    ],
  },
  {
    sourceId: 'pytdx-client-code',
    subject: 'pytdx Python 客户端代码',
    codeLicense: {
      identifier: null,
      confirmed: pytdxProbe.rights.clientCodeLicenseConfirmed,
      evidence: pytdxProbe.environment.package.license,
      note: (
        '已安装 pytdx 1.72 的包元数据没有 License 字段，分发包与核验的上游提交均未发现 '
        + 'LICENSE/COPYING，当前不能确认客户端代码许可。'
      ),
    },
    marketDataRights: {
      coveredByCodeLicense: false,
      redistributionPermissionConfirmed: false,
      releaseEligibility: 'not-applicable-to-returned-market-data',
      reason: '即使后续确认客户端代码许可，也不会自动授予公共服务器返回行情的复制或再分发权。',
    },
    reviewedEvidence: [
      {
        type: 'installed-package-metadata',
        package: pytdxProbe.environment.package,
      },
      {
        type: 'upstream-client-repository',
        url: pytdxProbe.environment.package.homePage,
        commit: '2857fdad08534533610bd2aeca387f760c4baa42',
      },
    ],
  },
  {
    sourceId: 'pytdx-public-exhq-market-data',
    subject: 'pytdx 公共扩展行情服务器返回的连续合约 5 分钟行情',
    codeLicense: {
      identifier: null,
      confirmed: false,
      note: '本项审计对象是服务器返回行情，不是客户端代码。',
    },
    marketDataRights: {
      queryCapabilityConfirmed: (
        pytdxProbe.conclusion.targetGapAccessCapabilityConfirmed
      ),
      specificContractAttributionConfirmed: (
        pytdxProbe.conclusion.specificContractGapCapabilityConfirmed
      ),
      historicalMainContractMappingConfirmed: (
        pytdxProbe.conclusion.historicalMainContractMappingCapabilityConfirmed
      ),
      redistributionPermissionConfirmed: (
        pytdxProbe.rights.returnedMarketDataRedistributionPermissionConfirmed
      ),
      gitStorageAllowed: pytdxProbe.rights.gitStorageAllowed,
      packagedApplicationRedistributionAllowed: (
        pytdxProbe.rights.packagedApplicationRedistributionAllowed
      ),
      releaseEligibility: 'blocked-no-contract-attribution-and-no-redistribution-rights',
      reason: (
        '连续 L9 数据能够覆盖目标缺口并返回所需数值字段，但没有具体合约归属，'
        + '无法独立生成历史主力映射；同时没有公共服务器运营方、交易所或其他权利方'
        + '允许将返回行情写入 Git 并随 EXE/安装包分发的明确书面许可。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'local-summary-only-live-probe',
        path: 'data/pytdx-public-exhq-probe.json',
        capturedAt: pytdxProbe.capturedAt,
        server: pytdxProbe.server,
        retention: pytdxProbe.retention,
      },
    ],
  },
  {
    sourceId: 'github-china-futures-5min-2015-2025',
    subject: 'Freddy-Hexas/china-futures-5min-2015-2025 数据集',
    codeLicense: {
      identifier: publicSource.documentation.license.identifier,
      confirmed: publicSource.documentation.license.containsCanonicalHeading,
      note: '仓库根 LICENSE 与 README 对数据集声明 CC0。',
    },
    marketDataRights: {
      repositoryDatasetAssertionConfirmed: (
        publicSource.licenseAssessment.repositoryLicenseAppliesToDataset
      ),
      upstreamProvenanceDocumented: (
        publicSource.licenseAssessment.upstreamMarketDataProvenanceDocumented
      ),
      redistributionPermissionConfirmed: false,
      releaseEligibility: 'blocked-until-upstream-rights-confirmed',
      reason: (
        '仓库声明 CC0，但没有记录原始行情上游、取得方式或上游权利链；'
        + '在第三方行情权利边界独立确认前，只能用于临时结构与质量验证。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'repository',
        url: publicSource.source.repository,
        commit: publicSource.source.commit,
      },
      {
        type: 'repository-license',
        identifier: publicSource.documentation.license.identifier,
        sha256: publicSource.documentation.license.sha256,
      },
    ],
  },
  {
    sourceId: 'kaggle-wentinglu-highfrequency-futures-data-china',
    subject: 'Kaggle wentinglu/highfrequency-futures-data-china 分钟数据集',
    codeLicense: {
      identifier: kaggleProbe.rights.datasetLicenseIdentifier,
      confirmed: kaggleProbe.rights.datasetLicenseClaimPresent,
      note: (
        'Kaggle 数据集页声明 CC BY-SA 4.0；该声明未说明原始行情提供方、'
        + '取得方式或上传者获得的上游再分发权。'
      ),
    },
    marketDataRights: {
      repositoryDatasetAssertionConfirmed: (
        kaggleProbe.rights.datasetLicenseClaimPresent
      ),
      upstreamProvenanceDocumented: (
        kaggleProbe.rights.upstreamMarketDataProviderDocumented
      ),
      upstreamRedistributionAuthorityDocumented: (
        kaggleProbe.rights.upstreamRedistributionAuthorityDocumented
      ),
      technicalGapCoverageConfirmed: (
        kaggleProbe.coverage.targetGapCoverageConfirmed
      ),
      absolutePriceScaleAvailable: (
        kaggleProbe.coverage.absolutePriceScaleAvailable
      ),
      concreteContractAttributionAvailable: (
        kaggleProbe.coverage.concreteContractAttributionAvailable
      ),
      redistributionPermissionConfirmed: false,
      releaseEligibility: kaggleProbe.conclusion.releaseEligibility,
      reason: (
        '数据版本早于目标缺口，豆粕样本只有归一化价格且没有具体合约字段；'
        + '同时上游行情来源和权利链未说明，不能作为当前产品发布数据。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'local-summary-only-live-probe',
        path: 'data/kaggle-high-frequency-futures-data-china-probe.json',
        capturedAt: kaggleProbe.capturedAt,
        datasetRef: kaggleProbe.source.datasetRef,
        datasetVersion: kaggleProbe.source.currentVersionNumber,
        sampleFirstTimestamp: kaggleProbe.sample.minimumTimestamp,
        sampleLastTimestamp: kaggleProbe.sample.maximumTimestamp,
        sampleArchiveSha256: kaggleProbe.sample.download.sha256,
        sampleCsvSha256: kaggleProbe.sample.rawCsvSha256,
        retention: kaggleProbe.retention,
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
    subject: 'Hugging Face EdisonFU2025/Domestic_Futures_ticks 数据集',
    codeLicense: {
      identifier: huggingfaceProbe.rights.datasetLicenseIdentifier,
      confirmed: huggingfaceProbe.rights.datasetLicenseClaimPresent,
      note: (
        '数据集卡仅声明 MIT，未说明原始行情提供方、取得方式或上传者'
        + '获得的上游再分发权。'
      ),
    },
    marketDataRights: {
      repositoryDatasetAssertionConfirmed: (
        huggingfaceProbe.rights.datasetLicenseClaimPresent
      ),
      upstreamProvenanceDocumented: (
        huggingfaceProbe.rights.upstreamMarketDataProviderDocumented
      ),
      upstreamRedistributionAuthorityDocumented: (
        huggingfaceProbe.rights.upstreamRedistributionAuthorityDocumented
      ),
      technicalGapCoverageConfirmed: (
        huggingfaceProbe.coverage.allTargetGapCoverageConfirmed
      ),
      threeYearHistoryConfirmed: (
        huggingfaceProbe.coverage.threeYearHistoryConfirmed
      ),
      concreteContractAttributionAvailable: (
        huggingfaceProbe.coverage.concreteContractAttributionAvailable
      ),
      gitStorageAllowed: huggingfaceProbe.rights.gitStorageAllowed,
      packagedApplicationRedistributionAllowed: (
        huggingfaceProbe.rights.packagedApplicationRedistributionAllowed
      ),
      derivedBarsRedistributionAllowed: (
        huggingfaceProbe.rights.derivedBarsRedistributionAllowed
      ),
      commercialUseAllowed: huggingfaceProbe.rights.commercialUseAllowed,
      redistributionPermissionConfirmed: (
        huggingfaceProbe.conclusion.redistributionPermissionConfirmed
      ),
      releaseEligibility: huggingfaceProbe.conclusion.releaseEligibility,
      reason: huggingfaceProbe.conclusion.note,
    },
    reviewedEvidence: [
      {
        type: 'local-summary-only-live-probe',
        path: 'data/huggingface-domestic-futures-ticks-probe.json',
        capturedAt: huggingfaceProbe.capturedAt,
        datasetId: huggingfaceProbe.source.datasetId,
        commit: huggingfaceProbe.source.commit,
        targetInstrumentCount: huggingfaceProbe.target.instrumentCount,
        presentInstrumentCount: huggingfaceProbe.target.presentInstrumentCount,
        sampleFirstTimestamp: huggingfaceProbe.sample.minimumTimestamp,
        sampleLastTimestamp: huggingfaceProbe.sample.maximumTimestamp,
        sampleSha256: huggingfaceProbe.sample.download.sha256,
        retention: huggingfaceProbe.retention,
      },
      {
        type: 'dataset-page',
        url: huggingfaceProbe.source.url,
        declaredLicense: huggingfaceProbe.source.declaredLicense,
      },
    ],
  },
  {
    sourceId: 'tushare-ft-mins-market-data',
    subject: 'Tushare Pro ft_mins 返回的期货分钟行情',
    codeLicense: {
      identifier: null,
      confirmed: false,
      note: '本项审计对象是付费数据服务返回的行情，不是客户端代码。',
    },
    marketDataRights: {
      queryCapabilityDocumented: true,
      sampleAccessConfirmed: tushareProbe.coverage.sampleAccessConfirmed,
      specificContractAttributionConfirmed: (
        tushareProbe.coverage.specificContractAttributionAvailable
      ),
      technicalGapCoverageConfirmed: (
        tushareProbe.coverage.targetGapCoverageConfirmed
      ),
      gitStorageAllowed: tushareProbe.rights.gitStorageAllowed,
      packagedApplicationRedistributionAllowed: (
        tushareProbe.rights.packagedApplicationRedistributionAllowed
      ),
      derivedBarsRedistributionAllowed: (
        tushareProbe.rights.derivedBarsRedistributionAllowed
      ),
      commercialUseAllowed: tushareProbe.rights.commercialUseAllowed,
      redistributionPermissionConfirmed: false,
      releaseEligibility: tushareProbe.conclusion.releaseEligibility,
      reason: tushareProbe.conclusion.note,
    },
    reviewedEvidence: [
      {
        type: 'local-summary-only-live-probe',
        path: 'data/tushare-ft-mins-probe.json',
        capturedAt: tushareProbe.capturedAt,
        probeStatus: tushareProbe.probeStatus,
        retention: tushareProbe.retention,
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
    sourceId: 'tonghuashun-local-client-market-data',
    subject: '本机同花顺期货通客户端展示和私有 TCP 链路中的期货行情',
    codeLicense: {
      identifier: null,
      confirmed: false,
      note: '本项审计对象是客户端展示及服务返回行情，不是客户端程序代码。',
    },
    marketDataRights: {
      clientDisplayCapabilityConfirmed: tonghuashunProbe.application.processRunning,
      localHistoricalMinuteStoreConfirmed: tonghuashunProbe.databaseInventory.some(
        database => database.historicalMinuteBarsFound,
      ),
      supportedBulkExportConfirmed: (
        tonghuashunProbe.uiReview.documentedBulkHistoricalMinuteExportEntryFound
      ),
      privateTcpMarketPathObserved: (
        tonghuashunProbe.networkObservation.privateTcpMarketPathObserved
      ),
      publicHttpHistoricalKlineEndpointFound: (
        tonghuashunProbe.networkObservation.publicHttpHistoricalKlineEndpointFound
      ),
      packetCapturePerformed: tonghuashunProbe.inspectionPolicy.packetCapturePerformed,
      privateProtocolReverseEngineeringPerformed: (
        tonghuashunProbe.inspectionPolicy.privateProtocolReverseEngineeringPerformed
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
      redistributionPermissionConfirmed: (
        tonghuashunProbe.conclusion.redistributionPermissionConfirmed
      ),
      gitStorageAllowed: false,
      packagedApplicationRedistributionAllowed: false,
      releaseEligibility: tonghuashunProbe.conclusion.releaseEligibility,
      reason: tonghuashunProbe.conclusion.note,
    },
    reviewedEvidence: [
      {
        type: 'local-summary-only-client-inspection',
        path: 'data/tonghuashun-local-export-probe.json',
        capturedOn: tonghuashunProbe.capturedOn,
        executable: tonghuashunProbe.application.executable,
        observationMethod: tonghuashunProbe.networkObservation.observationMethod,
        retention: tonghuashunProbe.retention,
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
    sourceId: 'wenhua-historical-data-service-market-data',
    subject: '文华财经历史数据服务返回的国内期货 K 线与 Tick',
    codeLicense: {
      identifier: null,
      confirmed: false,
      note: '本项审计对象是付费历史行情和 API 返回值，不是客户端程序代码。',
    },
    marketDataRights: {
      historicalDataCapabilityDocumented: true,
      domesticFuturesHistoryFromListingAdvertised: true,
      documentedNativeOneMinuteBars: true,
      documentedApiAccess: true,
      targetInstrumentCoverageConfirmed: false,
      targetGapCoverageConfirmed: false,
      upstreamRedistributionAuthorityDocumented: false,
      gitStorageAllowed: false,
      packagedApplicationRedistributionAllowed: false,
      derivedBarsRedistributionAllowed: false,
      commercialUseAllowed: false,
      redistributionPermissionConfirmed: false,
      releaseEligibility: 'blocked-until-oem-static-redistribution-contract',
      reason: (
        '官方页面证明历史数据和 API 能力，但普通购买或单机 API 访问没有公开授予'
        + '将行情保存到 Git、转换为主连 K 线并随第三方 EXE/安装包离线分发的权利。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'official-historical-data-service',
        url: 'https://www.wenhua.com.cn/guide/lssj.htm',
        reviewedOn: options.reviewedOn,
      },
      {
        type: 'prepared-written-license-inquiry',
        path: 'docs/历史分钟数据OEM授权询价.md',
        status: 'awaiting-provider-written-quote',
      },
    ],
  },
  {
    sourceId: 'wind-client-api-futures-market-data',
    subject: 'Wind Client API 返回的期货高频历史行情',
    codeLicense: {
      identifier: null,
      confirmed: false,
      note: '本项审计对象是 Wind 数据服务返回的行情，不是 API 示例代码。',
    },
    marketDataRights: {
      clientApiCapabilityDocumented: true,
      highFrequencyHistoricalDataAdvertised: true,
      futuresCoverageAdvertised: true,
      targetInstrumentCoverageConfirmed: false,
      targetGapCoverageConfirmed: false,
      upstreamRedistributionAuthorityDocumented: false,
      gitStorageAllowed: false,
      packagedApplicationRedistributionAllowed: false,
      derivedBarsRedistributionAllowed: false,
      commercialUseAllowed: false,
      redistributionPermissionConfirmed: false,
      releaseEligibility: 'blocked-until-oem-static-redistribution-contract',
      reason: (
        'Wind Client API 的机构查询能力不自动包含第三方产品中的静态离线再分发权，'
        + '且仍需确认大商所、郑商所和上期所行情权利链。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'official-client-api-product-page',
        url: 'https://www.wind.com.cn/portal/zh/WDS/ClientApi.html',
        reviewedOn: options.reviewedOn,
      },
      {
        type: 'prepared-written-license-inquiry',
        path: 'docs/历史分钟数据OEM授权询价.md',
        status: 'awaiting-provider-written-quote',
      },
    ],
  },
  {
    sourceId: 'ifind-enterprise-interface-market-data',
    subject: '同花顺 iFinD 企业数据接口返回的期货日内行情',
    codeLicense: {
      identifier: null,
      confirmed: false,
      note: '本项审计对象是正式企业接口返回的行情，与本机期货通私有 TCP 链路分开审计。',
    },
    marketDataRights: {
      officialEnterpriseInterfaceDocumented: true,
      futuresIntradayDataAdvertised: true,
      targetInstrumentCoverageConfirmed: false,
      targetGapCoverageConfirmed: false,
      upstreamRedistributionAuthorityDocumented: false,
      gitStorageAllowed: false,
      packagedApplicationRedistributionAllowed: false,
      derivedBarsRedistributionAllowed: false,
      commercialUseAllowed: false,
      redistributionPermissionConfirmed: false,
      releaseEligibility: 'blocked-until-oem-static-redistribution-contract',
      reason: (
        '正式企业接口是合法商务路径，但终端或 API 订阅没有公开授予'
        + '把返回行情固化并随 MoneyComing 离线发布的权利。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'official-enterprise-data-interface',
        url: 'https://quantapi.51ifind.com/',
        reviewedOn: options.reviewedOn,
      },
      {
        type: 'prepared-written-license-inquiry',
        path: 'docs/历史分钟数据OEM授权询价.md',
        status: 'awaiting-provider-written-quote',
      },
    ],
  },
  {
    sourceId: 'rqdata-enterprise-futures-market-data',
    subject: 'RQData 企业数据服务返回的期货分钟行情',
    codeLicense: {
      identifier: null,
      confirmed: false,
      note: '本项审计对象是付费数据服务返回的行情，不是 Python 客户端代码。',
    },
    marketDataRights: {
      institutionalDataServiceDocumented: true,
      minuteHistoryCapabilityDocumented: true,
      targetInstrumentCoverageConfirmed: false,
      targetGapCoverageConfirmed: false,
      upstreamRedistributionAuthorityDocumented: false,
      gitStorageAllowed: false,
      packagedApplicationRedistributionAllowed: false,
      derivedBarsRedistributionAllowed: false,
      commercialUseAllowed: false,
      redistributionPermissionConfirmed: false,
      releaseEligibility: 'blocked-until-oem-static-redistribution-contract',
      reason: (
        '企业账号和分钟数据访问权不等于产品再分发权；'
        + '尚未取得覆盖 Git、派生主连和 EXE/安装包的 OEM 合同。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'official-institutional-data-service',
        url: 'https://www.ricequant.com/doc/rqdata-institution',
        reviewedOn: options.reviewedOn,
      },
      {
        type: 'prepared-written-license-inquiry',
        path: 'docs/历史分钟数据OEM授权询价.md',
        status: 'awaiting-provider-written-quote',
      },
    ],
  },
  {
    sourceId: 'csmar-futures-high-frequency-market-data',
    subject: 'CSMAR 中国商品期货高频数据库与定制交付数据',
    codeLicense: {
      identifier: null,
      confirmed: false,
      note: '本项审计对象是数据库和定制数据交付，不是客户端代码。',
    },
    marketDataRights: {
      commodityFuturesDataAdvertised: true,
      customizedDataServiceAdvertised: true,
      standardDatabaseLicenseAllowsThirdPartyTransfer: false,
      targetInstrumentCoverageConfirmed: false,
      targetGapCoverageConfirmed: false,
      upstreamRedistributionAuthorityDocumented: false,
      gitStorageAllowed: false,
      packagedApplicationRedistributionAllowed: false,
      derivedBarsRedistributionAllowed: false,
      commercialUseAllowed: false,
      redistributionPermissionConfirmed: false,
      releaseEligibility: (
        'blocked-standard-license-prohibits-transfer-until-separate-oem-contract'
      ),
      reason: (
        '官方数据库使用说明将普通许可限定为注册用户内部使用并禁止向第三方转移、出售或公开；'
        + '只有单独 OEM 合同可以改变当前结论。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'official-provider-product-page',
        url: 'https://www.csmar.com/channels/31.html',
        reviewedOn: options.reviewedOn,
      },
      {
        type: 'official-database-user-guide-license-notice',
        url: 'https://rs.csmar.com/',
        reviewedOn: options.reviewedOn,
      },
      {
        type: 'prepared-written-license-inquiry',
        path: 'docs/历史分钟数据OEM授权询价.md',
        status: 'awaiting-provider-written-quote',
      },
    ],
  },
  {
    sourceId: 'modelscope-ylzmota1-chinese-commodity-tick',
    subject: 'ModelScope ylzmota1/chinese-commodity 期货 Tick 数据集',
    codeLicense: {
      identifier: modelscopeProbe.rights.repositoryLicenseIdentifier,
      confirmed: modelscopeProbe.rights.repositoryLicenseClaimPresent,
      note: '数据集卡对仓库文件声明 Apache-2.0。该声明本身不能补足第三方行情的上游权利链。',
    },
    marketDataRights: {
      repositoryDatasetAssertionConfirmed: (
        modelscopeProbe.rights.repositoryLicenseAppliesToFilesAsClaimedByCard
      ),
      upstreamProvenanceDocumented: (
        modelscopeProbe.rights.upstreamMarketDataProvenanceDocumented
      ),
      upstreamRedistributionAuthorityDocumented: (
        modelscopeProbe.rights.upstreamMarketDataRedistributionAuthorityDocumented
      ),
      technicalGapCoverageConfirmed: (
        modelscopeProbe.releaseDecision.technicalGapCoverageConfirmed
      ),
      technicalThreeYearCoveragePotentialConfirmed: (
        modelscopeProbe.releaseDecision.technicalThreeYearCoveragePotentialConfirmed
      ),
      repositoryArchiveRange: {
        firstPeriod: modelscopeProbe.source.repositoryInventory.firstArchivePeriod,
        lastPeriod: modelscopeProbe.source.repositoryInventory.lastArchivePeriod,
        archiveCount: modelscopeProbe.source.repositoryInventory.archiveCount,
        totalBytes: modelscopeProbe.source.repositoryInventory.totalBytes,
      },
      redistributionPermissionConfirmed: (
        modelscopeProbe.releaseDecision.redistributionPermissionConfirmed
      ),
      gitStorageAllowed: modelscopeProbe.rights.gitStorageAllowedForMarketData,
      packagedApplicationRedistributionAllowed: (
        modelscopeProbe.rights.packagedApplicationRedistributionAllowed
      ),
      commercialUseAllowed: modelscopeProbe.rights.commercialUseAllowedForMarketData,
      releaseEligibility: 'blocked-until-upstream-rights-confirmed',
      reason: (
        '数据集卡声明 Apache-2.0，但使用默认模板，未记录原始行情提供方、取得方式或'
        + '上传者获得的上游再分发权。即使技术探测已覆盖目标缺口并确认三年以上历史潜力，'
        + '仍只能保留摘要和哈希，'
        + '不得将原始 Tick 或派生 K 线提交 Git 或随 EXE/安装包分发。'
      ),
    },
    reviewedEvidence: [
      {
        type: 'local-summary-only-range-probe',
        path: 'data/modelscope-tick-source-probe.json',
        capturedAt: modelscopeProbe.capturedAt,
        commit: modelscopeProbe.source.commit,
        technicalGapCoverageConfirmed: (
          modelscopeProbe.releaseDecision.technicalGapCoverageConfirmed
        ),
        technicalThreeYearCoveragePotentialConfirmed: (
          modelscopeProbe.releaseDecision.technicalThreeYearCoveragePotentialConfirmed
        ),
        repositoryManifestSha256: (
          modelscopeProbe.source.repositoryInventory.normalizedManifestSha256
        ),
        retention: modelscopeProbe.retention,
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
        declaredLicense: modelscopeProbe.source.datasetCard.declaredLicense,
        defaultTemplateOnly: modelscopeProbe.source.datasetCard.defaultTemplateOnly,
      },
    ],
  },
];

const report = {
  schemaVersion: 1,
  purpose: 'market-history-code-and-data-rights-audit',
  reviewedOn: options.reviewedOn,
  inputs: {
    tdxProbe: {
      path: 'data/tdx-tq-history-probe.json',
      capturedAt: tdxProbe.capturedAt,
      probeStatus: tdxProbe.probeStatus,
    },
    publicHistorySource: {
      path: 'data/public-history-source-audit.json',
      acquiredOn: publicSource.acquiredOn,
      commit: publicSource.source.commit,
    },
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
      summaryOnly: tushareProbe.retention.summaryOnly,
    },
    tonghuashunProbe: {
      path: 'data/tonghuashun-local-export-probe.json',
      capturedOn: tonghuashunProbe.capturedOn,
      privateTcpMarketPathObserved: (
        tonghuashunProbe.networkObservation.privateTcpMarketPathObserved
      ),
      localThreeYearFiveMinuteExportCapabilityConfirmed: (
        tonghuashunProbe.conclusion.localThreeYearFiveMinuteExportCapabilityConfirmed
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
      redistributionPermissionConfirmed: (
        tonghuashunProbe.conclusion.redistributionPermissionConfirmed
      ),
      summaryOnly: tonghuashunProbe.retention.summaryOnly,
    },
    enterpriseAuthorizationInquiry: {
      path: 'docs/历史分钟数据OEM授权询价.md',
      preparedOn: options.reviewedOn,
      providerCount: 5,
      writtenQuotesReceived: 0,
      redistributionPermissionConfirmed: false,
    },
  },
  policy: {
    codeLicenseAndMarketDataRightsAreIndependent: true,
    ambiguousOrAccountOnlyDataMayEnterGit: false,
    ambiguousOrAccountOnlyDataMayEnterPackagedApplication: false,
    privateClientProtocolExtractionAllowed: false,
    temporaryProbeMayStoreRawMarketDataInRepository: false,
  },
  assessments,
  releaseDecision: {
    allCandidateMarketDataRedistributionRightsConfirmed: assessments
      .filter(assessment => ![
        'tdxaidata-client-code',
        'pytdx-client-code',
      ].includes(assessment.sourceId))
      .every(assessment => assessment.marketDataRights.redistributionPermissionConfirmed),
    baselineReplacementAllowed: false,
    blockedSources: assessments
      .filter(assessment => assessment.marketDataRights.redistributionPermissionConfirmed === false)
      .map(assessment => ({
        sourceId: assessment.sourceId,
        releaseEligibility: assessment.marketDataRights.releaseEligibility,
      })),
    note: '当前候选只保留临时验证结果，现有内置基线不得被这些候选行情替换。',
  },
};

await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`已生成行情代码许可与数据权利审计：${options.output}`);
