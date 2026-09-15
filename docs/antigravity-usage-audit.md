# Antigravity 使用逻辑审计（2026-09-15）

范围：DSH 通过本插件的 `antigravity` provider 使用模型的全链路 —— catalog → prompt 组装 →
`agy` print/headless 传输 → stream-json 事件解析 → 工具翻译与回灌 → 权限/拒绝 → 错误分类与重试 →
额度读取 → 构建/部署。默认路径是官方 CLI 执行器（`DOCKYARD_ANTIGRAVITY_NATIVE_CHAT` 未开启时的
`createAntigravityCliExecutor`）。

结论先说：**事件形状与 DSH 契约本身是吻合的**，真正的问题集中在四处 —— 历史回灌丢失了
“哪条命令、对应哪次调用”、空回合会被放大成 6 次 CLI 调用、工具回合结束时的进程竞态、
以及超时被当成成功。以下按“已修 / 未修”分开列出。

---

## 一、已修复（本次改动）

| # | 问题 | 位置 | 后果 | 修复 |
|---|------|------|------|------|
| 1 | 工具调用参数以对象插值，历史里渲染成 `[object Object]` | `driver.mjs` `contentText` | 模型看不到自己跑了什么命令，每轮重发同一条，叠加空响应重试 → 额度烧光零产出 | 参数 `JSON.stringify`，并补 `id=` |
| 2 | `tool-result` 有 `content` 字段，先被通用分支拦截，callId 标注永不生效 | `driver.mjs` `contentText` | 多条工具结果无法与调用配对 | 类型判断前移到通用 `content` 展开之前 |
| 3 | 新版 CLI 的权限拒绝以 `step_update {state:ERROR}` 上报，`result.denied_actions` 已不再填充 | `driver.mjs` 执行循环 | 拒绝退化成裸空响应，被 harness 重试 | 采集该事件进 `deniedActions`，抛非重试的 `ANTIGRAVITY_CLI_NO_OUTPUT` |
| 4 | 静默空回合（无文本、无工具、无 stderr）返回空消息 | `driver.mjs` 执行循环 | route 判定 `EMPTY_RESPONSE` → 5 次重试 × 每次新起 CLI，约 6 倍额度 | 改为一次性失败 `antigravitySilentRunError`，带本次运行证据（事件数/步骤数/result 状态） |
| 5 | 流式 runner 从不检查 `timedOut` | `driver.mjs` `runStreamingCommand` | `agy` 被 SIGTERM 后仍退 0 → 半截回合被当成功；SIGKILL 则 `code=null` | 先判超时抛 `TIMEOUT`，并保留 stderr 摘要 |
| 6 | 工具回合在 `result` 事件之前 return，永不发 usage | `driver.mjs` 执行循环 | 工具密集会话的 token 系统性少算 | 逐步累加 `step_update.usage`（`result.usage` 是累计值，正常结束仍以它为准） |
| 7 | usage 映射漏掉 `thinking_tokens` / `cache_read_tokens` | `driver.mjs` `usageFromResponse` | reasoning 与缓存命中被当成新鲜输入，账面额度虚高 | 补齐 `reasoningTokens` / `cacheReadTokens` / `cacheWriteTokens` |
| 8 | 工具回合结束立即 SIGTERM，快工具导致下一轮与退出竞态 | `driver.mjs` `runStreamingCommand` finally | 下一轮 `result.status` 非 SUCCESS、`error: interrupted` | 退出前 `await` 子进程结束（上限 2s，SIGKILL 兜底） |
| 9 | Keychain 会话缓存 60s 且无失效入口 | `native-transport.mjs` | 轮换后 60s 内指纹比对读到旧 token → 误报“不是当前活动本地会话” | 导出 `invalidateAntigravityKeychainCache()`，在刷新/导入凭据后调用 |
| 10 | 读 token 文件时任何异常都被当成“未登录” | `native-transport.mjs` `readOfficialTokenFile` | 权限/IO 故障 → `authExpired` → 健康账号被移出池 | 仅 `ENOENT/ENOTDIR` 返回 null，其余带 code 上抛；JSON 损坏仍按无会话处理 |
| 11 | Code Assist project 缓存键只有 accountId、永不失效 | `native-transport.mjs` `createAntigravityProjectResolver` | 跨账号/重新授权复用 project → 403、配额读取失败 | 键改为 `账号 + token 指纹`，加 30 分钟 TTL 与容量上限 |

配套测试（`tests/providers.test.mjs`，provider 用例 98 → 103）：
`replays a tool round trip...`、`reports a silent empty run...`、`harvests a permission denial...`、
`reports each step's tokens...`、`fails a timed-out turn even when the CLI exits cleanly`。

### 实机验证（真实 `agy`，非 mock）

