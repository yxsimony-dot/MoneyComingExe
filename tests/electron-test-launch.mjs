import { _electron as electron } from 'playwright';

export const OFFSCREEN_TEST_ARGUMENT = '--test-window-offscreen';
export const OFFSCREEN_TEST_ENVIRONMENT_VARIABLE = 'MONEYCOMING_TEST_WINDOW_OFFSCREEN';

export function electronTestLaunchOptions(options = {}) {
  const args = Array.isArray(options.args) ? [...options.args] : [];
  if (!args.includes(OFFSCREEN_TEST_ARGUMENT)) args.push(OFFSCREEN_TEST_ARGUMENT);

  return {
    ...options,
    args,
    env: {
      ...(options.env ?? process.env),
      [OFFSCREEN_TEST_ENVIRONMENT_VARIABLE]: '1',
    },
  };
}

export function launchElectronTest(options = {}) {
  return electron.launch(electronTestLaunchOptions(options));
}
