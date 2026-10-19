## 1. 方向反应影线领域规则

- [x] 1.1 扩展 `EntryReactionRange` 与 `EntryQuarterSignal`，加入普通百分比和风险侧边界两种显式定价模式，并更新测试工厂；运行 `npm test -- tests/weekly-entry.test.ts` 验证现有正常候选仍使用配置百分比。
- [x] 1.2 将 `entryReactionRange()` 改为先应用“最小入场K线浮动”，再按多头上影线或空头下影线顺序判断小于2倍、2倍至3倍、3倍及以上三种结果；补充多空镜像、反方向影线忽略、正好2倍、正好3倍和无最终合格K线测试，并运行 `npm test -- tests/weekly-entry.test.ts`。
- [x] 1.3 保证因3倍影线被跳过的K线仍处于触发K线至最终反应K线的红框极值区间内，且最终合格K线继续提供盈利侧边界；补充被过滤多头K线产生最低价、空头K线产生最高价及触发K线自身被过滤测试，并运行 `npm test -- tests/weekly-entry.test.ts`。
- [x] 1.4 让 `entryQuarterSignal()` 在风险侧模式使用0 tick实际距离，在普通模式保持当前百分比与向上取整公式，同时不改写 `entryRangePercent`；补充0%、100%、非1 tick和2倍至3倍特殊入场价测试，并运行 `npm test -- tests/weekly-entry.test.ts`。

## 2. 生命周期与盈亏一致性

- [x] 2.1 让首轮和第二轮继续通过共享构造函数独立计算影线分类，并补充首轮普通、第二轮风险侧以及首轮被3倍过滤后继续搜索等完整生命周期测试；运行 `npm test -- tests/weekly-entry.test.ts` 验证最多仍只有两轮。
- [x] 2.2 补充方向影线规则改变反应K线或入场价后的止盈、止损、实际出场与一分钟优先判定回归测试；运行 `npm test -- tests/weekly-entry.test.ts` 验证既有出场公式和休市边界不变。
- [x] 2.3 扩展盈亏复盘夹具，断言直接生命周期和全盘复盘使用相同的反应K线、实际入场价、出场结果、手数和资金变化；运行 `npm test -- tests/profit-loss-review.test.ts`。

## 3. 紧凑识别规则界面

- [x] 3.1 在“最小入场K线浮动”标签旁增加小型信息图标按钮、悬浮提示和可访问名称，复用现有图标与紧凑控件样式；在窄窗口检查按钮不占用整组参数宽度且不与步进器或摘要重叠。
- [x] 3.2 新增独立“5分钟K线识别”弹窗及打开、关闭、遮罩关闭交互，每次打开时根据当前 `reactionBodyTicks` 生成仅包含实体门槛、方向侧影线、2倍至3倍覆盖、3倍过滤、极值参与和两轮适用的说明；通过渲染层测试标识验证不包含止盈、止损、休市和完整60分钟流程。
- [x] 3.3 扩展 `tests/strategy-settings-smoke.mjs`，使用 `launchElectronTest()` 验证信息按钮随设置面板显示和隐藏、tooltip、弹窗当前tick值、参数修改后重新打开的更新值、关闭交互及桌面窄宽度布局；运行 `node tests/strategy-settings-smoke.mjs` 并确认窗口全程离屏。

## 4. 完整规则文档

- [x] 4.1 更新 `futures_investigation_20261009/entry-rules.md`，在首轮与第二轮方向反应章节写明多空方向侧影线、包含式2倍和3倍边界、风险侧入场线、过滤后继续搜索及被过滤K线参与红框风险极值。
- [x] 4.2 同步更新 `src/shared/entry-rules.ts` 的内置回退文本，并扩展 `tests/entry-rules.test.ts` 检查三段行为、两轮适用和外部文件一致性；运行 `npm test -- tests/entry-rules.test.ts`。

## 5. 集成与发布验收

- [x] 5.1 运行 `npm run typecheck`、`npm test` 和 `npm run build`，修复所有类型、领域、规则和渲染回归，并确认不修改策略设置持久化结构。
- [x] 5.2 扩展或新增打包 EXE 的聚焦验收，启动时追加 `--test-window-offscreen`，读取实际窗口边界确认与所有显示器均无面积交集，并验证小型信息按钮、动态识别弹窗、完整规则回退及策略重算结果可用。
- [x] 5.3 运行 `npm run package` 生成最新安装产物，再执行相关 Electron 与打包 EXE 离屏测试，确认普通开发启动和用户安装启动不会自动使用测试专用离屏位置。
