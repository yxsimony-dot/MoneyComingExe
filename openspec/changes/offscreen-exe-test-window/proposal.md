## Why

当前 Electron 与打包 EXE 的自动化验收会把应用窗口显示在可见屏幕区域，容易遮挡用户正在进行的工作。测试仍需保持真实窗口渲染和交互，因此需要统一把测试窗口放到所有显示器范围之外。

## What Changes

- 为自动化测试启动的 MoneyComing Electron/EXE 窗口增加统一的屏幕外定位行为。
- 根据当前所有显示器的联合边界计算位置，保证整个测试窗口与任意显示器均不相交。
- 在窗口首次可见之前完成定位，并覆盖开发态 Electron、打包 EXE、性能测试和快捷方式启动验收。
- 保持正常用户启动的窗口位置和显示行为不变。
- 不限制测试窗口是否抢占焦点、是否显示任务栏图标或采用何种可见状态；唯一强制约束是窗口完全位于所有显示器范围之外。

## Capabilities

### New Capabilities

- `offscreen-exe-testing`: 定义自动化 GUI/EXE 测试窗口的屏幕外定位、适用范围和正常启动隔离要求。

### Modified Capabilities

无。

## Impact

- 受影响区域包括 Electron 主进程的测试启动路径、Playwright/Electron 烟雾测试、性能测试和 Windows 快捷方式验收脚本。
- 可能增加一个共享测试窗口定位助手，以及供非 Playwright 启动路径使用的测试专用启动标记。
- 不改变产品功能、用户配置、公开 API、发布格式或运行时依赖。
