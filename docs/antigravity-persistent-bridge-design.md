# Antigravity 长驻进程桥（终局方案）设计

状态: 设计稿 v1，待评审
分支基线: `fix-antigravity-prompt-stdin-transport`（含 60KiB 历史截断的临时缓解 `436bafa`）

## 1. 问题定义

当前 antigravity 执行器是「每轮一次性 spawn + 全量打平重放」：

```
DSH turn → 压扁全部历史成一个字符串 → spawn agy -p <prompt>（或 >64KiB 走 stdin 单事件）
        → 拦截 agy 工具意图 → 杀进程 → DSH 执行工具 → 下一轮重新 spawn 重放
```

已实测的结构性代价：

| # | 代价 | 实测证据 |
|---|------|----------|
| 1 | agy 每轮重付 ~18k token 自带 system prompt + 全量历史 | 最小提问 input_tokens=17885 |
| 2 | 单轮耗时随输入线性涨，长会话撞 300s 超时静默挂死 | 113KB≈46k tokens≈27s；整天会话远超 300s |
| 3 | 双 system prompt 人格分裂 → 无限重跑/文字模拟工具调用/[object Object] 循环 | 本分支连续四个 fix 的根因 |
| 4 | 工具调用无真 id 语义，靠字符串映射 + 参数名猜测（command/CommandLine） | driver.mjs toolCallFromEvent |

## 2. 协议事实（2026-09-15 对 agy 1.2.3 实测）

✅ **已证实**：

- F1 `--input-format stream-json` 同一进程多轮：每行 NDJSON 跑一轮，**进程内会话记忆真实存在**（两轮探测，第二轮记得第一轮的暗号）。
- F2 输入信封：`{"event":"user","message":{"role":"user","content":"<纯字符串>"}}`。content 必须是 string；数组会静默挂死；缺 message 字段返回 ERROR result；未知 event 优雅忽略（warning）。
- F3 输出事件流：`init` → `step_update(user_input|agent_response[text_delta]|tool[tool_name,tool_info.parameters,call_id])` → `result{status,response,usage,denied_actions}`。
- F4 `--sandbox` 下 agy 自己执行工具（run_command 等）；print 模式对需要授权的工具自动拒绝（denied_actions / step_update ERROR）。
- F5 agy 有本地会话持久化（conversation_id、trajectory、conversation_summaries.db）。
- F6 113KB prompt 单轮 33s 正常返回 → stdin 路径协议本身可靠。

❓ **未证实（实现期第一优先验证）**：

- Q1 工具结果回传事件的名称与形状。二进制里有 `streamInputResult`/`streamInputContentBlock` 类型和 `functionResponse` 字符串，但 `tool_result`/`function_response`/`result`/`tool_response` 四个探测名均未成功（首个探测且触发 agy 自身工具时 240s 挂死，证据不完整）。
- Q2 print 模式能否按 conversation_id 恢复会话（进程死后接续，而非重放）。binary 字符串有 LoadReplayConversation / resume 线索，未找到 CLI 参数。
- Q3 `--model` + `--effort` 与 stream-json 多轮组合的稳定性（探测均未带 model 参数）。

## 3. 目标与非目标

**目标**

1. 一个 DSH 会话 ↔ 一个长驻 agy 进程；用户轮次经 F2 信封写入，输出流持续回流。
2. 会话连续性由 agy 进程内记忆承担（F1），彻底消灭打平重放。
3. 工具循环所有权清晰：**agy 拥有工具执行**（F4），DSH 保留权限镜像、审计与观测。
4. 失败可降级：进程死亡时回退到现存的「打平重放」执行器，用户无感。

**非目标**

- 不改 DSH 其余 provider 的执行器模型。
- 不做 agy 多账号并发进程池（沿用现驱动账号池，一个账号同时一个活跃进程）。
- 不在 GUI 层新增概念（对用户透明）。

## 4. 架构

```
┌─────────────────────────── DSH web 进程 ───────────────────────────┐
│  provider-antigravity                                             │
│  ┌──────────────────────┐      ┌───────────────────────────────┐  │
│  │ AntigravityCliExecutor│      │ AgySessionBridge (新)          │  │
│  │ (现役, 降级路径)        │      │  per DSH conversation:         │  │
│  └──────────┬───────────┘      │   spawn agy(stream-json 双向)  │  │
│             │ 失败/关闭时降级    │   in: user 事件队列             │  │
│             ▼                  │   out: step_update/result 泵    │  │
│  ┌─────────────────────────────┤   工具意图审计钩子(只读)          │  │
│  │ conversation registry       │   idle reaper / crash handler  │  │
│  └─────────────────────────────┴───────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                                   │ stdio
                          ┌────────▼────────┐
                          │ agy --input-format stream-json
                          │     --output-format stream-json
                          │     --sandbox --model <id> [--effort]
                          └─────────────────┘
```

