## 1. 共享设置与价格计算

- [x] 1.1 在 `EntryStrategySettings` 中增加止损百分比和默认止盈百分比的边界、默认值、5%步长校验，并补充默认值、合法边界、非5倍数及越界单元测试；运行 `npm test -- tests/weekly-entry.test.ts` 验证
- [x] 1.2 让止损价格使用当前止损百分比按整数tick向红框外侧取整，覆盖多空镜像、0%、300%、精确整除和非整除测试；运行 `npm test -- tests/weekly-entry.test.ts` 验证
- [x] 1.3 让默认止盈价格使用当前默认止盈百分比按整数tick向红框外侧取整，同时保持风险侧特殊止盈固定在红框另一侧，覆盖多空镜像、0%、500%及风险侧触碰测试；运行 `npm test -- tests/weekly-entry.test.ts` 验证
- [x] 1.4 增加基于当前入场线、止损和默认止盈百分比的理论默认盈亏比计算，并覆盖默认2.75:1、参数变化和零风险不可计算测试；运行 `npm test -- tests/weekly-entry.test.ts` 验证

## 2. 生命周期与全盘复盘

- [x] 2.1 将完整共享设置传入首轮、第二轮和所有图表生命周期止盈止损计算点，确保两轮使用各自红框且风险侧与分钟事件优先级不变；运行 `npm test -- tests/weekly-entry.test.ts` 验证
- [x] 2.2 更新全盘盈亏复盘，使实际出场、事件排序、手数、现金盈亏、资金曲线、统计和最终资金统一使用当前止盈止损参数；运行 `npm test -- tests/profit-loss-review.test.ts` 验证
- [x] 2.3 增加图表生命周期与复盘一致性回归用例，覆盖参数导致出场类型或时间变化、两轮交易及风险侧调整止盈；运行 `npm test -- tests/weekly-entry.test.ts tests/profit-loss-review.test.ts` 验证

## 3. 设置界面、持久化与实时刷新

- [x] 3.1 在现有策略设置面板加入“止损距离”和“默认止盈距离”紧凑步进控件以及只读理论默认盈亏比，并调整响应式样式确保窄窗口无重叠；运行 `node tests/strategy-settings-smoke.mjs` 验证控件范围、5%步长、边界和布局
- [x] 3.2 扩展现有本地设置加载与保存逻辑，按字段恢复有效值，并让缺失或无效的新字段分别回退75%和200%而不重置其他参数；运行 `node tests/strategy-settings-smoke.mjs` 验证旧设置升级、单字段损坏和重启恢复
- [x] 3.3 将两个参数接入统一策略刷新入口，保持当前选择与缩放并同步更新图表线段、标记、盈利摘要和已打开的“盈亏情况”；运行 `node tests/strategy-settings-smoke.mjs` 和 `node tests/entry-marker-smoke.mjs` 验证
- [x] 3.4 为根元素及图表诊断状态补充当前参数、计划价格和理论比值的稳定可测输出，并更新相关GUI断言确保参数修改后没有旧价格或旧复盘结果残留；运行 `node tests/strategy-settings-smoke.mjs` 验证

## 4. 规则说明

- [x] 4.1 更新 `src/shared/entry-rules.ts` 与 `futures_investigation_20261009/entry-rules.md`，写明参数范围、默认值、5%步长、多空公式、向外tick取整、两轮共用、实时重算、理论默认盈亏比和风险侧特殊止盈边界；运行规则一致性相关单元测试并人工比对两份文字
- [x] 4.2 更新应用内说明和测试断言，确认完整入场规则包含止盈止损参数，而5分钟方向反应识别说明仍只展示其原有识别内容；运行 `npm test` 和 `node tests/strategy-settings-smoke.mjs` 验证

## 5. 集成与离屏验收

- [x] 5.1 运行 `npm run typecheck`、`npm test` 和 `npm run build`，修复所有类型、领域、复盘和构建回归
- [x] 5.2 使用 `tests/electron-test-launch.mjs` 运行相关Electron冒烟测试，验证默认参数、实时重算、理论比值、弹窗同步及窄窗口布局，并确认窗口首次显示前位于所有显示器矩形之外
- [x] 5.3 运行 `npm run package` 生成最新版安装包和EXE，再以 `--test-window-offscreen` 启动打包EXE，读取实际窗口边界确认与所有显示器均无面积交集，并验收止盈止损线、出场标记和盈亏结果
- [x] 5.4 运行 `openspec validate configurable-take-profit-stop-loss --strict`，确认实现完成后变更规格仍严格有效
