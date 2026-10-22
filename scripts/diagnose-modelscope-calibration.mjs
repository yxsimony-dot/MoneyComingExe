import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INSTRUMENT_LIST } from '../src/shared/instruments.ts';
import {
  assertSafeOutputPath,
  atomicReplaceDirectory,
  groupBarsByTradingDate,
  normalizeDailyRecordContinuity,
  prepareSourceContext,
  readEdbBaseline,
} from './generate-modelscope-temporary-candidates.mjs';
import {
  aggregateMinutes,
  extractEntry,
  INSTRUMENTS,
  parseTickCsv,
  REPOSITORY,
  ticksToMinutes,
} from './probe-modelscope-tick-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TEMPORARY_ROOT = 'D:\\MoneyComing-temp';
const DEFAULT_OUTPUT = join(
  DEFAULT_TEMPORARY_ROOT,
  'modelscope-calibration-diagnostics',
);
const DEFAULT_DATES = [
  '2025-10-10',
  '2025-10-16',
  '2025-11-04',
  '2025-11-06',
  '2025-11-07',
];
const DEFAULT_INSTRUMENT_ID = 'main_continuous';
export const DEFAULT_TIMESTAMP_OFFSETS_MS = [
  -1_000,
  -500,
  -250,
  -100,
  -50,
  0,
  50,
  100,
  250,
  500,
  1_000,
];
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000;
const SESSION_WINDOWS_MS = {
  day: [
    [9 * 60 * 60 * 1_000, (10 * 60 + 15) * 60 * 1_000],
    [(10 * 60 + 30) * 60 * 1_000, (11 * 60 + 30) * 60 * 1_000],
    [(13 * 60 + 30) * 60 * 1_000, 15 * 60 * 60 * 1_000],
  ],
  night: [
    [21 * 60 * 60 * 1_000, 23 * 60 * 60 * 1_000],
  ],
};
const BAR_FIELDS = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'openOi',
  'closeOi',
  'observedMinutes',
  'expectedMinutes',
  'complete',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function formatBeijing(milliseconds) {
  const date = new Date(milliseconds + 8 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function validateDate(value, label) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value), `${label} 必须为 YYYY-MM-DD`);
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  assert(
    Number.isFinite(milliseconds)
      && new Date(milliseconds).toISOString().slice(0, 10) === value,
    `${label} 不是有效日期：${value}`,
  );
}

function parseTimestampOffsets(value) {
  const offsets = [...new Set(
    value.split(',').map(item => Number(item.trim())),
  )].sort((left, right) => left - right);
  assert(
    offsets.length > 0 && offsets.every(Number.isInteger),
    '--offsets-ms must contain comma-separated integer milliseconds',
  );
  assert(offsets.includes(0), '--offsets-ms must include 0');
  return offsets;
}

export function parseDiagnosticArguments(
  argv,
  {
    repositoryRoot = ROOT,
    temporaryRoot = DEFAULT_TEMPORARY_ROOT,
  } = {},
) {
  const options = {
    dates: DEFAULT_DATES,
    output: join(temporaryRoot, 'modelscope-calibration-diagnostics'),
    probe: join(repositoryRoot, 'data', 'modelscope-tick-source-probe.json'),
    timestampOffsetsMs: DEFAULT_TIMESTAMP_OFFSETS_MS,
    instrumentId: DEFAULT_INSTRUMENT_ID,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    assert(value && !value.startsWith('--'), `${argument} 缺少参数值`);
    if (argument === '--dates') {
      options.dates = value.split(',').map(item => item.trim()).filter(Boolean);
    } else if (argument === '--output') {
      options.output = value;
    } else if (argument === '--probe') {
      options.probe = value;
    } else if (argument === '--offsets-ms') {
      options.timestampOffsetsMs = parseTimestampOffsets(value);
    } else if (argument === '--instrument') {
      options.instrumentId = value;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
    index += 1;
  }
  const dates = [...new Set(options.dates)].sort();
  assert(dates.length > 0, '--dates 至少需要一个交易日');
  for (const date of dates) validateDate(date, '--dates');
  assert(
    INSTRUMENTS.some(instrument => instrument.id === options.instrumentId),
    `未知品种：${options.instrumentId}`,
  );
  return {
    dates,
    output: assertSafeOutputPath(options.output, {
      repositoryRoot,
      temporaryRoot,
    }),
    probe: resolve(options.probe),
    timestampOffsetsMs: options.timestampOffsetsMs,
    instrumentId: options.instrumentId,
    repositoryRoot: resolve(repositoryRoot),
    temporaryRoot: resolve(temporaryRoot),
  };
}

function splitCsvRow(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === ',') {
      values.push(value);
      value = '';
    } else if (character === '"') {
      quoted = true;
    } else {
      value += character;
    }
  }
  assert(!quoted, 'CSV 引号未闭合');
  values.push(value);
  return values;
}