### 4.1 模块：AgySessionBridge

职责：进程生命周期 + 事件双向泵。核心状态机：

```
IDLE --首条消息--> SPAWNING --init--> READY --user事件--> STREAMING
   ^                  |spawn失败                                    |
   |                  ▼                                            | result事件
   +--- reaper(30min空闲) <-- IDLE <-------------------------------+
                      crash → 标记 DEGRADED → 本轮降级到重放执行器
```

- **spawn**：`agy --input-format stream-json --output-format stream-json --sandbox [--model X --effort Y]`，环境用现有 `agyRefreshEnvironment`（file-backed session，不碰用户 HOME 语义）。
- **入站队列**：DSH turn 到达时，把 `{"event":"user",...}` 写入 stdin 并等待本轮 `result` 事件。若上一轮 result 未到（并发），排队——agy 自身逐行串行，桥按 FIFO 保证不交错。
- **出站泵**：逐行 parse，映射到 DSH 的 block 流：
  - `agent_response.text_delta` → `text-delta`（现 streamEventTexts 逻辑复用）
  - `tool` step_update → **只做审计记录**（谁、什么命令、何时），不再翻转/拦截
  - `result` → `finish`；usage 按 F3 累加
- **abort**：DSH turn 取消 → 杀进程（agy 无 per-turn 取消协议）→ 标记会话降级，下轮走重放。
- **idle reaper**：30 分钟无消息杀进程释放资源；下条消息冷启动（无重放，进程记忆丢了但用户感知只是失忆早期上下文——与现行为一致）。
- **绝对超时**：单轮 result 等待上限提到 900s（可配 `DOCKYARD_ANTIGRAVITY_TURN_TIMEOUT_MS`），超时按 crash 处理。

### 4.2 工具所有权：为什么选 agy 全权执行

三个备选：

| 方案 | 描述 | 判定 |
|---|---|---|
| A. agy 全权 | agy sandbox 内自执行；DSH 镜像权限 + 审计 | ✅ **采用**。与 F1/F4 天然契合，无需 Q1 的工具回传事件；DSH 的权限模型经 agy `settings.json permissions.allow` 镜像（已验证即时生效，见记忆 agy-settings-apply-without-restart） |
| B. DSH 全权（现方案） | 拦截意图 → DSH 执行 → 回传结果 | ❌ 依赖未证实的 Q1 回传事件；且本质回到重放模式 |
| C. 混合 | 简单工具 agy 执行，DSH 特有工具（web_search/SSRF 防护的 web_fetch）走拦截 | ⏸ 作为 B 方案，等 Q1 证实后演进；v1 不做 |

**安全边界（A 方案的关键补偿）**：

1. spawn 前把 DSH 权限规则同步进 agy `settings.json` 的 `permissions.allow`（只追加，不删除用户自己的规则）。
2. DSH 侧审计钩子记录每条 tool step_update（时间、tool_name、参数摘要），进现有 usage/observability 面板。
3. `--sandbox` 永不省略；denied_actions 映射为对用户的可见提示（现 antigravityEmptyOutputError 逻辑复用）。
4. 网络类工具（search_web/read_url_content）保留 agy 原生执行；fake-IP 检测逻辑（driver 现有）仍适用于报告，但不再改写工具路由。

### 4.3 与 DSH 执行器接口的适配

DSH executor 契约是 `{request} → AsyncIterable<block>`，无状态语义。桥的适配层：

- `conversationKey`：由 request 的 DSH session 标识派生（现有 mountRequests/requestGuard 链路可取）。取不到时（如 API 直调）退化为每次新建进程的单轮桥——等价「新对话」路径。
- 请求到达时 `bridge.send(userText)` 返回 block 流；request.system/reasoningEffort 映射为 spawn 参数（system 不再进 prompt——**agy 自有 system prompt 唯一化**，这是消灭人格分裂的关键；DSH 的 system 以首条 user 消息前缀「会话约定」一次性传递，仅会话首轮回传）。
- 工具类 request.tools：v1 忽略（agy 用自己的工具集）；ANTIGRAVITY_TOOL_TRANSLATIONS 仅保留用于审计标签。

### 4.4 降级矩阵

