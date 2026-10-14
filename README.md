# MoneyComing

Windows 豆粕离线历史行情查看器，默认左侧60分钟、右侧5分钟。支持豆粕主连与M2701、成交量和持仓、光标读数、区间联动、每个北京时间周一开始连续8根60分钟线的金色高亮、日期定位及已知异常提示。数据快照截至2026-10-09。

“周一8根标记”默认关闭，开启后同时显示前8根金色高亮，以及第9根起逐次创出周内新高的蓝色上箭头、新低的紫色下箭头。影线越界即触发，边界随突破更新，相等不触发，每周重置；悬停显示原边界与新边界。

60分钟主图常显浅白色EMA20，使用收盘价、α=2/21、首根收盘价初始化，跨周连续递推；光标显示对应值，5分钟图不添加。副图和周一标记开关不影响EMA20。

开启“周一8根标记”后，60分钟图还显示基于5分钟先后顺序确认的回调入场标记：绿色“多”和珊瑚色“空”。反向突破取消旧方向；同一5分钟内既突破又触线时跳过不确定入场。工具栏“入场规则”读取 `data/entry-rules.md` 并在应用内展示，修改文字不改变程序算法。该功能只用于离线历史复盘，不执行交易。

## 使用

完整解压 `release/MoneyComing-win-x64.zip`，进入 MoneyComing 目录，双击 MoneyComing.exe。不要单独移动EXE。详见 [使用说明](docs/使用说明.md)。用户无需安装 Node.js 或 Python。

## 开发和验证

在 Windows x64、Node.js 22 环境执行：

```powershell
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

Electron运行时安装步骤需要联网，打包后的应用看盘无需联网。

```powershell
npm test
npm run test:app
npm run package -- --config.electronDist=node_modules/electron/dist
$env:MONEYCOMING_EXE = (Resolve-Path release/win-unpacked/MoneyComing.exe).Path
npm run test:app
node tests/performance.mjs
node tests/portable-smoke.mjs
```

应用验收会启动窗口并生成 artifacts 下的截图及JSON记录；便携验收只在复制的程序目录暂移CSV，finally中恢复。性能记录包含机器环境和测量口径。开发应用从 futures_investigation_20261009 读取数据，正式EXE从自身同级 data 读取，不依赖启动工作目录。

## 结构

- src/main：Electron窗口、本地协议、只读数据服务。
- src/preload：隔离的白名单IPC接口。
- src/domain：严格CSV解析、北京时间、包含区间匹配。
- src/renderer：本地静态界面和Lightweight Charts。
- openspec/changes/offline-futures-viewer：提案、规格、设计及验收任务。

四份原始CSV保持不变。60分钟按交易分钟累计，日盘末段为45分钟；源数据异常保留并显示说明。本项目没有交易、实时行情或回测功能。
