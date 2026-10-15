# MoneyComing

Windows 豆粕主连离线历史行情查看器，默认左侧60分钟、右侧5分钟。支持成交量和持仓、光标读数、区间联动、每个北京时间周一开始连续8根60分钟线的金色高亮、日期定位及数据审计信息。安装包内置基线截至2026-10-09，运行后可按需增量更新。

“周一8根标记”默认关闭，开启后同时显示前8根金色高亮，以及第9根起逐次创出周内新高的蓝色上箭头、新低的紫色下箭头。影线越界即触发，边界随突破更新，相等不触发，每周重置；悬停显示原边界与新边界。

60分钟主图常显浅白色EMA20，使用收盘价、α=2/21、首根收盘价初始化，跨周连续递推；光标显示对应值，5分钟图不添加。副图和周一标记开关不影响EMA20。

开启“周一8根标记”后，60分钟图还显示基于5分钟先后顺序确认的回调入场标记：绿色“多”和珊瑚色“空”。反向突破取消旧方向；同一5分钟内既突破又触线时跳过不确定入场。工具栏“入场规则”读取 `data/entry-rules.md` 并在应用内展示，修改文字不改变程序算法。该功能只用于离线历史复盘，不执行交易。

## 使用

从 GitHub Releases 下载 `MoneyComing-Setup-<版本>-x64.exe`，运行安装程序并按提示选择安装目录。安装完成后可从桌面或开始菜单启动 MoneyComing；用户无需安装 Node.js 或 Python。详见 [使用说明](docs/使用说明.md)。

正式安装版会在界面可用后后台检查一次更新，也可点击右上角版本号手动检查。发现新版本后，只有用户选择“立即下载”才会下载，只有选择“重启安装”才会退出并安装。检查或下载失败不会影响本地行情、图表和规则说明。

工具栏“更新行情”只增量更新 EDB 提供的豆粕主连历史数据，不是实时行情连接。EDB 可能尚未发布当天数据，界面会以“数据源最新至 YYYY-MM-DD HH:mm”显示实际截止时间。更新成功后，版本化快照写入用户 AppData；下载、校验或保存失败时继续使用此前有效快照，安装新版本也不会用较旧的内置基线覆盖它。“最新”按钮是独立的图表跳转操作，只回到当前本地快照的末尾，不会发起行情更新。

旧 ZIP 版不会自动迁移。已有用户需要手动安装一次首个 NSIS 版本，之后才可使用应用内更新。当前构建可能尚未签名，Windows SmartScreen 出现“未知发布者”时，请确认安装包来自本仓库的正式 GitHub Release。

## 开发和验证

在 Windows x64、Node.js 22 环境执行：

```powershell
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

Electron运行时安装步骤需要联网。打包后的应用可离线看盘；手动更新行情和检查应用版本需要联网。

```powershell
npm test
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

应用验收会启动窗口并生成 artifacts 下的截图及 JSON 记录；安装器验收会在隔离临时目录静默安装、从非项目工作目录启动并卸载。性能记录包含机器环境和测量口径。开发应用从 `futures_investigation_20261009` 读取数据，正式 EXE 从安装目录同级 `data` 读取内置基线，不依赖启动工作目录。

正式发布只由与 `package.json` 版本一致的 `v<version>` 标签触发。维护步骤见 [发布流程](docs/发布流程.md)。

## 结构

- src/main：Electron窗口、本地协议、只读数据服务。
- src/preload：隔离的白名单IPC接口。
- src/domain：严格CSV解析、北京时间、包含区间匹配。
- src/renderer：本地静态界面和Lightweight Charts。
- openspec/changes/offline-futures-viewer：提案、规格、设计及验收任务。

安装包内置的豆粕主连5分钟和60分钟CSV保持原值，增量更新只写入用户 AppData 快照。60分钟按交易分钟累计，日盘末段为45分钟。本项目没有交易、实时行情或回测功能。
