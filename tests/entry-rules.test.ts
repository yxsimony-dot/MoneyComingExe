import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTRY_RULES } from '../src/shared/entry-rules';

const normalizeNewlines = (value: string) => value.replace(/\r\n?/g, '\n').trim();
const externalRules = normalizeNewlines(
  readFileSync('futures_investigation_20261009/entry-rules.md', 'utf8'),
);

describe('entry rules', () => {
  it('keeps the editable file and built-in fallback aligned', () => {
    expect(normalizeNewlines(DEFAULT_ENTRY_RULES)).toBe(externalRules);
  });

  it('documents the quarter line and first true-entry touch consistently', () => {
    for (const text of [externalRules, DEFAULT_ENTRY_RULES]) {
      expect(text).toContain('触发K线及后续15根K线，最多共16根');
      expect(text).toContain('第一根收盘价严格高于开盘价的上涨K线');
      expect(text).toContain('第一根收盘价严格低于开盘价的下跌K线');
      expect(text).toContain('rangeTicks = round((最高价 - 最低价) / tick)');
      expect(text).toContain('quarterTicks = ceil(rangeTicks / 4)');
      expect(text).toContain('最低价3020、最高价3031');
      expect(text).toContain('多头白线为3023，空头白线为3028');
      expect(text).toContain('真正入场搜索从首次方向反应K线的下一根5分钟K线开始');
      expect(text).toContain('low <= 白线价格 <= high');
      expect(text).toContain('只把按时间顺序第一根触碰白线的K线标记为“入场”');
      expect(text).toContain('保留白线但不产生真正入场标记');
      expect(text).toContain('回调触发 -> 首次方向反应范围 -> 四分之一白线首次触碰即真正入场');
      expect(text).toContain('60分钟突破、回调事件、数量、所属K线和原标记位置不因5分钟真正入场结果而改变');
      expect(text).not.toContain('不依据该范围新增、删除或移动自动入场信号');
    }
  });
});
