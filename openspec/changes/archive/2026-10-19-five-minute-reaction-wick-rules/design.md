## Context

变更动机见 `proposal.md`，可验收行为见 `specs/five-minute-reaction-wick-rules/spec.md` 和 `specs/session-bounded-entry-lifecycle/spec.md`。

当前 `entryReactionRange()` 在候选5分钟K线实体达到 `reactionBodyTicks × tick` 后立即结束搜索，并用触发K线到该方向反应K线的包含区间计算红框风险侧极值。`entryQuarterSignal()` 再独立读取 `entryRangePercent` 计算白色入场价。首轮与第二轮都经过 `buildEntryLifecycleAttempt()` 调用这两个共享函数，全盘盈亏复盘也消费同一生命周期结果。

渲染层已有依附“周一8根标记”的策略设置面板、完整入场规则弹窗和统一策略重算流程。“最小入场K线浮动”目前只有文字标签与步进控件，完整规则同时存在于 `futures_investigation_20261009/entry-rules.md` 和 `src/shared/entry-rules.ts`。自动化 Electron、打包 EXE、安装版和快捷方式测试必须遵守项目规定的首次显示前离屏定位及窗口矩形无显示器交集规则。

## Goals / Non-Goals

**Goals:**

- 在共享领域搜索中一次性确定方向反应K线及其影线分类，让首轮、第二轮、图表和复盘消费同一结果。
- 保持被3倍影线过滤的K线处于红框风险侧极值统计区间内。
- 让2倍至3倍影线只覆盖当前轮次的实际入场价格，不修改用户保存的入场线百分比。
- 在现有策略设置中增加紧凑的信息入口，并根据当前最小浮动值生成独立识别说明。
- 保持现有生命周期、止盈止损、休市、第二轮和资金递推结构不变。

**Non-Goals:**

- 不增加新的可调影线倍数参数，不改变2倍和3倍边界。
- 不使用反方向影线、影线总长度或实体占整根K线比例参与判断。
- 不修改60分钟候选、回调触发、第二轮再次突破、止盈止损公式、出场优先级或最多两轮限制。
- 不修改 `reactionBodyTicks`、`entryRangePercent` 的存储格式、默认值或有效范围。
- 不把独立识别说明扩展为完整入场规则的第二份副本。

## Decisions

### 1. 在方向反应搜索结果中保存入场定价模式

为 `EntryReactionRange` 增加显式的入场定价模式，建议使用：

```ts
type EntryReactionPricingMode = 'configured-percent' | 'risk-edge';
```

`entryReactionRange()` 负责确定最终方向反应K线、红框范围和该模式。`entryQuarterSignal()` 只读取这个已确定的模式计算实际白线，不再重复计算影线比例。`EntryQuarterSignal` 同样保留该模式，便于测试、诊断和后续消费者解释实际价格来源。

`EntryQuarterSignal.entryRangePercent` 继续记录当前用户设置值；`entryDistanceTicks` 和 `price` 记录该轮实际采用的距离与价格。风险侧模式下，设置值仍保持原值，但实际距离为0 tick。这样既不会把一次特殊形态伪装成用户把参数调到0%，也不会让后续轮次继承覆盖状态。

备选方案是在 `entryQuarterSignal()` 中根据 `reactionBar` 重新判断影线。该方案会让反应搜索与价格计算分别持有规则，并增加首轮、第二轮或未来消费者出现分类分歧的风险，因此不采用。

### 2. 使用顺序扫描和乘法比较完成影线分段

`entryReactionRange()` 按时间顺序扫描可用K线。每根K线先计算方向实体并应用现有包含式最小浮动门槛：

```text
longBody  = close - open
shortBody = open - close
minimumBody = reactionBodyTicks * tick
```

只有实体达到门槛后才计算方向侧影线：

```text
longWick  = high - close
shortWick = close - low
```

判断直接使用乘法比较：

```text
wick < body * 2          -> configured-percent，接受并结束搜索
wick >= body * 2
  && wick < body * 3     -> risk-edge，接受并结束搜索
wick >= body * 3         -> 拒绝并继续搜索
```

最小浮动至少为1 tick，因此进入影线判断的方向实体必定大于0。使用乘法而不是 `wick / body` 可以避免除零和比值浮点误差，并使正好2倍、正好3倍的包含边界直接对应规格。

多头不读取下影线，空头不读取上影线。实体未达到门槛的K线沿用既有行为继续搜索，不产生影线分类。

### 3. 红框风险侧极值仍由完整包含区间计算

只有找到最终合格方向反应K线后，才从搜索起点到该K线构造包含两端的 `rangeBars`。因此所有较早K线，包括实体不足和因方向侧影线达到3倍而被过滤的K线，都会自然保留在风险侧极值计算中：

- 多头红框下沿取 `rangeBars` 最低价，上沿取最终方向反应K线最高价。
- 空头红框上沿取 `rangeBars` 最高价，下沿取最终方向反应K线最低价。

继续使用现有 `extremeBar` 表示风险侧极值所在K线，保证白线、止损线和图表线段起点的既有消费者不需要另建搜索区间。

备选方案是在扫描时只累计被3倍影线过滤的候选K线。该方案会漏掉实体不足但产生更极端风险价的K线，破坏当前红框“触发至最终反应K线完整区间”的含义，因此不采用。

### 4. 风险侧模式把实际入场距离设为0 tick

`entryQuarterSignal()` 继续先验证设置和红框范围，再按模式得到实际距离：

```text
configured-percent:
  entryDistanceTicks = ceil(rangeTicks * entryRangePercent / 100)

risk-edge:
  entryDistanceTicks = 0
```

