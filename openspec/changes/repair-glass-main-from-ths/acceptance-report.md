# glass_main 同花顺基准修复验收报告

验收日期：2026-10-24
OpenSpec 变更：`repair-glass-main-from-ths`

## 验收结论

`glass_main` 同花顺 `FG9999` 5 分钟基准修复、60 分钟重建、主力映射校准、EDB 在线尾部接续和双周期 GUI 回归均通过。受保护历史在完整补齐和分钟收盘轮询前后保持不变，同花顺原始数据及修复快照仅存在于当前用户 AppData，未进入仓库数据或发布资源。

## 修复范围与快照

- 修复运行 ID：`20261024040129127-bfa4028a`
- 5/60 分钟保护范围：`2021-10-18 09:00:00` 至 `2026-10-22 15:00:00`
- 主力映射保护范围：`2021-10-18` 至 `2026-10-22`
- 换月保护范围：`2021-12-10` 至 `2026-08-19`
- 修复激活快照 ID：`20261024040129127-d6faa0a2`
- EDB 完整补齐后的最终快照 ID：`20261024042722017-e93b2353`
- 修复前回滚快照 ID：`20261023052746863-183bf2ca`
- 最终报告 SHA-256：`93b5a10676b89adfc1719302b332c1a3714549a8f3725996c7b47a6a921ddfa9`

最终快照包含 1 分钟 1,605 根、5 分钟 83,157 根、60 分钟 8,451 根、映射 1,217 条和换月 16 条，最新数据时间为 `2026-10-23 15:00:00`。

## 保护不变性

完整补齐前后，保护范围的记录数与 SHA-256 均完全一致：

| 数据 | 保护记录数 | SHA-256 |
| --- | ---: | --- |
| 1 分钟 | 1,260 | `f760884660836e7284aca8c61ae4454177093eadc6c342b715c5f30c17a581d6` |
| 5 分钟 | 83,088 | `ff7d94e77a225f39210d3e88c9a29b6e9d8515bda29d900bddae6932215a7a10` |
| 60 分钟 | 8,444 | `9230174c400f019f2c4bffb62c0e37a14a2031c8f6c7947c1f1c5864e810e837` |
| 主力映射 | 1,216 | `faada95113f71cc127d4b273775e564e391e7e13b93b8e80ad8be44df3bb936e` |
| 换月记录 | 15 | `9b86c18881117f8f6b548e10ba48348feaf0610c72de49072a2afdcff4e2d2f5` |

## 在线接续

- EDB 完整补齐结果为 `succeeded`，先将 `localMinuteLatestAt` 更新到与 `sourceLatestAt` 相同的 `2026-10-23 15:00:00`，再进入 `waiting`。
- 完整补齐仅在保护边界后新增 1 分钟 345 根、5 分钟 69 根、60 分钟 7 根和换月 1 条，没有替换或删除保护数据。
- 下一分钟收盘后的尾部轮询结果为 `up-to-date`，新增、替换和删除数量均为 0，在线状态继续保持 `waiting`。

## GUI 与离屏验收

- 可见周期仅为 `dual`、`5` 和 `60`，没有可见 1 分钟入口。
- 双周期视图保留历史定位日期 `2023-08-09`；5 分钟和 60 分钟图表尺寸均为 `682 x 316`，各有 15 个已绘制 canvas。
- Electron 验收通过 `tests/electron-test-launch.mjs` 的 `launchElectronTest()` 启动。
- 窗口在首次显示前、显示后和关闭前均位于 `(1984, 0, 1440, 900)`，与两个显示器矩形均无面积交集。
- 页面错误数量为 0。

## 自动化验证

- `npm run typecheck`：通过。
- `npm test`：53 个测试文件通过，829 个测试通过，1 个跳过，用时 348.21 秒。
- `npm run data:audit`：通过。
- `npm run data:validate`：15 个品种全部通过。
- `npm run build`：通过。
- 同花顺发布隔离审计：扫描 `data/`、`build/`、`dist/`、`release/` 共 261 个文件和 53 个 JSON，全部通过。
- `npm run verify:security`：扫描 358 个文件，通过。
- `npm run verify:release`：现有 `1.0.9` 安装包通过。
- OpenSpec 验证：通过。

## 验收证据

- 真实在线验收记录：`artifacts/glass-main-real-online-acceptance.json`
- 离屏 GUI 截图：`artifacts/glass-main-real-online-acceptance.png`
- 激活报告：`%APPDATA%/MoneyComing/market-data/repairs/glass_main/20261024040129127-bfa4028a/reports/activation.json`