export function decodeRawTickRows(buffer) {
  const text = new TextDecoder('gb18030').decode(buffer).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  assert(lines.length > 0, '原始 Tick CSV 为空');
  const fields = splitCsvRow(lines[0]).map(value => value.trim());
  const rows = lines.slice(1).map((rawLine, index) => {
    const values = splitCsvRow(rawLine);
    assert(
      values.length === fields.length,
      `原始 Tick CSV 第 ${index + 2} 行列数不一致`,
    );
    return {
      lineNumber: index + 2,
      rawLine,
      values: Object.fromEntries(
        fields.map((field, fieldIndex) => [field, values[fieldIndex].trim()]),
      ),
    };
  });
  return { fields, rows };
}

function enrichTick(tick) {
  return {
    ...tick,
    timestamp: formatBeijing(tick.timestampMs),
  };
}

function enrichMinute(minute) {
  return {
    ...minute,
    start: formatBeijing(minute.startMs),
  };
}

function enrichBar(bar) {
  return {
    ...bar,
    start: formatBeijing(bar.startMs),
    end: formatBeijing(bar.endMs),
    session: Number(formatBeijing(bar.startMs).slice(11, 13)) >= 21
      ? 'night'
      : 'day',
  };
}

function rowNumber(row, field) {
  const value = Number(row?.values?.[field]);
  return Number.isFinite(value) ? value : null;
}

function buildCloseWindowEvidence(rawRows, ticks, candidateBars, edbBars) {
  const closeWindowRows = rawRows.filter(row => {
    const updateTime = row.values.UpdateTime;
    return updateTime >= '14:55:00' && updateTime <= '15:00:00';
  });
  const firstWindowIndex = closeWindowRows.length
    ? rawRows.indexOf(closeWindowRows[0])
    : -1;
  const previousRawRow = firstWindowIndex > 0
    ? rawRows[firstWindowIndex - 1]
    : null;
  const exactCloseRows = closeWindowRows.filter(
    row => row.values.UpdateTime === '15:00:00',
  );
  const candidateBar = candidateBars.find(
    bar => bar.start.endsWith('14:55:00'),
  ) ?? null;
  const edbBar = edbBars.find(
    bar => bar.start.endsWith('14:55:00'),
  ) ?? null;
  const parsedTicks = candidateBar
    ? ticks.filter(tick => (
      tick.timestampMs >= candidateBar.startMs
      && tick.timestampMs < candidateBar.endMs
    ))
    : [];
  const firstVolume = rowNumber(previousRawRow, 'Volume');
  const lastVolume = rowNumber(closeWindowRows.at(-1), 'Volume');
  const cumulativeDeltaFromPreviousRow = (
    firstVolume !== null
    && lastVolume !== null
    && lastVolume >= firstVolume
  )
    ? lastVolume - firstVolume
    : null;
  const parsedVolume = parsedTicks.reduce(
    (sum, tick) => sum + tick.volumeDelta,
    0,
  );
  const finalParsedTick = parsedTicks.at(-1) ?? null;
  const finalExactCloseRow = exactCloseRows.at(-1) ?? null;
  return {
    previousRawRow,
    closeWindowRows,
    exactCloseRows,
    cumulativeDeltaFromPreviousRow,
    parsedTickCount: parsedTicks.length,
    parsedVolume,
    finalParsedTick: finalParsedTick ? enrichTick(finalParsedTick) : null,
    finalExactCloseValues: finalExactCloseRow ? {
      lastPrice: rowNumber(finalExactCloseRow, 'LastPrice'),
      cumulativeVolume: rowNumber(finalExactCloseRow, 'Volume'),
      openInterest: rowNumber(finalExactCloseRow, 'OpenInterest'),
      updateMillisec: rowNumber(finalExactCloseRow, 'UpdateMillisec'),
    } : null,
    candidateBar,
    edbBar,
    comparisons: {
      candidateVolumeMatchesParsedTicks: candidateBar
        ? candidateBar.volume === parsedVolume
        : null,
      candidateVolumeMatchesCumulativeDelta: (
        candidateBar && cumulativeDeltaFromPreviousRow !== null
      )
        ? candidateBar.volume === cumulativeDeltaFromPreviousRow
        : null,
      edbVolumeMatchesCumulativeDelta: (
        edbBar && cumulativeDeltaFromPreviousRow !== null
      )
        ? edbBar.volume === cumulativeDeltaFromPreviousRow
        : null,
      candidateCloseOiMatchesExactClose: (
        candidateBar && finalExactCloseRow
      )
        ? candidateBar.closeOi === rowNumber(finalExactCloseRow, 'OpenInterest')
        : null,
      edbCloseOiMatchesExactClose: (
        edbBar && finalExactCloseRow
      )
        ? edbBar.closeOi === rowNumber(finalExactCloseRow, 'OpenInterest')
        : null,
    },
  };
}

