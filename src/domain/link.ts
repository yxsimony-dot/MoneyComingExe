import type { Bar } from '../shared/types';
import { locateTime, lowerBoundStart } from './time';

export interface LogicalRange {
  from: number;
  to: number;
}

/** Real interval containment respects lunch breaks and 45-minute closing buckets. */
export function childrenFor(parent: Bar, bars5: Bar[]): Bar[] {
  const children: Bar[] = [];
  for (let index = lowerBoundStart(bars5, parent.startMs); index < bars5.length; index++) {
    const child = bars5[index];
    if (child.startMs >= parent.endMs) break;
    if (child.endMs <= parent.endMs) children.push(child);
  }
  return children;
}

export function parentFor(child: Bar, bars60: Bar[]): Bar | undefined {
  const parent = bars60[locateTime(bars60, child.startMs)];
  return parent && parent.startMs <= child.startMs && child.endMs <= parent.endMs ? parent : undefined;
}

export function linkedLogicalRange(
  sourceSpan: number,
  firstIndex: number,
  lastIndex: number,
  totalBars: number,
  margin = 4,
): LogicalRange | undefined {
  if (!Number.isFinite(sourceSpan) || !Number.isInteger(firstIndex) || !Number.isInteger(lastIndex)
    || !Number.isInteger(totalBars) || totalBars <= 0 || firstIndex < 0 || lastIndex < firstIndex
    || lastIndex >= totalBars || !Number.isFinite(margin) || margin < 0) return undefined;

  const childCount = lastIndex - firstIndex + 1;
  const targetSpan = Math.min(totalBars, Math.max(sourceSpan, childCount + margin));
  const center = (firstIndex + lastIndex) / 2;
  let from = center - targetSpan / 2;
  let to = from + targetSpan;

  if (from < 0) {
    to -= from;
    from = 0;
  }
  if (to > totalBars) {
    from -= to - totalBars;
    to = totalBars;
  }
  return { from: Math.max(0, from), to };
}
