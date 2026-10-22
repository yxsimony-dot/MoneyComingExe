import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('gap history source audit', () => {
  it('records the THSDK history failure without retaining market rows or credentials', async () => {
    const probe = JSON.parse(
      await readFile('data/tonghuashun-local-export-probe.json', 'utf8'),
    );
    const gapAudit = JSON.parse(
      await readFile('data/gap-history-source-audit.json', 'utf8'),
    );
    const licenseAudit = JSON.parse(
      await readFile('data/market-history-license-audit.json', 'utf8'),
    );
    const gapAssessment = gapAudit.assessments.find(
      (candidate: { sourceId: string }) => (
        candidate.sourceId === 'tonghuashun-local-client-export'
      ),
    );
    const licenseAssessment = licenseAudit.assessments.find(
      (candidate: { sourceId: string }) => (
        candidate.sourceId === 'tonghuashun-local-client-market-data'
      ),
    );

    expect(probe).toMatchObject({
      capturedOn: '2026-10-20',
      inspectionPolicy: {
        packetCapturePerformed: false,
        privateProtocolReverseEngineeringPerformed: false,
        nativeSdkProbePerformed: true,
      },
      nativeSdkProbe: {
        sdkVersion: '3.0.0',
        requestTimeoutSeconds: 120,
        authenticationSucceeded: true,
        securityDiscovery: {
          succeeded: true,
          verifiedCodes: ['m2701', 'm7777', 'm8888', 'm9999'],
        },
        successfulHistoricalKlineRequestCount: 0,
        historicalKlineAccessConfirmed: false,
        targetGapCoverageConfirmed: false,
        sessionFilePersistedAfterProbe: false,
      },
      retention: {
        summaryOnly: true,
        rawKlineRowsPersisted: false,
        accountIdentifiersPersisted: false,
        sessionFilePersisted: false,
        probeScriptsStoredInRepository: false,
      },
    });
    expect(probe.nativeSdkProbe.historicalKlineRequests).toEqual([
      expect.objectContaining({
        security: 'UCFDm2701',
        interval: '5-minute',
        status: 'failed',
        errorCode: 'timeout',
      }),
      expect.objectContaining({
        security: 'UCFDm9999',
        interval: 'day',
        status: 'failed',
        errorCode: 'query_failed',
      }),
      expect.objectContaining({
        security: 'UCFDm9999',
        interval: '5-minute',
        status: 'failed',
        errorCode: 'query_failed',
      }),
    ]);
    expect(gapAudit.inputs.tonghuashunProbe).toMatchObject({
      nativeSdkVersion: '3.0.0',
      nativeSdkAuthenticationSucceeded: true,
      nativeSdkSecurityDiscoverySucceeded: true,
      nativeSdkHistoricalKlineAccessConfirmed: false,
      nativeSdkSuccessfulHistoricalKlineRequestCount: 0,
      nativeSdkSessionFilePersistedAfterProbe: false,
    });
    expect(gapAssessment).toMatchObject({
      accessAssessment: {
        nativeSdkProbePerformed: true,
        nativeSdkVersion: '3.0.0',
        nativeSdkAuthenticationSucceeded: true,
        nativeSdkSecurityDiscoverySucceeded: true,
        nativeSdkHistoricalKlineRequestCount: 3,
        nativeSdkSuccessfulHistoricalKlineRequestCount: 0,
        nativeSdkHistoricalKlineAccessConfirmed: false,
        nativeSdkSessionFilePersistedAfterProbe: false,
        targetGapCoverageConfirmed: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
      },
    });
    expect(licenseAudit.inputs.tonghuashunProbe).toMatchObject({
      nativeSdkVersion: '3.0.0',
      nativeSdkAuthenticationSucceeded: true,
      nativeSdkSecurityDiscoverySucceeded: true,
      nativeSdkHistoricalKlineAccessConfirmed: false,
      nativeSdkSuccessfulHistoricalKlineRequestCount: 0,
      nativeSdkSessionFilePersistedAfterProbe: false,
      redistributionPermissionConfirmed: false,
    });
    expect(licenseAssessment).toMatchObject({
      marketDataRights: {
        nativeSdkProbePerformed: true,
        nativeSdkVersion: '3.0.0',
        nativeSdkAuthenticationSucceeded: true,
        nativeSdkSecurityDiscoverySucceeded: true,
        nativeSdkHistoricalKlineRequestCount: 3,
        nativeSdkSuccessfulHistoricalKlineRequestCount: 0,
        nativeSdkHistoricalKlineAccessConfirmed: false,
        nativeSdkSessionFilePersistedAfterProbe: false,
        redistributionPermissionConfirmed: false,
        gitStorageAllowed: false,
        packagedApplicationRedistributionAllowed: false,
      },
    });
    expect(gapAudit.releaseDecision.task4_2MayBeMarkedComplete).toBe(false);
    expect(licenseAudit.releaseDecision.baselineReplacementAllowed).toBe(false);
  });

  it('keeps Sina short-window access separate from release eligibility', async () => {
    const sinaProbe = JSON.parse(
      await readFile('data/sina-futures-minute-probe.json', 'utf8'),
    );
    expect(sinaProbe).toMatchObject({
      purpose: 'sina-futures-specific-contract-five-minute-window-probe',
      requestPlan: {
        instrumentCount: 15,
        czceFourDigitAndThreeDigitAliasesCompared: true,
      },
      rights: {
        returnedMarketDataRedistributionPermissionConfirmed: false,
      },
      retention: {
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      releaseDecision: {
        technicalGapCoverageConfirmed: false,
        redistributionPermissionConfirmed: false,
        releasableGapSourceFound: false,
        baselineReplacementAllowed: false,
        task4_2MayBeMarkedComplete: false,
      },
    });
    expect(sinaProbe.totals.nonEmptyResponseCount).toBeGreaterThan(0);
    expect(sinaProbe.totals.gapOverlappingResponseCount).toBeGreaterThan(0);
    expect(sinaProbe.instruments).toHaveLength(15);
    expect(
      sinaProbe.instruments.every(
        (instrument: { technicalGapCompletenessConfirmed: boolean }) => (
          instrument.technicalGapCompletenessConfirmed === false
        ),
      ),
    ).toBe(true);
  });

  it('does not allow the aggregate audit to publish an incomplete source', async () => {
    const audit = JSON.parse(
      await readFile('data/gap-history-source-audit.json', 'utf8'),
    );
    expect(audit.inputs.sinaContractProbe).toMatchObject({
      path: 'data/sina-futures-minute-probe.json',
      instrumentCount: 15,
      technicalGapCoverageConfirmed: false,
      redistributionPermissionConfirmed: false,
      summaryOnly: true,
    });
    expect(audit.releaseDecision).toMatchObject({
      redistributionPermissionConfirmed: false,
      releasableGapSourceFound: false,
      realBaselineGapPublicationMustRemainIncomplete: true,
      baselineReplacementAllowed: false,
      task4_2MayBeMarkedComplete: false,
    });
  });

  it('keeps local MyQuant post-gap data out of the release baseline', async () => {
    const myquantProbe = JSON.parse(
      await readFile('data/myquant-local-minute-probe.json', 'utf8'),
    );
    const audit = JSON.parse(
      await readFile('data/gap-history-source-audit.json', 'utf8'),
    );
    const assessment = audit.assessments.find(
      (candidate: { sourceId: string }) => (
        candidate.sourceId === 'local-myquant-main-continuous-one-minute'
      ),
    );

    expect(myquantProbe).toMatchObject({
      purpose: 'myquant-local-main-continuous-one-minute-probe',
      source: {
        provider: 'MyQuant',
        seriesKind: 'main-continuous',
        frequencyMinutes: 1,
        specificContractAttributionAvailable: false,
        observedAccountLimit: {
          recentNaturalDays: 180,
          documentedInDatasetReadme: true,
          documentedEarliestStartDate: '2025-12-05',
        },
      },
      inspectionPolicy: {
        readOnlyLocalInspection: true,
        rawCsvMarketRowsRead: false,
        standardizedCsvMarketRowsRead: false,
      },
      inventory: {
        targetInstrumentCount: 15,
        presentTargetInstrumentCount: 15,
        nonEmptyTargetInstrumentCount: 15,
      },
      coverage: {
        targetGapOverlappingInstrumentCount: 0,
        targetGapCoveredInstrumentCount: 0,
        allTargetSymbolsPresent: true,
        targetGapCoverageConfirmed: false,
      },
      rights: {
        writtenMarketDataRedistributionAuthorizationFound: false,
        packagedApplicationRedistributionPermissionConfirmed: false,
      },
      retention: {
        datasetCopiedIntoRepository: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      releaseDecision: {
        technicalGapCoverageConfirmed: false,
        redistributionPermissionConfirmed: false,
        releasableGapSourceFound: false,
        baselineReplacementAllowed: false,
        task4_2MayBeMarkedComplete: false,
        releaseEligibility: (
          'blocked-post-gap-main-continuous-and-redistribution-rights-unconfirmed'
        ),
      },
    });
    expect(myquantProbe.instruments).toHaveLength(15);
    expect(
      myquantProbe.instruments.every(
        (instrument: {
          csvMetadata: { contentReadByProbe: boolean };
          targetGap: { beginsAfterGap: boolean };
        }) => (
          instrument.csvMetadata.contentReadByProbe === false
          && instrument.targetGap.beginsAfterGap === true
        ),
      ),
    ).toBe(true);
    expect(audit.inputs.myquantProbe).toMatchObject({
      path: 'data/myquant-local-minute-probe.json',
      targetInstrumentCount: 15,
      presentTargetInstrumentCount: 15,
      targetGapOverlappingInstrumentCount: 0,
      targetGapCoverageConfirmed: false,
      redistributionPermissionConfirmed: false,
      summaryOnly: true,
    });
    expect(assessment).toMatchObject({
      accessAssessment: {
        seriesKind: 'main-continuous',
        frequencyMinutes: 1,
        specificContractAttributionAvailable: false,
        targetInstrumentCount: 15,
        presentTargetInstrumentCount: 15,
        targetGapOverlappingInstrumentCount: 0,
        targetGapCoverageConfirmed: false,
      },
      licenseAssessment: {
        accountDownloadPermissionObserved: true,
        accountDownloadPermissionGrantsRedistributionRights: false,
        writtenMarketDataRedistributionAuthorizationFound: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: (
          'blocked-post-gap-main-continuous-and-redistribution-rights-unconfirmed'
        ),
      },
      retention: {
        datasetCopiedIntoRepository: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
  });

  it('keeps newly reviewed crawler and repository candidates non-releasable', async () => {
    const easyfutProbe = JSON.parse(
      await readFile('data/easyfut-futures-minute-probe.json', 'utf8'),
    );
    const audit = JSON.parse(
      await readFile('data/gap-history-source-audit.json', 'utf8'),
    );
    type SourceAssessment = {
      sourceId: string;
      redistributionAssessment: {
        redistributionPermissionConfirmed: boolean;
      };
      [key: string]: unknown;
    };
    const assessments = new Map<string, SourceAssessment>(
      audit.assessments.map((assessment: SourceAssessment) => (
        [assessment.sourceId, assessment] as const
      )),
    );

    expect(easyfutProbe).toMatchObject({
      purpose: 'easyfut-tianqin-hosted-minute-api-probe',
      batchResult: {
        requestedContractCount: 30,
        successfulContractCount: 4,
        serverTimeoutCount: 26,
      },
      coverage: {
        soybeanMeal: {
          combinedCalendarSpanCoversTargetGap: true,
          tradingSessionCompletenessConfirmed: false,
          mainContractMappingConfirmed: false,
        },
        allTargetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
      },
      rights: {
        hostedMarketDataRedistributionPermissionConfirmed: false,
      },
      retention: {
        rawResponsesPersisted: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
      releaseDecision: {
        redistributionPermissionConfirmed: false,
        releasableGapSourceFound: false,
        baselineReplacementAllowed: false,
        task4_2MayBeMarkedComplete: false,
        releaseEligibility: (
          'blocked-unstable-partial-access-and-data-rights-unconfirmed'
        ),
      },
    });
    expect(audit.inputs.easyfutProbe).toMatchObject({
      path: 'data/easyfut-futures-minute-probe.json',
      successfulContractCount: 4,
      serverTimeoutCount: 26,
      soybeanMealCalendarGapOverlapObserved: true,
      allTargetInstrumentCoverageConfirmed: false,
      redistributionPermissionConfirmed: false,
      summaryOnly: true,
    });
    expect(
      assessments.get('easyfut-tianqin-hosted-minute-api'),
    ).toMatchObject({
      accessAssessment: {
        requestedContractCount: 30,
        successfulContractCount: 4,
        serverTimeoutCount: 26,
        serviceStabilityConfirmed: false,
        soybeanMealCalendarGapOverlapObserved: true,
        soybeanMealTradingSessionCompletenessConfirmed: false,
        allTargetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
      },
      licenseAssessment: {
        clientCodeLicense: 'Apache-2.0',
        clientCodeLicenseAppliesToHostedMarketData: false,
        hostedDataTermsFound: false,
        upstreamMarketDataProvenanceDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: (
          'blocked-unstable-partial-access-and-data-rights-unconfirmed'
        ),
      },
      retention: {
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
    expect(assessments.get('ftshare-futures-minutes')).toMatchObject({
      accessAssessment: {
        credentialRequired: true,
        apiKeyPresent: false,
        probeStatus: 'blocked-missing-api-key',
        targetGapCoverageConfirmed: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-api-key-and-data-rights-unconfirmed',
      },
      retention: {
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
    expect(
      assessments.get('modelscope-wzywuan-futures-kline-data'),
    ).toMatchObject({
      accessAssessment: {
        visibility: 'gated',
        loginRequired: true,
        fileInventoryReviewed: false,
        targetGapCoverageConfirmed: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: (
          'awaiting-access-and-written-redistribution-authorization'
        ),
      },
    });
    expect(
      assessments.get('github-tradingagents-for-futures-daily-data'),
    ).toMatchObject({
      accessAssessment: {
        targetInstrumentCount: 15,
        allTargetDailyFilesPresent: true,
        committedDataGranularity: 'daily',
        committedMinuteDatasetPresent: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: (
          'blocked-daily-only-and-upstream-rights-unconfirmed'
        ),
      },
    });
    expect(assessments.get('github-demondamon-rbhot-5m')).toMatchObject({
      accessAssessment: {
        commit: '758766f266bf7e88f96a56af753ec077c2d2034b',
        committedDataGranularity: '5-minute',
        coveredSymbols: ['RB'],
        firstTimestamp: '2010-05-31',
        lastTimestamp: '2017-10-09',
        coveredTargetInstrumentCount: 1,
        targetGapCoverageConfirmed: false,
      },
      licenseAssessment: {
        repositoryLicenseFilePresent: false,
        datasetLicense: null,
        upstreamMarketDataRedistributionAuthorityDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-stale-single-instrument-and-no-license',
      },
      retention: {
        datasetCopiedIntoRepository: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
    expect(assessments.get('github-kevinsherry-cta-daily-data')).toMatchObject({
      accessAssessment: {
        commit: '0e7a2b1496acdd1dfc9136f9f3b2a2f851d6a34b',
        committedFileCount: 4222,
        sampleDatasetPath: 'daily_data/20250703.csv',
        committedDataGranularity: 'daily-contract-cross-section',
        committedMinuteDatasetPresent: false,
        targetGapCoverageConfirmed: false,
      },
      licenseAssessment: {
        repositoryLicenseFilePresent: false,
        datasetLicense: null,
        upstreamMarketDataRedistributionAuthorityDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-daily-only-and-no-license',
      },
      retention: {
        repositoryClonedIntoProject: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
    expect(assessments.get('itick-futures-kline-api')).toMatchObject({
      accessAssessment: {
        tokenRequired: true,
        tokenPresent: false,
        probeStatus: 'blocked-missing-token',
        probeHttpStatus: 401,
        targetInstrumentCoverageConfirmed: false,
        targetGapCoverageConfirmed: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-missing-token-and-data-rights-unconfirmed',
      },
      retention: {
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
    expect(assessments.get('akshare-sina-rolling-window')).toMatchObject({
      accessAssessment: {
        historicalPagingProbe: {
          sampleContract: 'M2509',
          dateAndPaginationArgumentsTested: true,
          argumentsChangedReturnedWindow: false,
          returnedRowsApproximately: 1023,
          legacyGetMinLineHistoryPagingConfirmed: false,
        },
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-by-coverage-and-rights',
      },
    });
    expect(
      assessments.get('github-irontowersh-future-highfreq'),
    ).toMatchObject({
      accessAssessment: {
        commit: 'd30d57fbab55ca56c95a50ac6c34de305aaa49dc',
        packagedExecutableOnly: true,
        sourceCodePresent: false,
        serverConnectedAccordingToReadme: false,
        targetGapCoverageConfirmed: false,
      },
      licenseAssessment: {
        repositoryLicenseFilePresent: false,
        upstreamRedistributionAuthorityDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-disconnected-binary-and-no-license',
      },
      retention: {
        executableCopiedIntoRepository: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
    expect(assessments.get('github-putt-futures-collect')).toMatchObject({
      accessAssessment: {
        commit: 'e89700eb7d92e309d866e7ef70a723a7c6664ec9',
        committedDatabase: {
          tableCount: 43,
          rowCount: 27527,
          firstTimestamp: '2019-07-10 10:00:00',
          lastTimestamp: '2019-08-15 00:45:00',
        },
        targetGapCoverageConfirmed: false,
      },
      licenseAssessment: {
        codeLicense: 'MIT',
        codeLicenseAppliesToCommittedMarketData: false,
        upstreamRedistributionAuthorityDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-stale-data-and-upstream-rights-unconfirmed',
      },
      retention: {
        databaseCopiedIntoRepository: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
    expect(assessments.get('github-bobbyshiyi-cnfutures')).toMatchObject({
      accessAssessment: {
        commit: '8a45a117008f1495070ef6e0b56bd321c809d761',
        committedMarketDataPresent: false,
        committedCachePresent: false,
        targetGapCoverageConfirmed: false,
      },
      licenseAssessment: {
        codeLicense: 'MIT',
        codeLicenseAppliesToMarketData: false,
        marketDataOwnership: 'proprietary',
        upstreamRedistributionAuthorityDocumented: false,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-code-only-proprietary-data-not-included',
      },
      retention: {
        proprietaryMarketDataDownloaded: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
    expect(
      assessments.get('wstock-static-futures-minute-data'),
    ).toMatchObject({
      accessAssessment: {
        advertisedHistoryStartYear: 2003,
        advertisedIntervalsMinutes: [1, 5, 15, 30, 60, 120],
        targetInstrumentCoverageClaimed: true,
        targetGapCoverageConfirmed: false,
      },
      licenseAssessment: {
        publicTermsReviewed: true,
        selfUseOnly: true,
        redistributionExplicitlyProhibited: true,
      },
      redistributionAssessment: {
        redistributionPermissionConfirmed: false,
        releaseEligibility: 'blocked-public-terms-prohibit-redistribution',
      },
      retention: {
        sampleDownloaded: false,
        rawRowsPersisted: false,
        summaryOnly: true,
      },
    });
    expect(
      [...assessments.values()].filter(assessment => (
        [
          'itick-futures-kline-api',
          'github-irontowersh-future-highfreq',
          'github-putt-futures-collect',
          'github-bobbyshiyi-cnfutures',
          'github-demondamon-rbhot-5m',
          'github-kevinsherry-cta-daily-data',
          'wstock-static-futures-minute-data',
        ].includes(assessment.sourceId)
      )).every(assessment => (
        assessment.redistributionAssessment
          .redistributionPermissionConfirmed === false
      )),
    ).toBe(true);
  });

  it('keeps enterprise history providers blocked until an OEM redistribution contract exists', async () => {
    const gapAudit = JSON.parse(
      await readFile('data/gap-history-source-audit.json', 'utf8'),
    );
    const licenseAudit = JSON.parse(
      await readFile('data/market-history-license-audit.json', 'utf8'),
    );
    const inquiry = gapAudit.enterpriseAuthorizationInquiry;
    const gapAssessments = new Map(
      gapAudit.assessments.map(
        (assessment: { sourceId: string }) => (
          [assessment.sourceId, assessment] as const
        ),
      ),
    );
    const licenseAssessments = new Map(
      licenseAudit.assessments.map(
        (assessment: { sourceId: string }) => (
          [assessment.sourceId, assessment] as const
        ),
      ),
    );

    expect(inquiry).toMatchObject({
      status: 'ready-to-send-awaiting-provider-written-quotes',
      document: 'docs/历史分钟数据OEM授权询价.md',
      requestedDataset: {
        targetInstrumentCount: 15,
        requiredSeries: '逐具体交割合约',
        minimumHistoryFirstDate: '2022-10-20',
        requiredHistoryLastDate: '2026-10-16',
      },
    });
    expect(inquiry.requestedDataset.targetInstruments).toHaveLength(15);
    expect(inquiry.requiredWrittenRights).toHaveLength(6);
    expect(inquiry.priorityProviders).toHaveLength(5);
    expect(
      inquiry.priorityProviders.every(
        (provider: { status: string }) => (
          provider.status === 'awaiting-written-oem-redistribution-quote'
        ),
      ),
    ).toBe(true);

    for (const sourceId of [
      'wenhua-historical-data-service',
      'wind-client-api-futures-intraday',
      'ifind-enterprise-data-interface',
      'rqdata-futures-minute',
      'csmar-futures-high-frequency-data',
    ]) {
      expect(gapAssessments.get(sourceId)).toMatchObject({
        redistributionAssessment: {
          redistributionPermissionConfirmed: false,
        },
      });
    }

    for (const sourceId of [
      'wenhua-historical-data-service-market-data',
      'wind-client-api-futures-market-data',
      'ifind-enterprise-interface-market-data',
      'rqdata-enterprise-futures-market-data',
      'csmar-futures-high-frequency-market-data',
    ]) {
      expect(licenseAssessments.get(sourceId)).toMatchObject({
        marketDataRights: {
          gitStorageAllowed: false,
          packagedApplicationRedistributionAllowed: false,
          derivedBarsRedistributionAllowed: false,
          commercialUseAllowed: false,
          redistributionPermissionConfirmed: false,
        },
      });
    }

    expect(licenseAudit.inputs.enterpriseAuthorizationInquiry).toMatchObject({
      path: 'docs/历史分钟数据OEM授权询价.md',
      providerCount: 5,
      writtenQuotesReceived: 0,
      redistributionPermissionConfirmed: false,
    });
    expect(gapAudit.releaseDecision.baselineReplacementAllowed).toBe(false);
    expect(licenseAudit.releaseDecision.baselineReplacementAllowed).toBe(false);
  });
});