function compactTick(tick) {
  return tick ? enrichTick(tick) : null;
}

function tickAtOrAfter(ticks, milliseconds) {
  return ticks.find(tick => tick.timestampMs >= milliseconds) ?? null;
}

function tickBefore(ticks, milliseconds) {
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    if (ticks[index].timestampMs < milliseconds) return ticks[index];
  }
  return null;
}

function wallTimeMs(milliseconds) {
  const beijing = new Date(milliseconds + BEIJING_OFFSET_MS);
  return (
    beijing.getUTCHours() * 60 * 60 * 1_000
    + beijing.getUTCMinutes() * 60 * 1_000
    + beijing.getUTCSeconds() * 1_000
    + beijing.getUTCMilliseconds()
  );
}

function sessionAtTimestamp(milliseconds) {
  const wall = wallTimeMs(milliseconds);
  for (const [session, windows] of Object.entries(SESSION_WINDOWS_MS)) {
    if (windows.some(([start, end]) => wall >= start && wall < end)) {
      return session;
    }
  }
  return null;
}

export function shiftTicksForDiagnostic(ticks, offsetMs) {
  let shiftedTicks = 0;
  let retainedAtSessionBoundary = 0;
  const shifted = ticks.map((tick, sourceIndex) => {
    const targetTimestampMs = tick.timestampMs + offsetMs;
    if (
      offsetMs === 0
      || sessionAtTimestamp(targetTimestampMs) !== tick.session
    ) {
      if (offsetMs !== 0) retainedAtSessionBoundary += 1;
      return { ...tick, sourceIndex };
    }
    shiftedTicks += 1;
    return {
      ...tick,
      timestampMs: targetTimestampMs,
      sourceIndex,
    };
  });
  shifted.sort((left, right) => (
    left.timestampMs - right.timestampMs
    || left.sourceIndex - right.sourceIndex
  ));
  return {
    ticks: shifted.map(({ sourceIndex: _sourceIndex, ...tick }) => tick),
    shiftedTicks,
    retainedAtSessionBoundary,
  };
}

function matchingNearBoundarySnapshot({
  fields,
  candidate,
  edb,
  ticks,
  boundaryMs,
  side,
}) {
  const windowTicks = ticks.filter(tick => (
    tick.timestampMs >= boundaryMs - 1_000
    && tick.timestampMs < boundaryMs
  ));
  if (windowTicks.length < 2 || !fields.includes('volume')) return null;
  const priceField = side === 'end' ? 'close' : 'open';
  const oiField = side === 'end' ? 'closeOi' : 'openOi';
  if (!fields.includes(priceField) && !fields.includes(oiField)) return null;

  const snapshotTick = windowTicks.at(-2);
  const transferredTick = windowTicks.at(-1);
  const snapshotIntervalMs = (
    transferredTick.timestampMs - snapshotTick.timestampMs
  );
  const transferredTickBoundaryGapMs = boundaryMs - transferredTick.timestampMs;
  if (
    snapshotIntervalMs < 400
    || snapshotIntervalMs > 600
    || transferredTickBoundaryGapMs < 0
    || transferredTickBoundaryGapMs > 250
    || transferredTick.volumeDelta <= 0
  ) return null;

  const expectedVolume = side === 'end'
    ? candidate.volume - transferredTick.volumeDelta
    : candidate.volume + transferredTick.volumeDelta;
  const priceMatches = !fields.includes(priceField)
    || edb[priceField] === snapshotTick.lastPrice;
  const oiMatches = !fields.includes(oiField)
    || edb[oiField] === snapshotTick.openInterest;
  if (
    !priceMatches
    || !oiMatches
    || edb.volume !== expectedVolume
  ) return null;

  return {
    side,
    boundary: formatBeijing(boundaryMs),
    snapshotTick: compactTick(snapshotTick),
    transferredTicks: [compactTick(transferredTick)],
    transferredVolume: transferredTick.volumeDelta,
    snapshotIntervalMs,
    transferredTickBoundaryGapMs,
  };
}

