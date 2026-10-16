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
      expect(text).toContain('不再以“触发K线及后续15根”为分析上限');
      expect(text).toContain('不得跨到下一交易日期或另一交易时段');
      expect(text).toContain('14:40或22:40开始的K线仍可产生真正入场');
      expect(text).toContain('14:45或22:45开始及之后的K线禁止新入场');
      expect(text).toContain('到15:00或23:00始终没有真正入场');
      expect(text).toContain('以该根5分钟K线收盘价生成唯一的“休市出场”');
      expect(text).toContain('初始5分钟视口仍只使用触发附近最多16根的紧凑范围');
      expect(text).toContain('第一根收盘价严格高于开盘价的上涨K线');
      expect(text).toContain('第一根收盘价严格低于开盘价的下跌K线');
      expect(text).toContain('到该上涨K线为止（包括该上涨K线）所有K线的最低价');
      expect(text).toContain('到该下跌K线为止（包括该下跌K线）所有K线的最高价');
      expect(text).toContain('若首次反应K线自身产生该极值，红框的左右边界都落在该首次反应K线上');
      expect(text).toContain('rangeTicks = round((最高价 - 最低价) / tick)');
      expect(text).toContain('quarterTicks = ceil(rangeTicks / 4)');
      expect(text).toContain('最低价3020、最高价3031');
      expect(text).toContain('多头白线为3023，空头白线为3028');
      expect(text).toContain('真正入场搜索从首次方向反应K线的下一根5分钟K线开始');
      expect(text).toContain('low <= 白线价格 <= high');
      expect(text).toContain('只把按时间顺序第一根合格触碰白线的K线标记为“入场”');
      expect(text).toContain('等于或晚于截止时间的触碰只保留观察含义，不算真正入场');
      expect(text).toContain('回调触发 -> 首次方向反应范围 -> 四分之一白线首次合格触碰即真正入场');
      expect(text).toContain('60分钟突破、回调事件、数量、所属K线和原标记位置不因5分钟真正入场结果而改变');
      expect(text).toContain('立即同时得到白色入场指标线和明黄色计划止损线');
      expect(text).toContain('stopTicks = ceil(rangeTicks × 0.75)');
      expect(text).toContain('最低价 - stopTicks × tick');
      expect(text).toContain('最高价 + stopTicks × tick');
      expect(text).toContain('多头止损为3011，空头止损为3040');
      expect(text).toContain('#f4c95d');
      expect(text).toContain('从红框左边界对应的5分钟K线开始绘制，并延伸到本次生命周期终点');
      expect(text).toContain('黄色线不参与价格轴自动缩放');
      expect(text).toContain('实际止损出场价固定取计划止损线价格');
      expect(text).toContain('首次方向反应红框形成后立即显示默认计划止盈线');
      expect(text).toContain('没有真正入场时不检测风险侧、止盈或止损');
      expect(text).toContain('targetTicks = rangeTicks × 2');
      expect(text).toContain('最高价 + targetTicks × tick');
      expect(text).toContain('最低价 - targetTicks × tick');
      expect(text).toContain('多头默认止盈为3053，空头默认止盈为2998');
      expect(text).toContain('后台1分钟数据');
      expect(text).toContain('不显示1分钟图表、周期按钮或可见数据面板');
      expect(text).toContain('恰好对应5根唯一、连续、有序的1分钟K线');
      expect(text).toContain('只对该根使用5分钟保守规则');
      expect(text).toContain('下一根5分钟K线重新独立验证');
      expect(text).toContain('第一根触碰白色入场线的1分钟K线开始持仓检测');
      expect(text).toContain('该分钟之前发生的风险侧、止盈或止损触碰全部忽略');
      expect(text).toContain('多头首次满足 `low <= 红框最低价` 为触底');
      expect(text).toContain('空头首次满足 `high >= 红框最高价` 为触顶');
      expect(text).toContain('后续重复触碰不再调整目标');
      expect(text).toContain('同一根5分钟K线内较晚分钟再触及调整后止盈价');
      expect(text).toContain('入场与止损同单元发生则确认入场后立即止损');
      expect(text).toContain('持仓后止损与任何其他事件同单元发生时止损优先');
      expect(text).toContain('首次风险侧与止盈同单元且没有止损时只调整目标');
      expect(text).toContain('实际止盈出场价固定取触发时有效的计划止盈线价格');
      expect(text).toContain('只记录第一处“止盈出场”“止损出场”或“休市出场”');
      expect(text).toContain('随后立即结束本次生命周期');
      expect(text).toContain('完整1分钟证据优先');
      expect(text).toContain('止盈或止损优先于休市出场');
      expect(text).toContain('只保留“止损出场”');
      expect(text).toContain('#4fc3f7');
      expect(text).toContain('2像素亮蓝色阶梯实线');
      expect(text).toContain('止盈线与止损线共用生命周期终点');
      expect(text).toContain('均截止到终点5分钟K线并包含该根');
      expect(text).toContain('白色四分之一入场指标线');
      expect(text).toContain('实际止盈、止损或休市出场后立即停止');
      expect(text).toContain('都使用同一个生命周期终点');
      expect(text).toContain('数据暂未覆盖生命周期终点');
      expect(text).toContain('旧的方向标记、辅助线、风险侧标记、出场标记和生命周期诊断一并清除');
      expect(text).not.toContain('不包含止盈规则');
      expect(text).not.toContain('不依据该范围新增、删除或移动自动入场信号');
      expect(text).not.toContain('本次不判断实际止损触发');
      expect(text).not.toContain('本次不判断实际止盈触发');
    }
  });
});
