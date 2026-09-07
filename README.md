# Dockyard DSH

**A native account-pool and provider plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).**

[中文](#中文) · [English](#english)

> **Current status / 当前状态:** Developer preview · macOS / Windows / Linux 兼容（Windows 真机由 CI 矩阵验证）

## 中文

### Dockyard DSH 是什么

Dockyard DSH 把多个官方 OAuth / 官方客户端会话接入 DeepSeek Harness，提供一个统一的账号池、模型目录、额度状态和 provider-native 请求入口。它是 DSH 的原生 bundle/plugin，不需要另起一个代理网关，也不把 provider 逻辑塞进 DSH 核心。

当前包含的 provider 模块：

- **Codex** — 官方浏览器 OAuth、CLI fallback 和原生 Responses 请求链路。
- **Antigravity** — Google 官方浏览器 OAuth、官方本机会话、实时模型目录、额度/credits 和原生 Gemini SSE 请求链路。
- **Grok** — xAI 官方浏览器 OAuth、CLI fallback、实时模型目录、官方 Build credits 周期和 provider-native streaming 请求。额度读取使用官方 `/billing?format=credits`（转发 `GetGrokCreditsConfig`）；若上游只返回周期，剩余值保持未知。
- **Claude** — Claude 官方浏览器 OAuth（支持带 state 的手动回调地址/授权码）、CLI fallback 与原生请求适配。
- **Cursor** — Cursor 官方浏览器登录轮询、CLI fallback 与原生请求适配。

如果对应的官方客户端、CLI 或 OAuth 源没有安装、没有登录，Dockyard 会返回明确的 unavailable/degraded 状态；不会用硬编码的账号、模型、版本、套餐或额度伪造可用结果。

### 主要功能

- 在 DSH 内使用 `/dockyard` 命令管理账号和 provider。
- 点击“登录添加账号”直接打开 provider 官方浏览器授权页，选择账号并安全导入账号池；provider 不可用时保留 CLI fallback。
- 扫描本机已有的官方登录态；扫描和新增账号是两个独立操作，已有账号不会被“新增”静默重复导入。
- 支持手动选择、sticky session、round-robin 和 failover 账号池策略。
- 读取 provider 返回的实时模型目录、推理档位、套餐和额度窗口。
- 每个 provider 的每个凭据（API Key ref 或 OAuth 账号）都有独立的本地 Token 使用记录：累计总量、按天汇总和最近请求明细，跟随手动 / 轮询 / 失败转移的每次 Key 切换分别记账，可在弹窗中一键清空；记录只保存凭据引用，永不接触密钥明文。
- 所有命令、模型选择和 LLM 生成都读取同一个 Dockyard runtime，不维护第二套账号池或额度缓存。

### 平台支持：macOS 已发布，Windows 构建完成

**当前 0.1.1 版本整理中；插件本体跨平台（macOS / Windows / Linux），macOS 伴侣 App 已从本仓移除。**

macOS 完整功能依赖以下原生能力：

- 凭据存储使用 macOS Keychain 和 Swift helper。
- 浏览器 OAuth 由 DSH GUI 打开 provider 官方授权页面，并使用 PKCE、state 校验和 loopback/manual-code 回调；CLI fallback 才使用官方 CLI。
- 扫描模式仍可读取 Cursor、Antigravity 等 provider 的 macOS 官方桌面端或本机 CLI 会话状态。

Windows 版本已完成 EXE 构建，待上传到 v0.1.2 Release；上传完成后再进行发布页下载验证。

**DSH 插件（本仓库 dsh-oauth ≥ 0.1.1）的平台支持**：

- macOS：完整体验（Keychain 兜底存储 + 浏览器自动打开）。
- Windows / Linux：核心功能全部可用——模型目录、OAuth 授权（浏览器自动打开已支持 win32 `cmd /c start` 与 Linux `xdg-open`）、余额/额度探测、Key 池面板；凭证经 DSH Credentials（`~/.dsh/.credentials.yaml`）持久化。
- Cursor / Antigravity 桌面 App 凭证扫描为 macOS 专属，其他平台自动跳过并回退 env 等替代源。