价格仍由同一镜像公式生成：

```text
longPrice  = range.low + entryDistanceTicks * tick
shortPrice = range.high - entryDistanceTicks * tick
```

因此风险侧模式自然得到多头红框底部和空头红框顶部，且仍在tick网格上。真正入场搜索继续从最终方向反应K线的下一根5分钟K线开始，入场截止时间不变。

后续止损、止盈、风险侧触碰、实际出场、图表和盈亏复盘继续由共享生命周期构造。它们不另行重算影线或恢复用户百分比，而是消费该轮 `EntryReactionRange` 和 `EntryQuarterSignal` 的实际结果。

### 5. 两轮复用同一函数并保持分类独立

不在 `entryLifecycle()` 或 `findSecondAttemptTrigger()` 中增加影线特判。首轮和第二轮仍分别把各自的 `analysisBars` 交给 `buildEntryLifecycleAttempt()`，每次独立调用 `entryReactionRange()`。

这样第二轮从再次突破K线开始重新搜索，并根据第二轮最终方向反应K线独立产生定价模式。第一轮的分类只存在于第一轮 `reactionRange` 和 `quarterSignal` 中，不进入第二轮输入，也不产生第三轮。

### 6. 识别规则使用设置标签旁的小型信息按钮和独立弹窗

在“最小入场K线浮动”标签所在行加入复用现有信息图标的小型 icon button，并提供 `title`、`aria-label` 和稳定的测试标识。按钮属于设置面板，因此面板隐藏时自动一起隐藏，不改变设置值。

点击后打开独立 `dialog`，内容由渲染层的专用格式化函数生成。每次打开时读取当前 `entryStrategySettings.reactionBodyTicks`，显示当前N tick值以及多空实体、方向侧影线、2倍至3倍风险侧入场、3倍过滤、风险极值参与和两轮独立适用规则。弹窗不调用完整规则文件 IPC，也不显示60分钟、止盈止损、休市或资金复盘章节。

独立说明采用运行时生成而不是持久化文本，因为其中包含当前设置值；完整规则仍同步维护外部文件和 `DEFAULT_ENTRY_RULES`。这样动态摘要不会被外部规则文件的修改时间或加载失败状态影响。

备选方案是在现有“入场规则”弹窗内定位到一个章节。该方案不能满足只展示5分钟识别内容的要求，也会让设置旁的小入口打开过大的完整文档，因此不采用。

### 7. 测试按领域结果、消费者一致性和离屏界面分层

领域测试覆盖多空镜像、2倍和3倍精确边界、只读取方向侧影线、3倍过滤后继续搜索、被过滤K线产生风险侧极值、没有最终合格K线、风险侧0 tick入场价，以及首轮与第二轮分类不同的生命周期。

盈亏复盘测试使用会因影线规则改变候选K线或入场价的夹具，断言复盘交易与直接生命周期的反应K线、入场价和出场结果一致。规则测试同时检查外部规则和内置回退文本，并保持两份内容完全一致。

Electron 测试扩展 `tests/strategy-settings-smoke.mjs`，通过 `tests/electron-test-launch.mjs` 的 `launchElectronTest()` 验证小图标尺寸语义、悬浮提示、面板联动隐藏、独立弹窗内容和参数变化后的当前值。打包 EXE 验收追加 `--test-window-offscreen`，读取实际窗口边界并验证与全部显示器均无面积交集后，再检查内置规则和识别弹窗可用。

## Risks / Trade-offs

- [价格数据存在微小浮点噪声，使正好2倍或3倍的比较偏离] -> 规则计算只使用原始OHLC差值并采用乘法比较；用非1 tick品种和精确边界夹具覆盖，若数据源本身不在tick网格则沿用原始价格语义而不私自修正行情。
- [保留配置百分比但实际距离为0可能被调试信息误读] -> 增加显式定价模式，并把 `entryDistanceTicks` 作为实际距离；测试同时断言设置值未改变和实际价格已覆盖。
- [3倍过滤后搜索变长，红框范围可能明显扩大] -> 这是完整包含区间的预期行为；搜索仍受当前交易时段和入场截止规则约束，不跨时段。
- [策略设置区域增加图标后在窄窗口发生挤压] -> 图标使用稳定方形尺寸并与标签同行，允许现有设置组换行；离屏 Electron 测试覆盖窄窗口无重叠。
- [完整规则和独立说明文字漂移] -> 两者共享相同术语和边界测试断言，但独立说明保持短文本且只负责识别子规则；完整外部规则与内置回退继续由一致性测试锁定。
- [领域结果新增必填字段影响测试夹具和手工构造对象] -> 集中更新 `EntryReactionRange` 测试工厂；若兼容成本过高，可在过渡期提供明确默认值，但生产搜索结果必须始终显式赋值。

## Migration Plan

1. 扩展方向反应范围和白线信号的数据模型，先为现有正常候选填充 `configured-percent` 模式。
2. 将方向反应搜索改为实体门槛后的方向侧影线顺序扫描，并补齐多空与边界领域测试。
3. 让白线计算根据模式选择百分比距离或0 tick风险侧距离，再验证首轮、第二轮、出场和盈亏复盘一致性。
4. 在设置标签旁增加小型信息按钮、动态识别说明弹窗和对应样式。
5. 同步外部及内置完整入场规则，并扩展规则、Electron和打包EXE测试。
6. 运行类型检查、单元测试、构建及符合项目离屏窗口规范的GUI验收。

本变更不修改持久化设置结构和行情数据，无需用户数据迁移。回滚时可移除新增定价模式与识别弹窗，并恢复实体门槛后的首根方向K线和统一百分比入场计算。
