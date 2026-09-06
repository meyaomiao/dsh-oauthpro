# 核心链路清单（R3b 回归用）

发版前全清单过一遍，包括本次没改的链路。发现新核心链路就补进来。

1. **模型目录**：Dockyard 面板打开 → 各 provider（含 openai-codex OAuth）模型列表加载；zai 显示 glm-5.x。
2. **API Key 凭证**：弹窗「+ 添加 Key」写入 → DSH Credentials 持久化 → 弹窗重开显示已配置；移除后回退未配置。
3. **实时额度刷新**：zai 刷新 → pro 套餐 + 5 小时/1 个月 credits 窗口 + 重置时间；openrouter → 余额；deepseek 兼容网关 → 余额；不兼容网关 → 探测诊断文案。
4. **OAuth 登录流**：发起授权 → 浏览器打开（三平台）→ 回调 → 账号入列 → defaultAccount 生效。
5. **输入框 chip**：有额度显示剩余百分比；无额度显示 Key 数量；点击弹窗；「手动选择 Key」策略切换生效。
