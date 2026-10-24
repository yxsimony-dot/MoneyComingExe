import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUMENT_IDS } from '../src/shared/instruments';
import {
  authoritativeSha256,
  buildAuthoritativeResultsBaseline,
  compareAuthoritativeResults,
  stableAuthoritativeJson,
  type AuthoritativeResultsBaseline,
} from './helpers/authoritative-results';

const BASELINE_PATH = resolve(
  'tests',
  'fixtures',
  'instrument-switch-authoritative-baseline.json',
);
const ACCEPTANCE_REPORT_PATH = resolve(
  'artifacts',
  'instrument-switch-authoritative-acceptance.json',
);
const UPDATE_BASELINE = process.env.UPDATE_AUTHORITATIVE_BASELINE === '1';
const VERIFY_CURRENT = process.env.VERIFY_AUTHORITATIVE_RESULTS === '1';

async function readBaseline(): Promise<AuthoritativeResultsBaseline> {
  return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as AuthoritativeResultsBaseline;
}

function cloneBaseline(
  baseline: AuthoritativeResultsBaseline,
): AuthoritativeResultsBaseline {
  return JSON.parse(JSON.stringify(baseline)) as AuthoritativeResultsBaseline;
}

if (UPDATE_BASELINE) {
  describe('authoritative results baseline generator', () => {
    it('captures all real instruments one at a time', async () => {
      const baseline = await buildAuthoritativeResultsBaseline({
        onInstrument(instrument, index, total) {
          console.log(`[authoritative] ${index + 1}/${total} ${instrument}`);
        },
      });
      await mkdir(dirname(BASELINE_PATH), { recursive: true });
      await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
      expect(Object.keys(baseline.instruments)).toEqual([...INSTRUMENT_IDS]);
    }, 15 * 60_000);
  });
} else {
  describe('authoritative results baseline', () => {
    it('covers all fifteen instruments and exposes audit-friendly summaries', async () => {
      const baseline = await readBaseline();

      expect(baseline.schemaVersion).toBe(1);
      expect(Object.keys(baseline.instruments)).toEqual([...INSTRUMENT_IDS]);
      for (const instrument of INSTRUMENT_IDS) {
        const summary = baseline.instruments[instrument];
        expect(summary.instrument).toBe(instrument);
        expect(summary.market.bars5.count).toBeGreaterThan(0);
        expect(summary.market.bars60.count).toBeGreaterThan(0);
        expect(summary.market.bars5.first).toEqual(expect.any(String));
        expect(summary.market.bars5.last).toEqual(expect.any(String));
        expect(summary.strategy.entries.count).toBeGreaterThanOrEqual(0);
        expect(summary.strategy.lifecycles.count).toBe(summary.strategy.entries.count);
        expect(summary.profitLoss.statistics.completedTradeCount).toBe(
          summary.profitLoss.completedTrades.count,
        );
        expect(summary.profitLoss.statistics.incompleteTradeCount).toBe(
          summary.profitLoss.incompleteTrades.count,
        );
        expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it('normalizes object keys and omitted fields deterministically', () => {
      const left = {
        z: 3,
        nested: { b: 2, omitted: undefined, a: 1 },
      };
      const right = {
        nested: { a: 1, b: 2 },
        z: 3,
      };

      expect(stableAuthoritativeJson(left)).toBe(stableAuthoritativeJson(right));
      expect(authoritativeSha256(left)).toBe(authoritativeSha256(right));
    });

    it('reports a changed K-line record count at its exact path', async () => {
      const baseline = await readBaseline();
      const changed = cloneBaseline(baseline);
      changed.instruments.main_continuous.market.bars5.count += 1;

      expect(compareAuthoritativeResults(baseline, changed)).toContainEqual({
        path: '$.instruments.main_continuous.market.bars5.count',
        kind: 'value',
        expected: baseline.instruments.main_continuous.market.bars5.count,
        actual: changed.instruments.main_continuous.market.bars5.count,
      });
    });

    it('detects any K-line or lifecycle field change through normalized hashes', async () => {
      const baseline = await readBaseline();
      const changed = cloneBaseline(baseline);
      const originalBarHash = authoritativeSha256([
        { startMs: 1, high: 101, close: 100 },
      ]);
      const changedBarHash = authoritativeSha256([
        { startMs: 1, high: 101, close: 99 },
      ]);
      const originalLifecycleHash = authoritativeSha256([
        { sourceIndex: 0, lifecycle: { endReason: 'take-profit' } },
      ]);
      const changedLifecycleHash = authoritativeSha256([
        { sourceIndex: 0, lifecycle: { endReason: 'stop-loss' } },
      ]);
      expect(changedBarHash).not.toBe(originalBarHash);
      expect(changedLifecycleHash).not.toBe(originalLifecycleHash);

      changed.instruments.main_continuous.market.bars5.sha256 = changedBarHash;
      changed.instruments.main_continuous.strategy.lifecycles.sha256 = changedLifecycleHash;
      const paths = compareAuthoritativeResults(baseline, changed)
        .map(difference => difference.path);

      expect(paths).toContain(
        '$.instruments.main_continuous.market.bars5.sha256',
      );
      expect(paths).toContain(
        '$.instruments.main_continuous.strategy.lifecycles.sha256',
      );
    });

    it('reports a changed final capital at its exact path', async () => {
      const baseline = await readBaseline();
      const changed = cloneBaseline(baseline);
      changed.instruments.main_continuous.profitLoss.finalCapital += 1;

      expect(compareAuthoritativeResults(baseline, changed)).toContainEqual({
        path: '$.instruments.main_continuous.profitLoss.finalCapital',
        kind: 'value',
        expected: baseline.instruments.main_continuous.profitLoss.finalCapital,
        actual: changed.instruments.main_continuous.profitLoss.finalCapital,
      });
    });

    (VERIFY_CURRENT ? it : it.skip)(
      'matches all current real instruments against the pre-optimization baseline',
      async () => {
        const baseline = await readBaseline();
        const current = await buildAuthoritativeResultsBaseline({
          onInstrument(instrument, index, total) {
            console.log(`[authoritative acceptance] ${index + 1}/${total} ${instrument}`);
          },
        });
        const differences = compareAuthoritativeResults(baseline, current);
        const report = {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          passed: differences.length === 0,
          baselinePath: BASELINE_PATH,
          instrumentCount: Object.keys(current.instruments).length,
          differences,
        };
        await mkdir(dirname(ACCEPTANCE_REPORT_PATH), { recursive: true });
        await writeFile(
          ACCEPTANCE_REPORT_PATH,
          `${JSON.stringify(report, null, 2)}\n`,
        );

        expect(Object.keys(current.instruments)).toEqual([...INSTRUMENT_IDS]);
        expect(differences).toEqual([]);
      },
      15 * 60_000,
    );
  });
}
