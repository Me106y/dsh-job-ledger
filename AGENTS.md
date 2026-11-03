# AGENTS.md

> 给 Agent 的项目指令。只放两类内容：**项目全貌** + **违反就会出错的硬规则**；细节一律链到 `docs/`。
> 真理源：产品看 `docs/PRD.md`（v0.3，28 项决策已锁定），实现看 `docs/TECH-DESIGN.md`（v0.1）。
> 本文与 docs 冲突时以 docs 为准，并在同一个 PR 里修正本文。

## 项目概述

`dsh-job-ledger` 是 DeepSeek Harness 的**本地求职投递账本**：判重、冷却、证据链、与 BOSS 对账。
它记录你投过什么、投成了什么；投不投由你决定。

- **形态**：DSH cordis 插件。同一个 npm 包两个入口——host（工具 + 投递执行）与 Web 面板（三屏，只走 host API）。
- **技术栈**：TypeScript（ESM / strict）· Node 22 或 24 的内置能力（`child_process` 起 Chrome、原生 `fetch`、原生 `WebSocket` 说 CDP）· `node:test` · tsdown · pnpm。
- **数据**：`$DSH_HOME/job-ledger/` 下的 `events.jsonl`（只追加），不出本机。

**当前状态：P0–P6 的代码与自动化测试已完成；真机验证进行中——进度与已验证/未验证清单见 `docs/PRD.md` §12 与 `docs/SMOKE.md`。**
`docs/TECH-DESIGN.md §3.2` 是**目标**目录结构：动手前先 `ls src/`，不要假设某个模块已经存在。

## 仓库里真实存在什么

不要凭记忆，用两条命令确认：

```sh
ls src                     # 有哪几层
ls src/ledger src/tools    # 关键模块是否存在
```

- `lib/` 是 tsdown 构建产物，gitignored：**不手改、不 commit**。
- `package.json` 的 `exports["./client"]` 指向 `lib/client.js`，client 入口在 P5 才构建；加 client 时同步补 tsdown 第二个 entry。
- 新模块按 `docs/TECH-DESIGN.md §3.2` 的路径放。

## 快速命令

| 场景 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 类型检查 | `pnpm typecheck` |
| 跑测试 | `pnpm test` |
| 构建 | `pnpm build` |
| 硬规则扫描 | `pnpm lint:rules`（重放请求 / 合成点击 / 第二写者 / 原生依赖） |
| 浏览器链路冒烟 | `pnpm smoke:cdp`（真实 Chrome，不需要账号） |
| 全量门禁 | `pnpm check`（lint:rules + typecheck + test + build） |

- 测试直接用 `node --test test/*.test.ts` 跑 TypeScript：**不引入测试框架**，也不需要先 build。
- 本地不需要环境变量。配置项走 `cordis.patch.yml`（`TECH-DESIGN.md §14`），不要另起一套 env 体系。
- CI 用 `pnpm install --frozen-lockfile`：改了依赖就把 `pnpm-lock.yaml` 一起提交。

## 架构：三条不能破的线

**① 单进程。** 账本与点击都在 DSH host 进程内，`claim` 与 `click` 之间没有进程边界——重复投递的缝就是这么消失的。不引入 IPC、子进程投递器、外部队列或"文件即 IPC"。

**② 单一入口。** 面板按钮与模型工具都调 `startRun(ids, grantedBy)`，`grantedBy` 记 `{kind: 'panel' | 'model', at}`。绕过它的直接点击一律是缺陷。

**③ 单向依赖。**

```
tools / api ─► run ─► cdp(boss) ─► chrome / network
                 └─► ledger ─► events
client ──只允许──► api/contract.ts（type-only）+ shared/errors.ts
```

- `client/` 不得 import `cdp/`、`ledger/`、`run/`：面板只调 host API，不碰 CDP、不读文件。
- 平台相关的一切（选择器、URL、字段映射）只放 `cdp/boss.ts` 并带版本号，BOSS 改版只改这一个文件。
- 错误码只有一张表 `src/shared/errors.ts`：新增失败先加 code 与用户文案，工具返回 `failure()`，不要把原始异常抛给模型。

