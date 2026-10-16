## 1. 数据模型与换月识别

- [x] 1.1 在共享类型中增加换月记录、快照 schema 2 文件元数据、Dataset 和更新候选所需字段，并通过 `npm run typecheck` 验证类型接口一致
- [x] 1.2 新增换月 CSV 解析与序列化逻辑，校验交易日、时间、旧合约和新合约，并用单元测试覆盖空文件、重复记录、乱序记录和非法合约
- [x] 1.3 新增主连日线与受控具体合约日线的解析、六字段唯一匹配和相邻交易日换月识别，并用固定样例验证 `m2601 -> m2605`、`m2605 -> m2609`、`m2609 -> m2701`
- [x] 1.4 新增从前一交易日 15:00:00 后定位首根 5 分钟 K 线以及映射 60 分钟目标 K 线的逻辑，并覆盖夜盘、周末和无夜盘场景测试

## 2. EDB 更新链路

- [x] 2.1 扩展 EDB 客户端以请求主连日线和内部生成的具体合约日线，保持固定 endpoint、method、header 和 symbol 白名单，并补充请求参数测试
- [x] 2.2 将换月识别接入行情更新协调器，使价格或换月映射任一变化都触发保存，任一校验失败都不保存，并通过协调器测试验证状态和计数
- [x] 2.3 在更新流程中限制候选合约范围和请求失败行为，确保 renderer/IPC 不能传入任意 symbol、URL 或 header，并运行网络策略测试

## 3. 快照 schema 2 与内置数据

- [x] 3.1 将内置换月记录写入 `futures_investigation_20261009/edb_main_continuous_rollovers.csv`，并纳入应用打包 extraFiles
- [x] 3.2 将用户快照升级为 schema 2，原子写入并哈希校验换月文件，扩展回退、清理和指纹逻辑，并覆盖 schema 1 兼容测试
- [x] 3.3 更新发布校验脚本，要求安装包 data 目录包含换月 CSV，并验证 `npm run verify:release` 的资源检查

## 4. Renderer 换月标记

- [x] 4.1 将 Dataset 换月记录传入 5 分钟和 60 分钟 MarketChart，合并独立换月 marker 与已有 marker 并按时间排序
- [x] 4.2 让换月 marker 始终可见且在两个周期使用醒目颜色、文本和诊断属性，补充 renderer smoke test 所需的计数、标签和起始时间
- [x] 4.3 更新行情成功后重新加载并立即刷新两个图表，更新状态文案明确价格与换月映射一并校验

## 5. 集成验证

- [x] 5.1 运行 `npm run typecheck` 和 `npm test`，修复数据、快照、更新协调器及 renderer 单元测试问题
- [x] 5.2 运行 `npm run build`、`npm run test:market-update` 和 `npm run test:app`，确认开发与打包路径都能加载换月文件
- [x] 5.3 运行 `openspec validate main-contract-rollover-markers --strict`，并用桌面端检查 1440x900 与 1100x720 下两周期换月文字可见且无严重遮挡
