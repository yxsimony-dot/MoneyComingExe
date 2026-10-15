import { gt, valid } from 'semver';

export function normalizeVersion(version: string): string {
  return valid(version) ?? '0.0.0';
}

export function formatVersion(version: string): string {
  return `v${normalizeVersion(version)}`;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = valid(candidate);
  const installed = valid(current);
  return next !== null && installed !== null && gt(next, installed);
}