## 编码约定（不遵守就出错）

- 相对导入**必须带 `.ts` 后缀**（`NodeNext` + `allowImportingTsExtensions`）；类型导入用 `import type`（`verbatimModuleSyntax`）。
- 语言分工：代码、注释、测试名、提交信息用**英文**；用户可见文案与 `docs/`、README、PR 正文用**中文**。
- 导出的函数与常量写 JSDoc（`@param` / `@returns`），密度照 `src/shared/errors.ts`。
- 失败一律结构化：返回 `LedgerFailure`，不抛裸 error——单个岗位失败不该终止模型的一轮。
- 用户可见的失败必须能渲染：`userMessage(code, values)`，占位符用 `{name}`。

## 硬规则（违反即为缺陷，评审会拦）

### 浏览器：只监听，不重放（最高风险）

- **数据只来自页面自己发出的请求**，靠监听响应体取。因此不构造 URL、不拼 header、不签名、不注入 JS、不做浏览器扩展。
- 点击用 `Input.dispatchMouseEvent`；`element.click()` 产生 `isTrusted=false` 的合成事件，风控能识别。
- 每个可能超时的操作都有明确超时；超时和"取不到"落到 `uncertain` 或结构化错误码，不当成成功。

### 判重：宁可漏判，不可误杀

漏判 = 多投一份，可恢复；误杀 = 这个岗位从此不再出现，不可恢复，且用户不会知道。

- 判重是**纯确定性函数**；模型只能解释理由，不能改变结论。
- 同公司不同职位 = 永远算新岗位；城市不同不判重。
- 疑似重复进"待裁决"，**永不自动剔除**；每条结论带 `reason` 与 `duplicateOf`。
- 加任何"更宽松"的条件前先回答：它会不会把两个不同岗位判成同一个？

### 状态与执行

- `uncertain` 是一等状态（点了，但不知道成没成），**永不自动重试**。
- 熔断停的是**整轮**，不是跳过当前继续下一个；剩余回 `queued`，不自动续跑。
- `submitted` 之后自动化不得再改状态；状态变更只追加事件，不改历史。
- 单轮 10 / 每日 30 的上限写死在代码里，不能被参数或配置绕过。
- `submitted` 必须留证据：截图 + 聊天记录片段 + 时间戳。

### 账本：唯一真源

- 只追加；`write + fsync` 之后才算写成功；写失败向上抛，不吞。
- replay 遇到无法解析的行**即停止**（截断的尾巴之后不可信）：不跳过、不重建、不静默重同步。
- 同一个 `events.jsonl` 只允许一个写入者：不开第二个 fd，不加并发写路径。

### 边界

- host 侧**零原生依赖**，只用 Node 内置。加运行时依赖会破坏"一键装"：先开 issue 讨论，再写代码。
- 日志里不出现简历原文、cookie、PII，只留 `encryptedJobId` 这类身份字段。
- 回填（`reconcile-backfill`）只参与判重，不进转化率。

### 范围：这些是明确不做的

PRD §3.2 已把多平台、简历改写、自由生成招呼语、上传 PDF、云端同步、面板图表/设置页/证据页、自动回复 HR 划为非目标。**不要顺手实现**——它们被评估过并主动推迟；有疑问先开 issue。

## 提交与 PR：`main` 只接受 PR

没有直推。文档、一行修正、CI 调整也一样：开分支 → 提交 → PR → CI 绿 + 评审通过 → 合并。

- **分支名** `<type>/<kebab-slug>`，type 与提交类型一致：`chore/pr-template`、`docs/agents-md`；agent 自动建的分支用 `agent/<slug>-<hash>`。
- **提交信息**用 Conventional Commits，英文、祈使句、小写开头、不加句号：`feat(dedupe): add golden corpus runner`。
  - 类型：`feat` `fix` `docs` `test` `refactor` `perf` `ci` `build` `chore`。
  - 标题说改了什么，正文说**为什么**；一个提交只做一件事，重构与行为变更不混。
