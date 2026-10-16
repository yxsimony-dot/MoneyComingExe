# github-release-publishing Specification

## Purpose

建立从受控 Git 版本标签到公开 GitHub Release 的可重复发布契约，确保每个正式版本都包含可安装的 Windows 包和自动更新所需元数据，并通过质量与安全校验。

## Requirements

### Requirement: 正式发布由版本标签触发
发布系统 SHALL 仅在符合 `v<semver>` 格式的版本标签被推送时启动正式 Release 流程，普通分支 push 不得直接发布客户端更新。

#### Scenario: 推送正式版本标签
- **WHEN** 仓库收到例如 `v1.0.1` 的有效版本标签
- **THEN** 发布系统启动对应版本的 Windows 构建和 Release 流程

#### Scenario: 推送普通提交
- **WHEN** 新提交被推送到 `main` 但没有正式版本标签
- **THEN** 发布系统不得创建面向客户端的正式 GitHub Release

### Requirement: 标签与应用版本一致
发布系统 SHALL 验证 Git 标签版本、应用清单版本和生成的安装包版本完全一致，不一致时必须终止发布。

#### Scenario: 版本一致
- **WHEN** 标签为 `v1.0.1` 且应用清单版本为 `1.0.1`
- **THEN** 发布流程允许继续生成版本 `1.0.1` 的产物

#### Scenario: 版本不一致
- **WHEN** 标签版本与应用清单版本不同
- **THEN** 发布流程失败且不得创建不一致的正式 Release

### Requirement: 发布前必须通过质量门禁
发布系统 SHALL 在上传正式产物前完成依赖安装、类型检查、自动化测试、生产构建和安装包冒烟验证，任一必要检查失败时不得发布。

#### Scenario: 所有检查通过
- **WHEN** 版本标签构建的全部必要检查成功
- **THEN** 发布流程继续创建并上传 Release 产物

#### Scenario: 任一检查失败
- **WHEN** 类型检查、测试、构建或安装包验证中的任一环节失败
- **THEN** 发布流程以失败结束且不得发布部分可见的正式版本

### Requirement: Release 包含完整更新产物
每个正式 Release SHALL 至少包含 Windows NSIS 安装包、自动更新描述文件以及增量或完整性校验所需文件，且不得包含 ZIP 便携版。

#### Scenario: 正式 Release 创建完成
- **WHEN** 一个版本成功发布
- **THEN** Release 资源足以让旧安装版发现、下载并安装该版本

#### Scenario: 检测到 ZIP 便携版
- **WHEN** 发布候选产物中出现 MoneyComing ZIP 便携包
- **THEN** 发布验收失败并阻止其作为正式分发产物上传

### Requirement: 更新资源允许匿名读取
正式 Release 及其更新资源 SHALL 可由未登录 GitHub 的客户端通过 HTTPS 匿名读取。

#### Scenario: 匿名客户端访问更新元数据
- **WHEN** 未携带 GitHub 身份凭据的客户端请求最新版本元数据
- **THEN** 服务返回可读取的稳定版本信息和下载地址

#### Scenario: 仓库或 Release 不可公开读取
- **WHEN** 发布验收发现更新资源需要登录或私人令牌
- **THEN** 该版本不得被标记为可供客户端使用的正式更新

### Requirement: 发布凭据不得进入客户端
发布系统 SHALL 仅在受控 CI 环境中使用发布权限，并且不得将 GitHub Actions 凭据、个人访问令牌或其他发布密钥写入源码、构建产物或更新元数据。

#### Scenario: CI 创建 Release
- **WHEN** 发布工作流需要向 GitHub 上传产物
- **THEN** 它只使用工作流运行期提供的最小必要权限

#### Scenario: 检查安装包内容
- **WHEN** 对正式安装包和应用资源执行凭据扫描
- **THEN** 其中不存在可用于写入仓库或 Release 的秘密凭据

### Requirement: 发布失败不得覆盖已有稳定版本
发布系统 SHALL 在新版本完整通过验证前保留已有最新稳定 Release 及其更新元数据的可用性。

#### Scenario: 新版本构建失败
- **WHEN** 新标签的构建或上传过程失败
- **THEN** 已安装客户端继续看到并使用此前最后一个成功发布的稳定版本

#### Scenario: 同版本重复发布
- **WHEN** 已存在相同版本的正式 Release 或标签
- **THEN** 发布流程拒绝静默覆盖已有版本