| 场景 | 行为 |
|---|---|
| agy 二进制缺失/版本 <1.2.3 | 直接用现役重放执行器（保留全部近期 fix） |
| spawn 失败 / init 超时(15s) | 本轮降级重放执行器，桥标记 DEGRADED，10 分钟后半开重试 |
| 流中断（stdin EPIPE / 进程退出无 result） | 同上；用户看到中文错误（复用 antigravitySilentRunError 文案体系） |
| turn abort（用户停止） | 杀进程 → 降级重放（进程记忆丢失如实告知） |
| result.status != SUCCESS | 透传 error 给用户，进程保留（单轮失败不毁会话） |

### 4.5 观测与配额

- usage 事件按会话累计入现有 token ledger（复用 addUsage/usageFromResponse）。
- 桥自身指标：进程存活数、spawn 次数、降级次数、单轮耗时分布 → 打进现有 llm/retry 事件通道。
- 账号额度读取（native quota）不动，仍由 driver refreshAccount 负责。

## 5. 实施分期

| 期 | 内容 | 验收 |
|---|---|---|
| P0 探针（半天） | 脚本化验证 Q1（遍历候选事件名 × 触发工具的轮次）、Q2（conversation 恢复）、Q3（--model 组合）。产出：协议事实表更新 | 每项有可复现探测脚本与结论 |
| P1 桥 MVP（2-3 天） | AgySessionBridge + executor 适配 + 降级矩阵，单测全模拟进程 | 现有 105 测试不回归；新增桥状态机测试 |
| P2 真机联调（1 天） | GUI 长会话实测：多轮记忆、工具执行审计、abort、crash 降级 | 中途切换秒级响应；审计记录完整 |
| P3 清理 | 60KiB 截断改为仅降级路径使用；打平格式标记 legacy | 文档更新，回归全绿 |

## 6. 风险与开放问题

1. **Q1 工具回传事件**不阻塞 v1（A 方案不需要），但决定 P3 之后能否演进到 C 方案。
2. agy 版本升级可能改事件协议——桥对未知事件已证实是优雅忽略（F2），出站解析需宽容（现 parseJsonOutput 已是）。
3. 长驻进程的内存占用：每会话一个 agy 进程（Go，实测 RSS ~150MB 级）。reaper 30min 兜底；并发会话数需要监控（个人部署场景压力小）。
4. **system prompt 唯一化**后 DSH 的工具描述/安全约束不再注入 agy——权限边界完全依赖 4.2 的镜像机制，P2 需专项验证越权场景。
5. Windows 支持未验证（现有 usePty 分支 darwin-only），v1 维持 darwin/Linux。

---

## 7. v1.1 补充分析（评审后差距清单，2026-09-15）

### 7.1 阻断级：开工前必须有结论

| # | 差距 | 现状 | 结论去向 |
|---|------|------|----------|
| G1 | **conversationKey 锚点是否存在** | ✅ 已验证 harness 层存在稳定会话标识：`request.sessionId ?? context.sessionId`（cursor 执行器已用它派生 conversationId，账号 sticky 也用它做 assignmentKey）。但 **antigravity 请求路径是否实际收到 sessionId 未验证** | 并入 P0：若未传，需在 adapter 层补传；拿不到 sessionId 的调用（API 直调）退化为单轮进程 |
| G2 | **DSH 分支/编辑重发/compaction 与进程记忆的分叉** | 未分析。用户编辑历史分支后，conversationKey 不变但 DSH 历史与 agy 进程内记忆不一致——agy 记得"被编辑掉"的内容 | 必须给决策：a) 分支/编辑检测（消息数/内容指纹变化）→ 杀进程重建（推荐，语义最干净）；b) 接受失忆。写入 P1 |
| G3 | **同会话切模型 / 切账号** | 未分析。进程按 `--model`+凭证 spawn；模型或账号变化必须 respawn → 进程记忆丢失 | 决策矩阵：模型切换=respawn+提示用户上下文丢失；账号切换=respawn+重放（走降级路径）；写入 P1 |
| G4 | **DSH web 重启后的恢复语义** | 未分析。web 重启 → 所有桥进程死亡。重启后会话首轮走降级重放，此后 agy 记忆与重放内容不一致（重放喂的是压扁历史，agy 又在进程里积累了新记忆） | 决策：重启后**永久降级到重放执行器**直至会话结束（禁止混用两种记忆来源），防止双重人格。写入 P1 |
| G5 | **长驻进程的凭证过期窗口** | 未分析。agy 进程持有 spawn 时的 OAuth token；过期后 agy 是否自刷新未验证；DSH 侧 refreshAccount 刷新后进程仍持旧凭证 | P0 验证 agy 自刷新行为；无论结论如何，DSH 完成 credential rotate 后必须 recycle 活跃进程 |