export function classifyMismatchEvidence({
  fields,
  candidate,
  edb,
  startMs,
  endMs,
  ticks,
  minutes,
  closeWindowEvidence = null,
}) {
  const barTicks = ticks.filter(tick => (
    tick.timestampMs >= startMs && tick.timestampMs < endMs
  ));
  const barMinutes = minutes.filter(minute => (
    minute.startMs >= startMs && minute.startMs < endMs
  ));
  const previousTick = tickBefore(ticks, startMs);
  const firstTick = tickAtOrAfter(ticks, startMs);
  const nextBoundaryTick = tickAtOrAfter(ticks, endMs);
  const exactStartTick = firstTick?.timestampMs === startMs ? firstTick : null;
  const exactEndTick = nextBoundaryTick?.timestampMs === endMs
    ? nextBoundaryTick
    : null;
  const categories = new Set();
  const priceEvidence = {};
  const nearBoundarySnapshotEvidence = (
    matchingNearBoundarySnapshot({
      fields,
      candidate,
      edb,
      ticks,
      boundaryMs: endMs,
      side: 'end',
    })
    ?? matchingNearBoundarySnapshot({
      fields,
      candidate,
      edb,
      ticks,
      boundaryMs: startMs,
      side: 'start',
    })
  );
  if (nearBoundarySnapshotEvidence) {
    categories.add('near-boundary-snapshot-convention');
  }

  for (const field of ['open', 'high', 'low', 'close']) {
    if (!fields.includes(field)) continue;
    const expected = edb[field];
    priceEvidence[field] = {
      edbValue: expected,
      presentInBarTicks: barTicks.some(tick => tick.lastPrice === expected),
      presentInBarMinutes: barMinutes.some(minute => (
        minute.open === expected
        || minute.high === expected
        || minute.low === expected
        || minute.close === expected
      )),
      previousTickMatches: previousTick?.lastPrice === expected,
      exactStartTickMatches: exactStartTick?.lastPrice === expected,
      exactEndTickMatches: exactEndTick?.lastPrice === expected,
    };
  }

  if (
    fields.includes('close')
    && exactEndTick?.lastPrice === edb.close
  ) {
    categories.add('bar-boundary-price-convention');
  }
  if (
    fields.includes('open')
    && exactStartTick?.lastPrice === edb.open
    && previousTick?.lastPrice === candidate.open
  ) {
    categories.add('bar-boundary-price-convention');
  }
  for (const field of ['high', 'low']) {
    if (!fields.includes(field)) continue;
    const evidence = priceEvidence[field];
    if (
      !evidence.presentInBarTicks
      && !evidence.presentInBarMinutes
      && !evidence.exactStartTickMatches
      && !evidence.exactEndTickMatches
    ) {
      categories.add('tick-source-price-difference');
    } else if (
      evidence.exactStartTickMatches
      || evidence.exactEndTickMatches
    ) {
      categories.add('bar-boundary-price-convention');
    }
  }

  const isSessionCloseBar = formatBeijing(startMs).endsWith('14:55:00');
  if (
    isSessionCloseBar
    && closeWindowEvidence
    && fields.some(field => ['volume', 'closeOi'].includes(field))
  ) {
    const comparisons = closeWindowEvidence.comparisons;
    const edbMatchesRawClose = (
      (!fields.includes('volume') || comparisons.edbVolumeMatchesCumulativeDelta)
      && (!fields.includes('closeOi') || comparisons.edbCloseOiMatchesExactClose)
    );
    if (edbMatchesRawClose) {
      categories.add('session-close-aggregation-rule');
    } else {
      categories.add('session-close-source-or-settlement-difference');
    }
  }

  if (
    fields.some(field => ['volume', 'openOi', 'closeOi'].includes(field))
    && ![...categories].some(category => (
      category.startsWith('session-close-')
      || category === 'near-boundary-snapshot-convention'
    ))
  ) {
    categories.add('tick-source-volume-open-interest-difference');
  }
  if (!categories.size) categories.add('unclassified-source-difference');

  return {
    categories: [...categories].sort(),
    tickEvidence: {
      barTickCount: barTicks.length,
      firstBarTick: compactTick(barTicks[0]),
      lastBarTick: compactTick(barTicks.at(-1)),
      previousTick: compactTick(previousTick),
      exactStartTick: compactTick(exactStartTick),
      exactEndTick: compactTick(exactEndTick),
    },
    priceEvidence,
    nearBoundarySnapshotEvidence,
  };
}

function compareBars(candidateBars, edbBars, ticks, minutes, closeWindowEvidence) {
  const edbByStart = new Map(edbBars.map(bar => [bar.startMs, bar]));
  const mismatches = [];
  for (const candidate of candidateBars) {
    const edb = edbByStart.get(candidate.startMs);
    if (!edb) {
      mismatches.push({
        start: candidate.start,
        fields: ['missingEdbBar'],
        candidate,
        edb: null,
        evidence: { categories: ['missing-reference-bar'] },
      });
      continue;
    }
    const fields = BAR_FIELDS.filter(
      field => candidate[field] !== edb[field],
    );
    if (!fields.length) continue;
    mismatches.push({
      start: candidate.start,
      fields,
      candidate: Object.fromEntries(fields.map(field => [field, candidate[field]])),
      edb: Object.fromEntries(fields.map(field => [field, edb[field]])),
      evidence: classifyMismatchEvidence({
        fields,
        candidate,
        edb,
        startMs: candidate.startMs,
        endMs: candidate.endMs,
        ticks,
        minutes,
        closeWindowEvidence,
      }),
    });
  }
  const candidateStarts = new Set(candidateBars.map(bar => bar.startMs));
  for (const edb of edbBars) {
    if (!candidateStarts.has(edb.startMs)) {
      mismatches.push({
        start: edb.start,
        fields: ['missingCandidateBar'],
        candidate: null,
        edb,
        evidence: { categories: ['missing-candidate-bar'] },
      });
    }
  }
  return mismatches.sort((left, right) => left.start.localeCompare(right.start));
}

