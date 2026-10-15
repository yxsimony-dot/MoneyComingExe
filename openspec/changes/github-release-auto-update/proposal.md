## Why

MoneyComing 当前通过手工生成和分发 ZIP 目录包，已安装用户无法感知 GitHub 上的新版本，也无法在应用内完成下载和升级。需要建立以 GitHub Releases 为发布源的 Windows 安装版更新链路，让版本迭代可被用户可靠发现、下载和安装。

## What Changes

- 将 Windows 正式分发形式改为 NSIS 安装包，并使安装后的应用具备检查、下载和安装新版本的能力。
- 应用启动后自动检查一次更新，并提供手动检查入口；网络不可用或更新服务异常不得阻止离线看盘功能启动和使用。
- 发现新版本时展示版本信息，由用户确认下载；下载完成后由用户确认重启并安装，不实施无提示强制更新。
- 使用带语义化版本号的 Git 标签触发 GitHub Actions 构建和发布 GitHub Release，普通分支 push 不直接向用户发布更新。
- 发布流程生成 NSIS 安装包及自动更新所需的版本元数据，并验证 Release 资源可被未登录用户匿名读取。
- **BREAKING**：停止生成和发布 ZIP 便携版；已有 ZIP 用户必须手动安装一次 NSIS 版本，之后才能进入自动更新链路。
- 不在客户端、仓库文件或安装包中嵌入 GitHub Token、个人访问令牌或其他发布凭据。

## Capabilities

### New Capabilities

- `desktop-auto-update`: 定义 Windows 安装版的版本检查、更新提示、下载进度、失败恢复、重启安装及离线兼容行为。
- `github-release-publishing`: 定义版本标签驱动的 Windows 构建、GitHub Release 发布、更新元数据和匿名下载验收行为。

### Modified Capabilities

无。

## Impact

- Electron 主进程将新增更新服务，并通过受限 IPC 向预加载层和渲染层暴露更新状态及用户操作。
- Windows 打包目标将由目录包调整为 NSIS 安装包，新增自动更新运行时依赖及发布配置。
- GitHub 仓库将新增 Windows 发布工作流，并使用 GitHub Actions 提供的短期凭据创建 Release。
- 应用界面、共享类型、自动化测试、README 和使用说明将增加版本与更新相关内容。
- 正式发布需要维护 `package.json` 版本号与 `v<version>` Git 标签的一致性。