### 7.2 设计缺口（并入对应章节）

| # | 缺口 | 补充 |
|---|------|------|
| G6 | 边带请求隔离 | 标题生成、摘要类短请求**不得**进会话桥（会污染 agy 记忆且排队阻塞主轮次）——单独走一次性 spawn，且 system 用中性的"标题生成"指令 |
| G7 | 回滚开关 | 新增 `DOCKYARD_ANTIGRAVITY_PERSISTENT_BRIDGE`（默认 0 起步），置 0 完全回退现役重放执行器；P3 全绿后再默认 1 |
| G8 | 成本定量对比 | 桥：首轮 18k + 每轮增量；重放：每轮 18k + 全量历史。按 20 轮会话粗算，重放多耗约 3-5 倍 input tokens——补进 P2 验收（实测对比） |
| G9 | agy 自身上下文压缩 | binary 有 `contextWindowCompression` 痕迹：超长后 agy 可能自行裁剪记忆。P0 探测其触发点与用户可见性；DSH 侧 compaction 决策只管重放路径，桥路径以 agy 为准 |
| G10 | stderr 与日志 | 长驻进程 stderr 接现有 onStderr 诊断缓冲（截断 2KB）；`--log-file` 指向 per-session 文件并随 reaper 清理，防泄漏 |
| G11 | 图片附件 | 桥 v1 沿用现限制：含图片轮次直接报错（现 contentHasImageInCurrentTurn 文案）。P0 顺带探测 stream-json 是否有图片 part 通道，留 P3 演进 |
| G12 | 测试策略 | fake-agy 可执行脚本协议 fixture（回放预录事件序列 + 可脚本化故障：无 init / 中途退出 / result 延迟 / 未知事件）；桥状态机全部用例跑在 fake 上，真 agy 只做 P2 冒烟 |
| G13 | 并发与排队 | 桥入站 FIFO + DSH 现有 requestGuard 串行化双层保证；并发 turn 到达时第二条等待，超 5s 未取到执行权返回明确错误而非静默排队 |
| G14 | 与账号 sticky 的交互 | `STICKY_SESSION` 的 assignmentKey 恰为 sessionId——桥会话天然粘住同一账号；failover 触发账号切换时按 G3 respawn |

### 7.3 修订后的开工门槛

P0 必须产出结论的清单从 3 项扩为 **6 项**：Q1（工具回传事件）、Q2（conversation 恢复）、Q3（--model 组合）+ G1（sessionId 到达性）、G5（agy 自刷新）、G9（agy 压缩行为）。
其中 **G2/G3/G4 三项决策（分支、切换、重启语义）需要你在评审时拍板**，默认按上表推荐项执行。

---

## 8. P0 探针结论（2026-09-15，全部落定）

| 项 | 结论 | 证据 |
|---|------|------|
| **Q2 会话恢复** | ✅ **成立且超预期**：`agy --conversation <id>` 跨进程恢复完整记忆（暗号探针通过）；可与 `--input-format stream-json`、`--model` 组合 | conv 81c1907c/33ccaff9 两轮探针 |
| **Q3 --model 组合** | ✅ `--model gemini-3.8-flash-high --conversation <id> --input-format stream-json` 三旗组合正常，SUCCESS + 记忆在 | conv 33ccaff9 |
| **G1 sessionId 到达性** | ✅ 契约存在：pi-ai `request.sessionId?: string`（types.d.ts:137，"for session-aware features"）；cursor 执行器已消费同一字段。P2 冒烟确认 antigravity 路径实际传值即可 | pi-ai types + dist:10656 |
| **Q1 工具回传事件** | ❌ 仍未找到可靠形状（tool_result 探测挂死）；**但 A 方案（agy 全权执行）不依赖它**，降级为 P3 演进前置 | 探测记录 |
| **G5 agy 自刷新** | 未测（需真实过期 token），不阻塞：设计已规定 DSH credential rotate 后强制 recycle 进程/换新轮次 | — |
| **G9 agy 压缩** | 未测（需超长会话），不阻塞：桥路径以 agy 为准，DSH 不干预 | — |

### 8.1 架构简化（重要反转）

`--conversation` 使**长驻进程不再是架构必需**，终局方案简化为：