function compareBarFields(candidateBars, edbBars) {
  const edbByStart = new Map(edbBars.map(bar => [bar.startMs, bar]));
  const mismatches = [];
  for (const candidate of candidateBars) {
    const edb = edbByStart.get(candidate.startMs);
    if (!edb) {
      mismatches.push({
        start: candidate.start,
        fields: ['missingEdbBar'],
      });
      continue;
    }
    const fields = BAR_FIELDS.filter(
      field => candidate[field] !== edb[field],
    );
    if (fields.length) {
      mismatches.push({
        start: candidate.start,
        fields,
      });
    }
  }
  const candidateStarts = new Set(candidateBars.map(bar => bar.startMs));
  for (const edb of edbBars) {
    if (!candidateStarts.has(edb.startMs)) {
      mismatches.push({
        start: edb.start,
        fields: ['missingCandidateBar'],
      });
    }
  }
  return mismatches.sort((left, right) => left.start.localeCompare(right.start));
}

function mismatchRowKey(mismatch) {
  return `${mismatch.tradingDate ?? ''}|${mismatch.start}`;
}

function mismatchFieldKeys(mismatches) {
  return new Set(mismatches.flatMap(mismatch => (
    mismatch.fields.map(field => `${mismatchRowKey(mismatch)}|${field}`)
  )));
}