- 事件词汇表实测：`init` / `step_update`（`state` ∈ ACTIVE|DONE|ERROR，`step_type` ∈ user_input|agent_response|tool）/ `result`；
  `text_delta` 是**真增量**（末条 DONE 只带最后一段），拼接即为全文；`result.response` 是全文（驱动用 `appendDelta` 去重）。
- 工具名实测：`run_command`（参数 `CommandLine`/`Cwd`）、`view_file`（参数 `AbsolutePath`）。`run_command → bash` 翻译命中。
- 工具模型是**一步一工具顺序执行**（`echo A` / `echo B` 分别落在 step_index 2、3），**不存在同轮并行工具调用**，
  因此“只转发第一个 tool-call 就返回”不会丢同轮调用。
- ≥64KiB 提示词走 `--input-format stream-json` 的 NDJSON stdin 路径，97KB 提示词实测 SUCCESS（不是只有小提示词可用）。
- 修复后完整回合：turn1 转发 `bash {"command":"echo DSH_AUDIT_OK",...}` 并带 usage；DSH 执行后 turn2
  直接引用结果作答，**不重复调用**；连续两轮复现稳定。

---

## 二、已确认但本次未改（按影响排序）

1. **每轮都重发整段会话（约 8.5 万输入 token/轮）** —— CLI 是无状态 print 模式，扁平转写每轮重放。
   这是当前额度的主要消耗来源。`agy` 支持 `-c/--continue` 与 `--conversation <ID>`，若驱动按 DSH 会话
   维护 conversation id，可只发表增量消息，理论上数量级降低每轮用量。需要单独设计（会话映射、
   历史与 CLI 自带会话的一致性、失败恢复），不适合顺手改。
2. **DSH 会抹掉插件自定义 error.code**：非 `HarnessError` 的码统一变 `UNKNOWN`，因此本插件的
   `ANTIGRAVITY_CLI_NO_OUTPUT`、数字退出码等都进不了重试集合（消息仍会显示）。当前行为对额度是安全的
   （不重试），但若希望 `TIMEOUT` 这类偶发失败可重试，需要统一改走 `finish` 事件或在插件内自带一次重试。
3. **`cli-agent-transport.mjs` 的 `cliTimeoutError` 用 `ETIMEDOUT`，失败快照码是 `TIMEOUT`**，两者不等 →
   claude/grok/cursor 的“本应重试的超时”永不重试。属共享层，影响面超出 Antigravity，未动。
4. **native 传输路径（`DOCKYARD_ANTIGRAVITY_NATIVE_CHAT=1` 时才启用）** 仍有独立问题：忽略
   `modelContext.maxTokens`（输出被截到 4096）、`reasoningEffort` 未映射、thought signature 全局表跨账号、
   SSE `status` 传 gRPC 字符串导致 5xx 分类失效、artifacts 落 `process.cwd()` 等。默认关闭，未改。
5. **原生工具（`view_file`/`list_dir`/`grep_search`）不翻译到 DSH**：由 CLI 自己执行，代价是依赖
   `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow`。当前放行 `read_file(/)`（见第三节）。
   刻意保留：翻译成 DSH 工具会多一次整轮重发（约 8.5 万 token），而原生执行在同一轮内完成、不额外计费。
6. **`--print-timeout` 默认 5m 与驱动 300s 相同**，驱动已可用 `DOCKYARD_ANTIGRAVITY_CHAT_TIMEOUT_MS` 覆盖；
   未额外下发 `--print-timeout`（避免在未验证 flag 语义的情况下引入新变量）。

---

## 三、运维前提（用户侧）

`~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow` 必须使用**带参数作用域**的写法，
裸 `read_file` 会被 CLI 判为 invalid grant 并忽略（日志 `permission_grant_store.go: invalid grant string`）：

```json
{
  "permissions": {
    "allow": [
      "read_file(/)",
      "command(cat)", "command(grep)", "command(head)", "command(ls)",
      "command(sort)", "command(uniq)", "command(tail)", "command(wc)"
    ]
  }
}
```

**为什么是 `read_file(/)` 而不是 `read_file(/Users/xzb)`**：作用域是**前缀匹配解析后的绝对路径**，
macOS 上 `/tmp` 会解析成 `/private/tmp`（权限判定用解析后的路径，实测拒绝信息里就是
`/private/tmp/...`）。只写 home 目录时，任何落在 home 之外的读取（`/tmp`、`/opt`、`/etc`、
指向 `/Volumes` 的符号链接）都会在 print 模式下被自动拒绝，表现为“读文件失败但只提示 read_file”。
`read_file(/)` 覆盖全部路径；读是只读操作，与本机 DSH 会话自身的文件策略一致。
若想收紧，可写成 `read_file(/Users/xzb)` + `read_file(/private/tmp)`，但需预先枚举所有路径。

未放行的工具在 print 模式下会被自动拒绝，本插件会把它转成**一次性失败**并写明具体授权串
（如 `read_file(/private/tmp/x.txt)`，不再只给工具名），不会静默重试消耗额度。