> **会话锚点模式**：DSH 会话 ↔ agy `conversation_id`（首条消息从 `-p`/stream-json 拿到 cid 后持久映射）；此后每轮 `agy --conversation <cid> --input-format stream-json <<< user事件` 一次性 spawn。记忆由 agy 本地会话存储（F5）承担，进程即用即走。

对比原长驻桥：

| | 长驻进程桥（v1 设计） | 会话锚点模式（v2 设计） |
|---|---|---|
| 记忆载体 | 进程内（死即失忆） | agy 本地会话库（跨进程、跨重启） |
| 生命周期管理 | spawn/reaper/crash/队列全套 | **无需**（一次性进程） |
| web 重启(G4) | 全部降级重放 | 用 cid 直接续，无感 |
| 切模型/账号(G3) | respawn 丢记忆 | 换 cid 或带原 cid respawn，记忆仍在 |
| 每轮固定开销 | 无（进程常驻） | 重付 ~18k system prompt（可接受，等价现网） |
| 复杂度 | 高（状态机+泵+池） | **低**（≈现执行器 + cid 映射表） |

**裁决：采用会话锚点模式为终局。** 长驻桥降级为"未来优化项"（若 18k/轮开销实测不可接受再启用）。

### 8.2 重写后的分期

- **P1（1-1.5 天）**：cid 映射表（DSH sessionId → agy conversation_id，持久化于插件 storage）+ 执行器改造（首轮建会话、后续轮 `--conversation` 重附 + stream-json 单事件）+ 分支/编辑检测（DSH 消息指纹变化 → 弃旧 cid 建新会话）+ fake-agy 测试。60KiB 截断与打平重放保留为降级路径。
- **P2（半天）**：真机联调——长会话中途切换、web 重启续聊、切模型、abort；sessionId 传递冒烟；成本对比实测（G8）。
- **P3**：清理 legacy 打平路径、探明 Q1（若未来要做 DSH 工具接管）。


---

## 9. P2 真机联调结论（2026-09-15 晚）

会话锚点模式在真实 GUI 会话（session-ef98308d）验证通过。诊断日志
`~/.dockyard-dsh/antigravity-anchor.log` 的三轮记录：

| 时间 | 结果 | cid | events | 文本 | 耗时 |
|---|---|---|---|---|---|
| 20:02:46 | ✅ anchored_ok（新建会话） | — | 157 | 1884 字 | 39.6s |
| 20:04:45 | ⚠️ anchored_empty（10 events SUCCESS 空文本）→ 降级 legacy | 重附 | 10 | 0 | 14.3s |
| 20:05:15 | ✅ anchored_ok（重附） | 重附 | 87 | 2066 字 | 12.7s |

用户确认：回复在 GUI 可见；连续轮次（含工具命令）均有输出。

对比修复前同一问题：静默无响应 / 4 分钟降级重放 → 现在 12–40 秒完整回答。

### 9.1 联调中发现并修复的问题

1. **sessionId 来源错误**（`7bd7e5c`）：harness 放在 invoke context 而非 request，锚点此前从未激活（映射文件不建立是铁证）。
2. **超时边界过窄**（`4b74be8`）：实测该模型最小提问即需 28–35s；300s kill 会把健康慢轮次掐死并触发全量重放（双倍成本）。现为 agy `--print-timeout 900s` + DSH 960s。
3. **静默失败不可诊断**（`a4d4ab3`）：加入有界诊断日志（events/steps/resultStatus/deniedActions/stderr/文本长度/耗时/降级原因）。
4. **测试污染用户目录**（`5349154`）：锚定测试未隔离日志路径。
5. **空轮次立即降级过重**（本轮）：改为**先原样重试一次锚定**，两次失败才降级重放；新增 `anchor_attempt_failed` 日志类型。
6. **agy 权限表缺口**（运行环境侧）：`run_command` 需 `settings.json permissions.allow` 中有对应规则（已补 `command(git)` / `unsandboxed(git)`），否则 denied_actions → 空响应 → 降级。

### 9.2 剩余事项

- **G6 边带请求隔离**：会话标题生成（`session/title-llm-request`）也走 antigravity 执行器，占用一次完整慢调用；应改为短生命周期/独立 provider。
- **权限镜像自动化**：目前靠人工往 agy settings.json 添加规则；终局是 spawn 时按 DSH 权限自动镜像（设计 §4.2）。
- **P3 清理**：确认锚点稳定后，把 60KiB 截断与打平重放明确标记为降级路径并简化。
- **Q1 工具回传事件**：仍未破解，仅影响未来「DSH 接管工具」的 C 方案演进。