function mismatchFieldCounts(mismatches) {
  const counts = {};
  for (const mismatch of mismatches) {
    for (const field of mismatch.fields) {
      counts[field] = (counts[field] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function setDifferenceSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (!right.has(value)) count += 1;
  }
  return count;
}

function setIntersectionSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

export function summarizeTimestampOffsetMatrix(evaluations) {
  const zero = evaluations.find(evaluation => evaluation.offsetMs === 0);
  assert(zero, 'timestamp offset matrix requires a 0ms evaluation');
  const zeroRows = new Set(zero.mismatches.map(mismatchRowKey));
  const zeroFields = mismatchFieldKeys(zero.mismatches);
  const summaries = evaluations.map(evaluation => {
    const rows = new Set(evaluation.mismatches.map(mismatchRowKey));
    const fields = mismatchFieldKeys(evaluation.mismatches);
    const fieldMismatchCounts = mismatchFieldCounts(evaluation.mismatches);
    const fieldMismatchCount = Object.values(fieldMismatchCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    const repairedOriginalRows = setDifferenceSize(zeroRows, rows);
    const introducedRows = setDifferenceSize(rows, zeroRows);
    const repairedOriginalFieldMismatches = setDifferenceSize(
      zeroFields,
      fields,
    );
    const introducedFieldMismatches = setDifferenceSize(fields, zeroFields);
    return {
      offsetMs: evaluation.offsetMs,
      mismatchRows: rows.size,
      fieldMismatchCount,
      repairedOriginalRows,
      introducedRows,
      remainingOriginalRows: setIntersectionSize(zeroRows, rows),
      repairedOriginalFieldMismatches,
      introducedFieldMismatches,
      remainingOriginalFieldMismatches: setIntersectionSize(zeroFields, fields),
      fieldMismatchCounts,
      shiftedTicks: evaluation.shiftedTicks ?? null,
      retainedAtSessionBoundaryTicks: (
        evaluation.retainedAtSessionBoundaryTicks ?? null
      ),
      eligibleAsGlobalFixedOffset: (
        evaluation.offsetMs !== 0
        && fieldMismatchCount < zeroFields.size
        && introducedFieldMismatches === 0
      ),
    };
  });
  const ranked = [...summaries].sort((left, right) => (
    left.fieldMismatchCount - right.fieldMismatchCount
    || left.mismatchRows - right.mismatchRows
    || left.introducedFieldMismatches - right.introducedFieldMismatches
    || Math.abs(left.offsetMs) - Math.abs(right.offsetMs)
    || left.offsetMs - right.offsetMs
  ));
  const best = ranked[0];
  return {
    offsetsMs: summaries.map(summary => summary.offsetMs),
    evaluations: summaries,
    bestOffsetMs: best.offsetMs,
    zeroOffsetRemainsBest: best.offsetMs === 0,
    fixedTimestampOffsetSupported: (
      best.offsetMs !== 0 && best.eligibleAsGlobalFixedOffset
    ),
  };
}

function evaluateTimestampOffsets({
  offsetsMs,
  selectedDates,
  extracted,
  edbBarsByDate,
}) {
  const overallEvaluations = [];
  const dateEvaluations = new Map(
    selectedDates.map(tradingDate => [tradingDate, []]),
  );
  for (const offsetMs of offsetsMs) {
    const shiftedByDate = new Map();
    for (const [tradingDate, record] of extracted) {
      const shifted = shiftTicksForDiagnostic(record.parsed.ticks, offsetMs);
      const minutes = ticksToMinutes(shifted.ticks);
      shiftedByDate.set(tradingDate, {
        bars5: aggregateMinutes(minutes, 5).map(enrichBar),
        shiftedTicks: shifted.shiftedTicks,
        retainedAtSessionBoundary: shifted.retainedAtSessionBoundary,
      });
    }
    const allMismatches = [];
    let shiftedTicks = 0;
    let retainedAtSessionBoundaryTicks = 0;
    for (const tradingDate of selectedDates) {
      const current = extracted.get(tradingDate);
      const previous = extracted.get(current.previousTradingDate);
      const shiftedCurrent = shiftedByDate.get(tradingDate);
      const shiftedPrevious = shiftedByDate.get(current.previousTradingDate);
      assert(
        previous && shiftedCurrent && shiftedPrevious,
        `${tradingDate} missing shifted calibration context`,
      );
      const candidateBars = normalizeTargetRecord(
        {
          tradingDate: previous.tradingDate,
          contract: previous.contract,
          bars5: shiftedPrevious.bars5,
        },
        {
          tradingDate: current.tradingDate,
          contract: current.contract,
          bars5: shiftedCurrent.bars5,
        },
      );
      const mismatches = compareBarFields(
        candidateBars,
        edbBarsByDate.get(tradingDate) ?? [],
      ).map(mismatch => ({
        tradingDate,
        ...mismatch,
      }));
      allMismatches.push(...mismatches);
      shiftedTicks += shiftedCurrent.shiftedTicks;
      retainedAtSessionBoundaryTicks += (
        shiftedCurrent.retainedAtSessionBoundary
      );
      dateEvaluations.get(tradingDate).push({
        offsetMs,
        mismatches,
        shiftedTicks: shiftedCurrent.shiftedTicks,
        retainedAtSessionBoundaryTicks: (
          shiftedCurrent.retainedAtSessionBoundary
        ),
      });
    }
    overallEvaluations.push({
      offsetMs,
      mismatches: allMismatches,
      shiftedTicks,
      retainedAtSessionBoundaryTicks,
    });
  }
  return {
    overall: summarizeTimestampOffsetMatrix(overallEvaluations),
    dates: new Map([...dateEvaluations].map(([tradingDate, evaluations]) => [
      tradingDate,
      summarizeTimestampOffsetMatrix(evaluations),
    ])),
  };
}

function categoryCounts(mismatches) {
  const counts = {};
  for (const mismatch of mismatches) {
    for (const category of mismatch.evidence.categories) {
      counts[category] = (counts[category] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function allTradingDates(sourceContext) {
  return [...new Set(
    sourceContext.analyses.flatMap(analysis => analysis.tradingDates),
  )].sort();
}

function previousTradingDate(sourceContext, tradingDate) {
  const dates = allTradingDates(sourceContext);
  const index = dates.indexOf(tradingDate);
  assert(index >= 0, `${tradingDate} 不在已扫描 ModelScope 交易日中`);
  assert(index > 0, `${tradingDate} 缺少前一交易日`);
  return dates[index - 1];
}

async function extractDailyEvidence(sourceContext, instrument, tradingDate) {
  const mapping = sourceContext.mappingSummary.mappingByKey.get(
    `${tradingDate}|${instrument.id}`,
  );
  assert(
    mapping?.status === 'mapped' && mapping.concreteEntry,
    `${tradingDate} 缺少${instrument.name}唯一具体主力映射`,
  );
  const archiveContext = sourceContext.archiveByTradingDate.get(tradingDate);
  assert(archiveContext, `${tradingDate} 缺少 ModelScope 归档上下文`);
  const previousDate = previousTradingDate(sourceContext, tradingDate);
  const raw = await extractEntry(archiveContext.archive, mapping.concreteEntry);
  const parsed = parseTickCsv(raw, {
    entryName: mapping.concreteEntry.name,
    tradingDate,
    previousTradingDate: previousDate,
    contract: mapping.contract,
    exchange: instrument.exchange,
  });
  const minutes = ticksToMinutes(parsed.ticks);
  const bars5 = aggregateMinutes(minutes, 5).map(enrichBar);
  return {
    tradingDate,
    previousTradingDate: previousDate,
    contract: mapping.contract,
    mapping,
    archive: archiveContext.archive,
    raw,
    rawDecoded: decodeRawTickRows(raw),
    parsed,
    minutes,
    bars5,
  };
}

function jsonValue(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path, value) {
  await writeFile(path, jsonValue(value), 'utf8');
}

function normalizeTargetRecord(previous, current) {
  const normalized = normalizeDailyRecordContinuity([
    {
      tradingDate: previous.tradingDate,
      contract: previous.contract,
      bars5: previous.bars5,
    },
    {
      tradingDate: current.tradingDate,
      contract: current.contract,
      bars5: current.bars5,
    },
  ]);
  return normalized[1].bars5;
}

function summarizeConclusion(mismatches) {
  const counts = categoryCounts(mismatches);
  const aggregationRows = mismatches.filter(mismatch => (
    mismatch.evidence.categories.some(category => (
      category === 'bar-boundary-price-convention'
      || category === 'near-boundary-snapshot-convention'
      || category === 'session-close-aggregation-rule'
    ))
  ));
  const sourceRows = mismatches.filter(mismatch => (
    mismatch.evidence.categories.some(category => (
      category.includes('source')
      || category.includes('settlement')
    ))
  ));
  return {
    categoryCounts: counts,
    aggregationRuleEvidenceRows: aggregationRows.length,
    nearBoundarySnapshotConventionRows: (
      counts['near-boundary-snapshot-convention'] ?? 0
    ),
    sourceDifferenceEvidenceRows: sourceRows.length,
    definiteSessionCloseAggregationError: (
      (counts['session-close-aggregation-rule'] ?? 0) > 0
    ),
    strictCalibrationShouldRemainBlocked: mismatches.length > 0,
    recommendedAction: (
      (counts['session-close-aggregation-rule'] ?? 0) > 0
        ? '存在 EDB 值可由原始闭市 Tick 直接复现、但当前聚合未复现的证据；应先修复并补测试。'
        : '未发现可直接证明的闭市聚合错误；保持零容差失败，不得激活候选基线。'
    ),
  };
}

export async function generateCalibrationDiagnostics(options) {
  const firstDate = options.dates[0];
  const lastDate = options.dates.at(-1);
  const sourceOptions = {
    probe: options.probe,
    instrumentIds: [options.instrumentId],
    start: firstDate,
    end: lastDate,
    output: options.output,
    repositoryRoot: options.repositoryRoot,
    temporaryRoot: options.temporaryRoot,
    requireThreeYearCoverage: false,
  };
  const sourceContext = await prepareSourceContext(sourceOptions, {
    onProgress: message => console.log(message),
  });
  const definition = INSTRUMENT_LIST.find(
    instrument => instrument.id === options.instrumentId,
  );
  const sourceInstrument = INSTRUMENTS.find(
    instrument => instrument.id === options.instrumentId,
  );
  assert(definition && sourceInstrument, `缺少品种定义：${options.instrumentId}`);
  const edb = await readEdbBaseline(options.repositoryRoot, definition);
  const edbBarsByDate = groupBarsByTradingDate(edb.bars5);
  const extracted = new Map();

  const datesToExtract = new Set(options.dates);
  for (const tradingDate of options.dates) {
    datesToExtract.add(previousTradingDate(sourceContext, tradingDate));
  }
  for (const tradingDate of [...datesToExtract].sort()) {
    console.log(`抽取诊断 Tick：${tradingDate}`);
    extracted.set(
      tradingDate,
      await extractDailyEvidence(sourceContext, sourceInstrument, tradingDate),
    );
  }
  const timestampOffsetDiagnostics = evaluateTimestampOffsets({
    offsetsMs: options.timestampOffsetsMs ?? DEFAULT_TIMESTAMP_OFFSETS_MS,
    selectedDates: options.dates,
    extracted,
    edbBarsByDate,
  });

  const parent = dirname(options.output);
  const staging = join(
    parent,
    `.staging-${basename(options.output)}-${randomUUID()}`,
  );
  await mkdir(parent, { recursive: true });
  await mkdir(staging, { recursive: false });
  const dateSummaries = [];
  const allMismatches = [];
  try {
    for (const tradingDate of options.dates) {
      const current = extracted.get(tradingDate);
      const previous = extracted.get(current.previousTradingDate);
      assert(previous, `${tradingDate} 缺少前一交易日诊断记录`);
      const candidateBars = normalizeTargetRecord(previous, current);
      const edbBars = edbBarsByDate.get(tradingDate) ?? [];
      assert(edbBars.length > 0, `${tradingDate} 缺少 EDB 5 分钟 K 线`);
      const closeWindowEvidence = buildCloseWindowEvidence(
        current.rawDecoded.rows,
        current.parsed.ticks,
        candidateBars,
        edbBars,
      );
      const mismatches = compareBars(
        candidateBars,
        edbBars,
        current.parsed.ticks,
        current.minutes,
        closeWindowEvidence,
      );
      const directory = join(staging, tradingDate);
      await mkdir(directory, { recursive: false });
      const dateTimestampOffsetDiagnostics = (
        timestampOffsetDiagnostics.dates.get(tradingDate)
      );
      await Promise.all([
        writeFile(join(directory, 'raw-source.csv'), current.raw),
        writeJson(join(directory, 'raw-close-window.json'), {
          fields: current.rawDecoded.fields,
          previousRawRow: closeWindowEvidence.previousRawRow,
          rows: closeWindowEvidence.closeWindowRows,
        }),
        writeJson(
          join(directory, 'parsed-ticks.json'),
          current.parsed.ticks.map(enrichTick),
        ),
        writeJson(
          join(directory, 'minutes.json'),
          current.minutes.map(enrichMinute),
        ),
        writeJson(join(directory, 'bars5-modelscope.json'), candidateBars),
        writeJson(join(directory, 'bars5-edb.json'), edbBars),
        writeJson(join(directory, 'bar-mismatches.json'), mismatches),
        writeJson(join(directory, 'close-window-evidence.json'), closeWindowEvidence),
        writeJson(
          join(directory, 'timestamp-offset-matrix.json'),
          dateTimestampOffsetDiagnostics,
        ),
      ]);
      const summary = {
        tradingDate,
        previousTradingDate: current.previousTradingDate,
        contract: current.contract,
        archive: {
          path: current.archive.path,
          sha256: current.archive.pointer.sha256,
          size: current.archive.pointer.size,
        },
        entry: {
          name: current.mapping.concreteEntry.name,
          crc32: current.mapping.concreteEntry.crc32Hex,
          compressedBytes: current.mapping.concreteEntry.compressedSize,
          uncompressedBytes: current.mapping.concreteEntry.uncompressedSize,
        },
        raw: {
          bytes: current.raw.length,
          sha256: sha256(current.raw),
          sourceRows: current.parsed.stats.sourceRows,
        },
        parseStats: current.parsed.stats,
        minuteRecords: current.minutes.length,
        candidateBars5: candidateBars.length,
        edbBars5: edbBars.length,
        mismatchRows: mismatches.length,
        timestampOffsetDiagnostics: dateTimestampOffsetDiagnostics,
        conclusion: summarizeConclusion(mismatches),
      };
      await writeJson(join(directory, 'summary.json'), summary);
      dateSummaries.push(summary);
      allMismatches.push(...mismatches.map(mismatch => ({
        tradingDate,
        ...mismatch,
      })));
    }

    const overallConclusion = summarizeConclusion(allMismatches);
    const report = {
      schemaVersion: 2,
      purpose: 'modelscope-edb-calibration-root-cause-diagnostics',
      generatedAt: new Date().toISOString(),
      source: {
        repositoryId: REPOSITORY.id,
        commit: REPOSITORY.commit,
        probe: options.probe,
      },
      instrument: {
        id: sourceInstrument.id,
        name: sourceInstrument.name,
      },
      selectedTradingDates: options.dates,
      totals: {
        dates: dateSummaries.length,
        rawBytes: dateSummaries.reduce(
          (sum, summary) => sum + summary.raw.bytes,
          0,
        ),
        parsedTicks: dateSummaries.reduce(
          (sum, summary) => sum + summary.parseStats.acceptedTicks,
          0,
        ),
        candidateBars5: dateSummaries.reduce(
          (sum, summary) => sum + summary.candidateBars5,
          0,
        ),
        edbBars5: dateSummaries.reduce(
          (sum, summary) => sum + summary.edbBars5,
          0,
        ),
        mismatchRows: allMismatches.length,
        fieldMismatches: allMismatches.reduce(
          (sum, mismatch) => sum + mismatch.fields.length,
          0,
        ),
      },
      dates: dateSummaries,
      timestampOffsetDiagnostics: timestampOffsetDiagnostics.overall,
      conclusion: overallConclusion,
      releaseDecision: {
        numericTolerance: 0,
        strictCalibrationPreserved: true,
        redistributionPermissionConfirmed: false,
        baselineReplacementAllowed: false,
        releaseEligible: false,
      },
    };
    await writeJson(
      join(staging, 'timestamp-offset-matrix.json'),
      timestampOffsetDiagnostics.overall,
    );
    await writeJson(join(staging, 'summary.json'), report);
    await atomicReplaceDirectory(staging, options.output);
    return report;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseDiagnosticArguments(argv);
  const instrument = INSTRUMENTS.find(
    candidate => candidate.id === options.instrumentId,
  );
  assert(instrument, `未知品种：${options.instrumentId}`);
  console.log(
    `诊断${instrument.name} ModelScope/EDB 校准：${options.dates.join(', ')}`,
  );
  const report = await generateCalibrationDiagnostics(options);
  console.log(
    `诊断完成：${report.totals.mismatchRows} 条代表差异，输出 ${options.output}`,
  );
  console.log(report.conclusion.recommendedAction);
  return report;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
