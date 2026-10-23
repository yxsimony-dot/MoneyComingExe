# MoneyComing

Windows 多品种主连离线历史行情查看器。内置豆粕、菜粕、PVC、螺纹钢、玻璃、菜油、棕榈油、豆油、纸浆、玉米、纯碱、豆一、甲醇、白糖和豆二共 15 个主连品种，默认左侧 60 分钟、右侧 5 分钟。1 分钟数据仅用于后台聚合、完整性校验和精确事件顺序判断。

安装包基线的数据源最新时间为北京时间 `2026-10-16 23:00:00`。豆粕保留从 `2025-10-09 21:00:00` 开始的旧历史，其余品种保留 EDB 当次可取得的最长历史。应用支持当前品种更新和串行更新全部品种，更新后的分品种快照写入用户 AppData。

图表支持 EMA20、成交量和持仓、周期联动、日期定位、周一 8 根高亮、突破回调入场生命周期，以及“主力换月：旧合约 -> 新合约”标记。盈亏复盘使用 100 万元初始资金、10 倍理论名义杠杆、当前品种合约乘数和整数手数，不计手续费与滑点，也不执行真实交易。

## 使用

从 GitHub Releases 下载 `MoneyComing-Setup-<版本>-x64.exe`，安装后从桌面或开始菜单启动。用户无需安装 Node.js 或 Python。完整操作、数据口径和风险说明见 [使用说明](docs/使用说明.md)。

“更新行情”只更新当前品种，“更新全部品种”逐个处理全部 15 个品种。EDB 尚未发布当天完整数据时，界面以“数据源最新至 YYYY-MM-DD HH:mm”显示实际截止时间。下载、校验或保存失败不会破坏最后有效快照。

“最新”只把图表跳到本地数据末尾，不发起更新。品种选择器只列主连，不恢复豆粕 2701 等单一合约分支。界面只显示 5 分钟和 60 分钟周期。

正式安装版会在界面可用后后台检查应用版本，也可点击右上角版本号手动检查。当前构建若未签名，Windows SmartScreen 可能显示“未知发布者”，请确认安装包来自本仓库的正式 GitHub Release。

## 开发和验证

在 Windows x64、Node.js 22 环境执行：

```powershell
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

Electron 运行时安装步骤需要联网。开发和打包应用都从 `data/instruments/<instrument-id>` 读取内置基线；正式 EXE 不依赖启动工作目录。

```powershell
npm test
npm run test:offscreen-window
npm run test:update
npm run test:app
npm run package
npm run verify:release
npm run verify:security -- --require-artifacts
npm run test:installer
$env:MONEYCOMING_EXE = (Resolve-Path release/win-unpacked/MoneyComing.exe).Path
npm run test:app
node tests/performance.mjs
```

所有自动化 Electron、EXE、安装版和快捷方式测试必须在窗口首次显示前把完整窗口放到所有显示器之外。JavaScript 测试统一使用 `tests/electron-test-launch.mjs`，直接启动 EXE 或快捷方式时传入 `--test-window-offscreen` 并校验实际窗口边界。详细约束见根目录 `AGENTS.md`。

每次推送 `main` 后会自动构建、测试并发布更高版本的 NSIS Release。维护步骤见 [发布流程](docs/发布流程.md)。

## 结构

- `data/instruments`：15 个品种的内置 1/5/60 分钟基线、主力映射、换月和元数据。
- `src/main`：Electron 窗口、受控 EDB 请求、快照与更新协调。
- `src/preload`：隔离的白名单 IPC 接口。
- `src/domain`：严格 CSV 解析、北京时间、聚合、换月与盈亏领域逻辑。
- `src/renderer`：本地静态界面和 Lightweight Charts。
- `openspec/changes/add-multi-instrument-market-data`：本次多品种变更的规格、设计与任务。

本项目是本地历史复核工具，不提供实时推送、下单、实际保证金模拟或投资建议。
