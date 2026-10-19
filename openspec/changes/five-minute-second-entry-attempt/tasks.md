## 1. 领域生命周期

- [x] 1.1 在 `src/domain/weekly-entry.ts` 引入最多两个有序轮次的生命周期结果，并把现有首轮计算整理为可复用的单轮构造流程；运行 `npm test -- tests/weekly-entry.test.ts` 验证既有首轮范围、入场、止盈、止损和休市规则保持通过
- [x] 1.2 实现首轮实际出场后从下一根5分钟K线开始的二次触发扫描，覆盖多头下沿、空头上沿、影线等值/穿越、出场K线排除及触发K线参与方向反应搜索；在 `tests/weekly-entry.test.ts` 增加多空镜像断言并运行该测试文件
- [x] 1.3 实现第二轮包含式红框、既有交易公式复用、范围形成后锁定、入场截止、数据末尾和最多两轮终止；增加第二轮未入场、第二笔未出场、第二笔实际出场及禁止第三轮测试并运行 `npm test -- tests/weekly-entry.test.ts`
- [x] 1.4 将首轮和第二轮方向反应门槛统一为实体至少2个tick，确保1个tick的同方向K线被跳过但仍参与包含式极值统计；补充单位tick、非单位tick及多空镜像测试并运行 `npm test -- tests/weekly-entry.test.ts`

## 2. 五分钟图表

- [x] 2.1 将5分钟图表选择状态和诊断数据改为携带有序轮次，并为两轮分别维护红框覆盖层及白色、黄色、亮蓝色计划线系列；运行 `npm run typecheck` 验证渲染类型和领域结构一致
- [x] 2.2 让绿色动态回调线和方向观察标记延伸到整体生命周期终点，同时让首轮与第二轮计划线分别终止于各自终点；扩展 `tests/entry-marker-smoke.mjs` 并离屏运行，验证两轮线段不跨区间错误连接且不会扩大初始视口
- [x] 2.3 在二次触发K线上添加中性灰色“二次触发”标记，按多头下方、空头上方放置，并保留两轮入场、风险侧和出场标记且不绘制边界延长线；离屏运行 `node tests/entry-marker-smoke.mjs` 验证标记文字、位置、唯一id和数量
- [x] 2.4 更新事件切换、数据集切换、回到最新和清除选择的清理逻辑，使两轮覆盖层、线段、标记和诊断属性均不残留；扩展并运行 `node tests/entry-marker-smoke.mjs` 与 `npm run test:app` 验证状态切换

## 3. 盈亏复盘

- [x] 3.1 修改 `src/domain/profit-loss-review.ts`，把每个生命周期内真正入场的轮次展开为唯一交易事件，并保留当前全量资金、十倍杠杆及手续费/滑点口径；在 `tests/profit-loss-review.test.ts` 验证第二笔交易使用包含第一笔已实现盈亏的资金
- [x] 3.2 将第二笔已完成或未完成交易纳入逐笔列表、交易次数、出场类型、胜负、资金曲线和汇总统计，同时忽略只有二次触发或红框但未真正入场的轮次；运行 `npm test -- tests/profit-loss-review.test.ts` 和 `npm run test:app` 验证计算与界面展示

## 4. 规则说明

- [x] 4.1 更新 `futures_investigation_20261009/entry-rules.md` 和应用内入场规则内容，写明二次观察开启条件、风险侧触发、多空镜像、第二轮范围、搜索起点、最多两轮及复盘计入方式；运行 `npm test -- tests/entry-rules.test.ts` 验证规则文档被正确打包和展示
- [x] 4.2 在外部和应用内入场规则中写明方向反应K线至少2个tick、1个tick不算反应但继续参与极值统计，并运行 `npm test -- tests/entry-rules.test.ts`

## 5. 集成验证与打包

- [x] 5.1 运行 `npm test`、`npm run typecheck` 和 `npm run build`，修复所有领域、复盘、渲染及构建回归并确认全部通过
- [x] 5.2 按 `AGENTS.md` 要求通过 `tests/electron-test-launch.mjs` 离屏运行 `node tests/entry-marker-smoke.mjs` 与 `npm run test:app`，验证自动化窗口完整位于所有显示器之外且两轮图表行为通过
- [x] 5.3 运行 `npm run package` 生成最新安装版，确认 `release` 仅保留当前版本产物，并通过 `npm run test:offscreen-window` 或带 `--test-window-offscreen` 的直接EXE验证检查实际窗口与所有显示器无面积交集
- [x] 5.4 重新运行完整测试、类型检查、构建和打包，确认 `release` 仅保留当前版本产物，并按 `AGENTS.md` 离屏验证最新EXE窗口与所有显示器无面积交集