- **PR 标题**沿用同一格式；**正文按 `.github/pull_request_template.md` 填**：一句话做了什么 → 勾"改了哪一层" → 碰了哪层就勾哪层的硬规则自查 → 怎么验证（命令、截图；真机投递写明账号与条数）。
- **agent 提的 PR，第一行写 `This is by an automated agent, not a human.`**，让人一眼分得清谁写的。
- **CI 必须绿**：`typecheck · test · build` 外加一条 tarball 内容断言；本地等价命令是 `pnpm check`。不绕过、不跳过。
- **合并用 merge commit**（保留分支上的提交），不 squash，也不 rebase 掉历史。
- **改产品决策**：先改 `docs/PRD.md` §15 决策记录、同步 `docs/TECH-DESIGN.md`，并在 PR 里说明；不在代码里悄悄偏离这 28 项已锁定决策。
- **未验证的标 ⚠️**：`TECH-DESIGN.md §20` 的 7 项待实测，抓包确认前不得写成"已实现"或"已知"。
- **发布**：打 `v*` tag，tag 必须等于 `package.json` 版本（Release workflow 会校验）；不走手动 publish。

## 完成定义：跑通才算完

改代码不算完成，验证过才算：

1. `pnpm check` 全绿（含硬规则扫描；它报错说明你踩了 AGENTS.md 里的红线，先改代码，不要改规则）。
2. 逻辑有测试，且是**能失败的测试**：
   - 判重 → `test/dedupe/corpus/*.json` golden corpus（同名不同城市、同公司不同职位、同 JD 跨来源、多 HR 重复发、括号噪声、全角半角）
   - 状态机 → 全转移矩阵，含非法转移
   - 账本 → 正常重放、截断尾巴、未知事件、版本过高、租约并发
   - host / 面板 → `Api` 每个路由的 handler 级契约测试
   - CDP → 走 `BrowserPort` 接口 + `test/fixtures/cdp/*.json` 回放，测试里不连真浏览器
3. 碰了真实浏览器或真机投递：按 `TECH-DESIGN.md §17.4` 冒烟（扫码读简历 → 发现判重 → 投 1 条看证据 → 拔网线 halt → 重启一致 → 对账 0 差异），结果写进 PR。
4. 改了 `src/client/`：要免刷新热更，得同时跑 **DSH 仓库**的 `pnpm run dev:web`（本仓库没有这个脚本）；否则重建 + 刷新页面。

## 文档导航

| 想了解 | 去哪看 |
|---|---|
| 产品定位、目标与非目标 | `docs/PRD.md` §1–§3 |
| 判重语义、归一化、阈值 | `docs/PRD.md` §5.3 · `docs/TECH-DESIGN.md` §7 |
| 投递执行、成功判据、节奏与熔断 | `docs/PRD.md` §5.5 · `docs/TECH-DESIGN.md` §9 |
| 账本、事件 schema、重放 | `docs/PRD.md` §6 · `docs/TECH-DESIGN.md` §6 |
| 对账与冷启动回填 | `docs/PRD.md` §5.7 · `docs/TECH-DESIGN.md` §10 |
| host API 契约、面板三屏 | `docs/TECH-DESIGN.md` §11 · §12 |
| 错误码 | `src/shared/errors.ts` · `docs/TECH-DESIGN.md` §15 |
| 测试策略 | `docs/TECH-DESIGN.md` §17 |
| 还没验证的假设 | `docs/TECH-DESIGN.md` §20 |
| 评审会查什么 | `.coderabbit.yaml` · `.github/pull_request_template.md` |

<!-- 全文控制在 200 行内：放不下的写进 docs/，这里只加一行链接。
     每条规则只有一个真理源；新增前先确认它不是 docs 里已有内容的副本。 -->
