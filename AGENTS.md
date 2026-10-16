# 项目开发规则

## 自动化 GUI/EXE 测试窗口

- 所有自动化 Electron、打包 EXE、安装版和快捷方式 GUI 测试，必须让窗口的完整矩形位于所有已连接显示器矩形之外。
- 窗口必须在首次显示前完成离屏定位，禁止先显示在屏幕内再移动。
- JavaScript GUI 测试必须通过 `tests/electron-test-launch.mjs` 的 `launchElectronTest()` 启动，禁止直接调用 Playwright 的 `electron.launch()`。
- 直接启动 EXE 或快捷方式的测试必须追加 `--test-window-offscreen`，并读取实际窗口边界验证其与所有显示器均无面积交集。
- 测试可以抢焦点，也可以显示任务栏图标；本规则只约束窗口几何位置。
- 普通开发启动、安装版用户启动和用户快捷方式不得自动使用测试专用离屏位置。
