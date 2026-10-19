import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BASELINE_VALIDATION_REPORT_FILE,
  validateMarketBaselines,
} from './baseline-validator';

const output = resolve(process.argv[2] ?? 'data');
const temporaryUserData = await mkdtemp(join(tmpdir(), 'moneycoming-baseline-validation-'));

try {
  const report = await validateMarketBaselines({
    paths: {
      builtinDataDirectory: output,
      marketDataDirectory: temporaryUserData,
    },
    onProgress: definition => {
      console.log(JSON.stringify({
        instrumentId: definition.id,
        name: definition.name,
        phase: 'validating',
      }));
    },
  });
  await writeFile(
    join(output, BASELINE_VALIDATION_REPORT_FILE),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(temporaryUserData, { recursive: true, force: true });
}
