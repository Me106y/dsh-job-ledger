# dsh-job-ledger

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的求职投递账本：**判重、冷却、证据链、与平台对账**。
它记录你投过什么、投成了什么；投不投由你决定。

> **状态：代码完成 7 个里程碑，真机未验证。**
> [PRD](./docs/PRD.md) v0.8（39 项决策）· [技术设计](./docs/TECH-DESIGN.md) v0.1
> 接口结构与页面选择器按设计实现，但还没有对着真实账号跑过——见下方「未验证」。

## 它解决什么问题

自动投递工具已经很多，但没有一个解决真正的问题：

| 失效模式 | 表现 |
|---|---|
| **无记忆** | 今天投过的明天还投；同一岗位多个 HR 发还投 |
| **数据不在你手里** | 服务关停，投递队列和历史一起消失 |
| **双真源缝隙** | 投递器和账本各记一套，重复发生在两者之间 |
| **无法对账** | 账本说投了，平台说没投，没人发现 |

**本项目的切入点不是"投得更快"，是"投得清楚"**：账本能和 BOSS 自己的投递记录对账，
发现"投了但没记上"和"记了但没投成"。

## 安装

```sh
dsh plugin --profile web add dsh-job-ledger
```

插件拉起一个专用 Chrome profile，首次由你扫码登录；**登录态保存在 `dataDir/chrome-profile`**，之后不用再扫。
第一次跑时如果没登录，调用 `job_ledger_login`：它把登录页放到前台并等你扫描（默认 3 分钟），成功后自动继续；
cookie 过期就再扫一次。所有数据留在本机。

## 你能拿到什么

**十个工具**（模型侧）：`job_ledger_profile` · `job_ledger_login` · `job_ledger_resume` ·
`job_ledger_discover` · `job_ledger_queue` · `job_ledger_apply` · `job_ledger_record` ·
`job_ledger_reconcile` · `job_ledger_backfill` · `job_ledger_report`。
`apply` 是唯一的投递入口，面板和工具都走它。

**一个面板**（四屏）：待投（勾选 + 进度）· 概览（今日已投 / 剩余额度 / 不确定 / 差异 / 昨日回复）·
对账差异（双侧列表 + 重新对账）· 设置（目标岗位 / 城市 / 薪资下限，保存即写账本）。

**一个 skill**：`job-ledger`，把编排硬约束（先对账、清单确认、`uncertain` 必须人工）写进模型可读的正文。

## 设计要点

- **单一入口**：面板按钮与模型工具都调同一个 `startRun()`，不存在两个投递器。
- **只监听不重放**：所有数据来自页面自身发出的请求，不构造、不签名、不伪造请求头。
- **判重偏保守**：确定重复 / 疑似 / 新岗位三级；同公司不同职位永远算新岗位；城市不同不判重。
- **`uncertain` 是一等状态**：点了但不确定成没成，就记为不确定，永不自动重试。
- **账本只追加**：`events.jsonl` + `fsync`，重放遇坏行即停；账本是产品的价值本身。

## 数据与隐私

```
$DSH_HOME/job-ledger/          # 可配置 dataDir
├─ events.jsonl                # 唯一真源，只追加
├─ evidence/<appId>.png        # 投递证据截图（0600）
├─ chrome-profile/             # 专用浏览器登录态（含 cookie，0700）
└─ snapshot.md                 # 报表导出（可选）
```

简历默认**脱敏后**才交给模型（`privacy.resumeExposure: redacted`）；确认原文需要显式改成 `full`。
**不加密**是明确取舍：一键装优先，备份与分享自行注意——这个目录等于你的简历。

## 未验证（诚实清单）

以下按设计实现、有测试，但**没有对真实页面验证过**（TECH §20）：

1. 简历三个接口的响应字段名；
2. 点击「立即沟通」后实际发出的请求、简历是否为独立请求；
3. 简历卡片在聊天流里的 DOM 结构；
4. 岗位列表是否带 JD 文本、翻页参数；
5. `geekDeliverList` 的分页与返回字段（目前只读第一页，并明确告知）；
6. 业务码 9 / 31 / 32 / 36 / 37 的实际语义；
7. 招呼语输入框是否可编辑；
8. 面板的 slot / locale 注册形状（客户端包由宿主运行时提供，仓库里没有其类型）。

**已验证（2026-11-03，Chrome 156，未登录）**：`pnpm smoke:cdp` 跑通了 Chrome 启动 → CDP 连接 → 导航 →
DOM 读取 → 截图 → 缺失选择器错误码 → 登录墙识别。未登录时 BOSS 会重定向到 `/web/user/`（不是设计里猜的
`?login`），重定向晚于框架提交，所以登录检查是轮询而不是单次。

改版只需要改 `src/cdp/boss.ts` 一个文件——所有选择器与接口 pattern 都集中在那里。

## 开发

```sh
pnpm install
pnpm check          # 硬规则扫描 + 类型检查（host/client）+ 测试 + 构建
pnpm test           # node --test，不需要测试框架
pnpm lint:rules     # 七条硬规则：重放请求 / 合成点击 / 第二写者 / 原生依赖 …
pnpm smoke:cdp      # 真实 Chrome：启动、CDP、导航、DOM、截图、登录墙（不需要账号）
```

- Node `^22.19 || >=24`；测试直接跑 TypeScript。
- `lib/` 是构建产物，不入 git：`index.js`（host）与 `client.js`（面板）。
- 改面板后需要重建；要免刷新热更，得同时跑 DSH 仓库的 `pnpm run dev:web`（本仓库没有这个脚本）。

## 目录

```
docs/           PRD 与技术设计
src/ledger/     事件日志、投影、状态机、租约、队列、报表
src/dedupe/     归一化、指纹、SimHash、三级判定
src/cdp/        Chrome、CDP、响应捕获、平台适配、点击
src/discover/   岗位列表解析与入账
src/resume/     简历解析、脱敏、招呼语填槽
src/run/        投递编排、判定、证据、熔断、配速
src/reconcile/  对账与回填
src/api/        面板 API（契约、视图、处理器、挂载）
src/client/     面板 UI
assets/         skill 正文
scripts/        硬规则扫描
```

## 许可

MIT
