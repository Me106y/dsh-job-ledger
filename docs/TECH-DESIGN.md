# dsh-job-ledger · 技术设计

| 项 | 内容 |
|---|---|
| 版本 | v0.1 |
| 日期 | 2026-11-03 |
| 对应 PRD | [PRD.md](./PRD.md) v0.6（36 项决策） |
| 读者 | 实现者（自己）、未来的协作者、评审 |
| 范围 | 只覆盖 v0.1（仅 BOSS、单平台、双端） |

**读法**：PRD 说做什么，本文说怎么做、为什么这么做、哪里还没验证。凡是没验证的，本文用 ⚠️ 标记并归入 §20「待实测」，不允许当作已知。

---

## 1. 设计约束

四条硬约束，任何设计取舍都要先过这四条：

| # | 约束 | 来源 | 后果 |
|---|---|---|---|
| C1 | **单进程**：账本与点击都在 DSH host 进程内 | 消灭"记账与点击之间的缝" | 不需要 IPC、不需要跨进程锁；但长任务必须自己做状态机 |
| C2 | **零原生依赖**：host 侧只用 Node 内置 | 一键装、不需要编译 | 无 SQLite、无 Playwright；CDP 要手写；存储用 JSONL |
| C3 | **只监听不重放**：不构造、不签名、不伪造请求头 | 风控与合规底线 | 一切数据来自"页面自己发的请求"；拿不到就报错，不许绕过 |
| C4 | **崩溃可恢复**：任何时刻断电，重启后状态自洽 | 账本是产品价值本身 | 只追加日志 + fsync + 重放截断即停 |

由此推导出的三个"不"：
- **不做**浏览器扩展、不注入 JS 到页面（那是重放的同义词）；
- **不做**多实例并发（一个 host 进程一个 run）；
- **不缓存**接口响应的"可重放副本"（缓存只用于同一轮内的解析）。

---

## 2. 运行时视图

```
┌────────────────────────── DSH host 进程（Node 22/24）──────────────────────────┐
│                                                                              │
│  cordis plugin: dsh-job-ledger                                               │
│  ┌────────────┐  ┌──────────┐  ┌───────────┐  ┌────────┐  ┌───────────────┐  │
│  │ skill      │  │ tools    │  │ host-api  │  │ run    │  │ ledger        │  │
│  │ (静态文本) │  │ (8 个)   │  │ (路由)    │  │ (长任务)│  │ (事件 + 索引) │  │
│  └────────────┘  └────┬─────┘  └─────┬─────┘  └───┬────┘  └───────┬───────┘  │
│                       │              │            │               │          │
│                       └──────────────┴────────────┴───────────────┘          │
│                                      │                                       │
│                              ┌───────▼────────┐                              │
│                              │ dedupe / filter │                             │
│                              └───────┬────────┘                              │
│                                      │                                       │
│                              ┌───────▼────────┐    ┌──────────────┐          │
│                              │ cdp (boss.js)  │    │ evidence/    │          │
│                              └───────┬────────┘    └──────────────┘          │
└──────────────────────────────────────┼───────────────────────────────────────┘
                                       │ WebSocket (127.0.0.1:9222)
                              ┌────────▼─────────┐
                              │ 专用 Chrome      │  child_process 拉起
                              │ 独立 user-data   │  用户扫码一次
                              └──────────────────┘

浏览器侧：
  DSH Web 前端 → client bundle（同一个 npm 包，第二个入口）
                 ├─ sidebar.panellist → 图标
                 └─ main             → 四屏面板（fetch /job-ledger/api/*）
```

**关键点**：panel 不直接碰 CDP，也不直接读文件。它只调 host-api，host-api 只调 service。这条单向依赖是后面所有并发安全的前提。

---

## 3. 包与构建

### 3.1 package.json 关键字段

```jsonc
{
  "name": "dsh-job-ledger",
  "type": "module",
  "engines": { "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.2.1-rc.1" },
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "assets", "cordis.patch.yml", "README.md", "LICENSE"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ],
      "external": [
        "react", "react-dom", "react/jsx-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/schemastery": "~3.18.5",
    "@deepseek-ai/dsh-tools": ">=0.2.1-rc.1",
    "@deepseek-ai/dsh-host-webserver": ">=0.2.1-rc.1"
  }
}
```

- `external` 必须写：client bundle 不能把 React 和 DSH 客户端包打进去，否则会出现两份 React。**要逐个列包名，不要用通配**——DSH 客户端包的 `external` 是按名字精确匹配的，`@deepseek-ai/*` 这种写法未经验证，宁可啰嗦。
- 产物入库（`lib/*.js`）：用户 `npm i` 后不需要构建，也不需要 tsdown/pnpm。
- 兼容性由 `engines.dsh` 声明，DSH 安装时会检查。

### 3.2 目录结构

```
src/
├─ index.ts                 # host 插件入口：Config、依赖注入、装配
├─ config.ts                # schemastery 配置 schema
├─ skill.ts                 # 从 assets/job-ledger/SKILL.md 读入并注册
├─ settings.ts              # 面板可改的目标（写 profile/set，读投影）
├─ tools/                   # 8 个 defineTool
│  ├─ profile.ts resume.ts discover.ts queue.ts
│  └─ apply.ts record.ts reconcile.ts report.ts
├─ api/
│  ├─ contract.ts           # type-only：面板↔host 的 Api（不打包 host 代码）
│  ├─ routes.ts             # ctx.webServer.register 路由表
│  └─ views.ts              # 只读投影（Queue/Overview/Reconcile/Settings）
├─ run/
│  ├─ machine.ts            # run 状态机（纯函数，可单测）
│  └─ executor.ts           # 串起 claim→cdp→record
├─ ledger/
│  ├─ events.ts             # 事件类型 + 版本
│  ├─ store.ts              # 追加、fsync、重放、索引
│  ├─ skip.ts               # 待投删除：写 job/status = skipped（#34）
│  └─ project.ts            # 内存投影
├─ tracker/                 # 投递表（PRD §5.11）
│  ├─ sheet.ts              # 列名对齐、路径校验、行形状
│  ├─ xlsx.ts zip.ts        # 无依赖的最小 OOXML/ZIP 读写
│  ├─ numbers.ts            # AppleScript 驱动 Numbers
│  └─ sync.ts               # 双向同步
├─ dedupe/
│  ├─ normalize.ts fingerprint.ts simhash.ts
│  └─ decide.ts             # 三级判定（纯函数）
├─ filter/rules.ts          # 硬过滤 + 排序分
├─ reconcile/boss.ts        # deliverList 拉取、匹配、四类冲突
├─ cdp/
│  ├─ chrome.ts             # 启动/探测/复用/关闭
│  ├─ session.ts            # WebSocket + CDP 请求/事件分发
│  ├─ network.ts            # 响应捕获与 body 读取
│  └─ boss.ts               # ⚠️ 唯一平台适配层（选择器、URL、字段映射）
├─ client/
│  ├─ index.tsx             # slot 注册
│  ├─ api.ts                # caller + usePoll
│  ├─ app.tsx               # 四屏容器
│  ├─ queue.tsx overview.tsx reconcile.tsx settings.tsx
│  ├─ styles.ts             # 面板样式（注入一个 <style>）
│  └─ locales.ts
└─ shared/errors.ts         # 错误码（host 与 client 共用）
assets/
├─ job-ledger/SKILL.md
└─ icon.svg
test/
├─ dedupe/*.test.ts         # golden corpus
├─ ledger/*.test.ts         # 重放、崩溃、租约
├─ run/*.test.ts            # 状态机
└─ fixtures/cdp/*.json      # 录制回放
```

**边界规则**：`client/` 不得 import `cdp/`、`ledger/`、`run/`。它只能 import `api/contract.ts`（type-only）和 `shared/errors.ts`（常量）。这条规则用 lint 或 tsconfig `references` 强制。

### 3.3 构建

- 两个入口：`src/index.ts` → `lib/index.js`；`src/client/index.tsx` → `lib/client.js`。
- tsdown 配置两份。client 那份用 `deps.neverBundle` 按**名字**外置 `react`、`react-dom`、`react/jsx-runtime` 与用到的 DSH 客户端包（`deps.neverBundle` 与 `external` 互斥，tsdown 0.22 起写前者）。
- **client 产物必须是 classic script，不能是 ESM**：DSH 用一个 classic `<script>` 挂载 client bundle（`dsh-client-modules` 的 `defaultLoadBundle`），文件里出现顶层 `import`/`export` 就会被浏览器判为 `SyntaxError: Cannot use import statement outside a module`——该条目不激活，Web 启动提示 `<包名>: import failed`，其余插件照常。正确形态是 CJS 包在模块加载器的工厂闭包里：

  ```js
  window.__ModuleLoader__.load({ id: "dsh-job-ledger", factory: (require) => { /* … */ return module.exports } })
  ```

  由 `tsdown.config.ts` 的 `banner` / `intro` / `footer` 生成；`id` 必须等于包名（启动图按这个名字归档）。页面里没有 import map，裸模块说明符只由工厂收到的 `require` 解析。`pnpm build` 末尾跑 `scripts/check-client-bundle.ts`，用 vm 按 classic script 真跑一遍产物，形态错了直接构建失败。
- CSS：`import './client.css'` 由 tsdown 注入，DSH 用设计 token（`--dsh-*`），不自造色板。
- 开发循环：改 host 代码 → 重启 plugin（HMR 或 `ctx.fiber.restart()`）；改 client → 需要 `pnpm run dev:web` 才能免刷新，否则重建 + 刷新页面。**这个约束要写进 README**，否则每次改 UI 都会以为坏了。

**实现**：`tsdown.config.ts` 导出两个配置；client 用**命名入口**，产物固定落在 `lib/client.js`（`package.json` 的
`exports` 就是这个路径）。两个配置都设 `clean: false`，清空 `lib` 由 `build` 脚本用 node 做一次——否则两个
并行构建会互相删产物。client 把 `react` 与 DSH 客户端包按**名字**外置，打包它们等于往页面里再塞一份 React。

---

## 4. 依赖方向

```
tools ─┐
api ───┼─► run ─► cdp(boss) ─► chrome/network
       │      └─► ledger ─► events
       ├─► dedupe / filter
       ├─► reconcile ─► cdp(network)
       └─► skill (只读 assets)
```

**禁止**：`ledger` 反向依赖 `run`；`cdp` 依赖 `ledger`；`client` 依赖任何 host 模块。所有跨层调用走参数传递，不做模块级单例（除了 ledger 实例由 `apply` 注入）。

---

## 5. CDP 层（最难的部分）

### 5.1 启动与复用

```
1. GET http://127.0.0.1:<port>/json/version
   ├─ 200 → 复用（但需校验是不是我们的 profile：比对 /json/version 的 "Browser" 与 userDataDir 记录）
   └─ 连接失败 → 启动
2. spawn(chrome, [
     `--remote-debugging-port=${port}`,
     `--user-data-dir=${dataDir}/chrome-profile`,
     '--no-first-run', '--no-default-browser-check',
     '--restore-last-session=false',
     '--disable-background-timer-throttling'
   ])
3. 轮询 /json/version，最多 15s，每 200ms；起不来 → E_CHROME_NOT_STARTED
```

**登录态（实现）**：profile 固定在 `dataDir/chrome-profile`，cookie 跨进程复用，「扫一次」是真的。
检测到登录墙时 `job_ledger_login` 打开 `/web/user/`，**点开「APP扫码登录」tab**（`.btn-sign-switch`，
2026-11-03 从真实 DOM 读到、点击后截图确认二维码出现；找不到该 tab 就算了，验证码登录照样能用），
然后等待扫码（默认 3 分钟，可传 `timeoutSeconds`），
**URL 离开登录页**即视为成功（真机观察：未登录访问任意 geek 页都会重定向到 `/web/user/`）；超时返回
`E_LOGIN_REQUIRED`，不假装成功。cookie 过期就再扫一次——插件不会替用户登录。

**关键点**：

- **必须用独立 `user-data-dir`**。Chrome 136+ 起，对默认 profile 打开远程调试会被拒绝；而我们本来就要独立 profile 存 BOSS 登录态，两者正好一致。
- 端口固定 9222 但**可配置**；被占用且不是我们的实例 → 报错而不是杀进程（可能占着别的调试会话）。
- Chrome 可执行文件路径：macOS `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，Windows 两个候选路径，Linux `google-chrome` / `chromium`。检测顺序写死在 `chrome.ts`，失败报 `E_CHROME_NOT_FOUND` 并给出"装 Chrome 或设置 config.chromePath"的提示。
- **不自动杀 Chrome**。用户可能同时在看别的页面；退出时只关闭我们创建的 tab。

### 5.2 连接

- 用 `/json/list` 拿到 page target 的 `webSocketDebuggerUrl`；
- 单连接、单 tab，`Target.attachToTarget` 不必要（直连 page target）；
- 请求用自增 `id`，`Map<id, {resolve, reject, timer}>` 分发；事件用 `method` 订阅表分发；
- 超时：命令级 10s（截图 20s，导航 30s）；
- 断线：`ws.on('close')` → 所有 pending 请求 reject `E_CDP_DISCONNECTED` → 本轮熔断。

### 5.3 请求捕获（核心机制）

```ts
await send('Network.enable', {})
on('Network.responseReceived', async ({ requestId, response }) => {
  const url = response.url
  if (!matchAny(url, PATTERNS)) return
  // 必须在页面跳转/资源释放前取 body
  const { body, base64Encoded } = await send('Network.getResponseBody', { requestId })
})
```

坑与对策：

| 坑 | 对策 |
|---|---|
| `getResponseBody` 报 "No resource with given identifier" | 说明 body 已被回收。重试 1 次；仍失败 → `E_BODY_UNAVAILABLE`，不猜测内容 |
| 页面 SPA 路由切换不触发新请求 | 导航用 `Page.navigate` 到**带查询参数的完整 URL**，或先 `Page.reload` |
| 响应是 gzip/br | CDP 已解码，`base64Encoded` 为 true 时手动 `Buffer.from(body,'base64')` |
| 同一 URL 被多次请求 | 用 `requestId` 去重，取**最后一次**；并记录 `timestamp` 供判定新鲜度 |
| 请求发出但页面先崩了 | 超时后返回 `E_NAV_TIMEOUT`，不返回半份数据 |

`PATTERNS` 集中在 `cdp/boss.ts`：

```ts
export const BOSS = {
  base: 'https://www.zhipin.com',
  pages: { resume: '/web/geek/resume', jobs: '/web/geek/jobs' },
  api: {
    resumePreview: /geek\/preview\/data\.json/,
    resumeBase:    /zpgeek\/resume\/baseinfo\/query\.json/,
    resumeExpect:  /zpgeek\/resume\/expect\/query\.json/,
    resumeStatus:  /zpgeek\/resume\/status\.json/,
    search:        /zpgeek\/search\/joblist\.json/,
    recommend:     /zpgeek\/pc\/recommend\/job\/list\.json/,
    deliverList:   /zprelation\/resume\/geekDeliverList/,
    // ⚠️ 待实测：发送简历、开始沟通的请求名
    greet:         /TBD/,
    sendResume:    /TBD/,
  },
}
```

### 5.4 登录态判定

三个信号，优先级从高到低：

1. **业务码**：响应 `code === 37`（stoken 过期）→ 明确未登录；
2. **URL**：导航后 `page.url` 包含 `/web/user/` 或 `login`；
3. **DOM 标记**：`document.querySelector('[ka*="user-resume"]')` 存在。

三者任一命中即 `E_LOGIN_REQUIRED`，并**不再继续**（不做"重试三次再说"）。理由是登录态问题重试无意义，只会增加异常请求。

### 5.5 点击与输入

**不用 `element.click()`**，因为它产生的是 `isTrusted: false` 的合成事件，风控可识别。用真实输入事件：

```
1. Runtime.evaluate: 找到元素 → scrollIntoView → 返回 getBoundingClientRect 中心点
2. Input.dispatchMouseEvent { type:'mouseMoved', x, y }
3. Input.dispatchMouseEvent { type:'mousePressed', button:'left', clickCount:1 }
4. Input.dispatchMouseEvent { type:'mouseReleased', button:'left', clickCount:1 }
```

文本输入用 `Input.insertText`（先 `focus()`），不用 `element.value = ...`——后者不触发 React 的 onChange，BOSS 前端会认为输入框是空的。

**坐标失效**：点击前 `getBoundingClientRect` 可能被布局变化作废。对策：先滚动到元素可见，取坐标，**立即**在同一帧发点击；失败（元素消失/被遮挡）→ 重试一次，再失败 → `E_SELECTOR_MISSING`。

**实现**：`src/cdp/browser.ts` 的 `CdpReader.click / typeText / waitFor / text`。点击按上面四步发真实输入事件，
点完后复查元素仍在，否则重试一次；输入用 `Input.insertText`（先 `focus()`）。

**招呼语**（PRD §5.5）：`src/resume/greeting.ts` 按模板填槽，`[[...]]` 表示可选分句——分句内任一槽位取不到，
整句消失。模型可以选模板、提议槽位值，但每个值都要过"原文出处"校验（简历或 JD 里能逐字找到），
否则该槽位与所在分句一起被丢弃。链接、邮箱、微信一律拒绝，超长按 100 字截断。

**模板文本也过同一道闸**：`FORBIDDEN` 原本只查槽位值，而自定义模板文本（模型或调用方可传）不做校验，
等于留了一条"把联系方式写进模板"的后门。现在模板文本命中禁用模式就退回默认预设——决策 25 要的是
"预设 + 填槽"，不是自由散文。

### 5.6 成功判定（B 级判据）

**首选**：监听页面自己发出的"发送简历"请求的响应（`sendResume`，⚠️ 待实测），`code === 0` 即成功。
**兜底**：DOM 中聊天流出现"简历卡片"节点（选择器 ⚠️ 待实测），且时间戳晚于点击时刻。

```
点击 → 状态 applying
  ├─ 监听到 sendResume 成功 且 DOM 出现卡片 → submitted
  ├─ 监听到 sendResume 成功 但 DOM 未出现（2s 内） → submitted（以网络为准，标记 domUnconfirmed）
  ├─ 超时 15s 无任何证据 → uncertain   ← 永不自动重试
  └─ 监听到 code ∈ {9,31,32,36,37} → 熔断（halt）
```

**为什么以网络为准**：DOM 会因改版失效，而"简历确实发出去了"的权威证据是平台自己的响应。DOM 只是辅助确认。反过来如果只有 DOM 没有网络证据，也要判 `uncertain`——宁可不确定，不可假成功。

**实现**：`src/cdp/applier.ts` 在**点击之前**挂上 `sendResume` 的 capture——请求是点击自己触发的，
晚挂一步就永远等不到。读不出 body 的响应记为 `none`，绝不当作成功。

**实现（判定）**：`src/run/attempt.ts` 的 `judgeAttempt(signals)` 是纯函数，输入是"点了没有 / 网络信号 / DOM 是否见到卡片"，
输出的判定表与上面四条分支一一对应；`haltReasonForFailure(code)` 只把 `isFatal` 的码映射成 `HaltReason`，
执行层不需要记住哪几个码是整轮级的。

### 5.7 证据

```
Page.captureScreenshot { format:'png', captureBeyondViewport:false }
  → Buffer.from(data,'base64')
  → writeFile(`${dataDir}/evidence/${appId}.png`)
  → 事件里只存**相对路径**，不存 base64（避免日志膨胀）
```

同时把聊天流文本片段（`innerText`，截断 500 字）写进事件的 `note`，便于日后核对。

**实现**：`src/run/evidence.ts`。截图写 `0600`、目录 `0700`；事件里只存相对路径。
证据写不进去视为 fatal（`E_LEDGER_WRITE`）——继续跑就等于记录一批"没有证据的 submitted"，
正是设计要消灭的状态。

**状态记 `uncertain`，不是 `failed`**（PRD §15 决策 30）：网络已经确认发出，只是证明丢了。
`failed` 不在阻断状态里，该岗位会重新可投——再投一次就是重复投递；`uncertain` 只能由人核对平台后推进。
本轮仍以 `ledger-write` 熔断。

### 5.8 错误与恢复

| 情况 | 处理 |
|---|---|
| WebSocket 断开 | 本轮 halt，reason `cdp-disconnected`；重连后**不自动续跑** |
| tab 被用户手动关掉 | 同上，`target-closed` |
| Chrome 崩溃退出 | 同上，`chrome-exited`；下轮启动时重新拉起 |
| 进程在投递中退出 | 残留的 `applying` 在插件挂载时被改成 `uncertain`（`src/run/recovery.ts`）：`applying` 不阻断重投，租约过期后同一岗位会再次可投，而点击可能已经发出 |
| 导航 30s 超时 | 该岗位 `failed`（连续 2 次则 halt） |
| 页面被风控跳转到验证页 | 立刻 halt，reason `captcha`，并把截图存进证据（用户需要看到拦截页） |

### 5.9 一轮的时序

```
run.start(ids)
  │
  ├─ reconcile()                    前置校验；不平账 → 拒绝开跑
  ├─ for id in ids:
  │    ├─ lease.claim(id, runId, 600s)      失败 → 跳过，记 blocked
  │    ├─ Page.navigate(jobUrl)
  │    ├─ waitFor(点击目标可见, 10s)        超时 → failed
  │    ├─ click('立即沟通')
  │    ├─ [Network] 等 greet 响应            code≠0 → 按错误码表处理
  │    ├─ [Network] 等 sendResume 响应       ──► submitted
  │    ├─ screenshot + note
  │    ├─ record(appId, submitted)
  │    ├─ lease.release(id)
  │    └─ sleep(30–90s)；每 5 个 → sleep(3–5min)
  ├─ reconcile()                    收尾校验；差异写事件
  └─ run.end(summary)
```

---

## 6. 账本层

### 6.1 事件

事件全集见 PRD §6。这里补几条实现约定：

1. **每行必须自洽**：一条事件包含足够信息重建它影响的实体，不依赖"上一条"的隐含状态（便于未来并行重放）。
   `profile/set` 由面板「设置」写入，一条事件带完整的 `target` 三元组，重放后无需再读任何配置文件。
2. **`at` 由写入方给，不由读方补**：重放不得修改时间。
3. **未知 `type` 跳过并计数**：向前兼容——旧版本读到新事件不崩，只丢该事件的影响。
4. **`app/state` 的 `note` 与 `evidence` 进入投影**：面板要能直接显示"为什么 failed / uncertain"
   和证据路径，而不必回溯事件流。
5. **`profile/set` 也可以带 `tracker.path`**（PRD §5.11）：它只影响投递表同步，不参与判重与投递决策；
   没有这个字段时投递表视为未启用。

```jsonc
{ "v":1, "at":"2026-11-03T06:12:00.000Z", "type":"job/add",
  "job":{ "id":"j_1","platform":"boss","externalId":"...","fingerprint":"a1b2...",
          "jdHash":"0000...","status":"new","source":"search" } }
```

### 6.2 写入

- **单写者**：只有 `Ledger` 实例写文件。`run`、`tools`、`api` 都通过它写，不存在第二个 fd。
- 追加：`writeSync(fd, line)` + `fsyncSync(fd)`，串行队列（`pending` promise 链），不允许并发 `write`。
- 行大小上限 64KB；JD 文本入库前截断 20k 字符，避免单行过大。
- 写失败（磁盘满/只读）→ 抛 `E_LEDGER_WRITE`，本轮立即 halt。**绝不吞掉**。
- 检查 `writeSync` 的返回值：**短写即失败**，且在 `fsync` 之前抛出——否则半行会被 fsync 固化。

### 6.3 重放

```
readFile → split('\n')
for line:
  if 空 → skip
  try parse → apply
  catch → 停止（记录 truncatedAt），不回滚已应用的
```

停止而不是跳过，是因为截断的尾巴之后的字节不可信（可能是半行拼接）。已应用的保持，后续从"最后成功行"继续追加。

**结构校验**：事件缺少该 type 的必填字段时抛 `E_LEDGER_STATE` 并带上行号，拒绝启动；
不允许一条半截事件在 apply 深处炸成 `TypeError`。

**版本迁移**：`v` 字段只增不改。遇到 `v > 1` 且无法理解 → 拒绝启动并提示升级插件（宁可不动，不可写坏）。

### 6.4 索引

内存里维护四个索引，全部在 `apply` 里增量维护：

| 索引 | 键 | 值 | 用途 |
|---|---|---|---|
| `byKey` | `platform:externalId` | jobId | 同平台判重（O(1)） |
| `byFingerprint` | fingerprint | jobId | 同公司同岗位判重（O(1)） |
| `byDay` | `YYYY-MM-DD` | jobId[] | SimHash 只在 45 天窗口内比较 |
| `byState` | state | appId[] | 面板与报表 |

**为什么按天分桶**：不做全量 SimHash 比较。45 天窗、每天 50 条 ≈ 2250 条，逐条比汉明距离可接受；全量比较在一年后是 O(n²) 的坏味道。

### 6.5 租约与并发

- `run` 层有**全局互斥**：同时只允许一个 run（`this.activeRun`）。第二个 `startRun` 直接返回 `409 E_RUN_ACTIVE`。
- `job` 层有**租约**：即使未来允许多 run，也不会重复投同一岗位。TTL 10 分钟，`expiresAt < now` 视为空闲。
- 租约与 app 状态**双重校验**：claim 时若已有 `submitted/uncertain/replied/...` 的 app，直接拒绝（`E_ALREADY_APPLIED`），防止租约过期后的重复。

### 6.6 快照与压缩

v0.1 **不做压缩**。理由：单用户一年最多几万条事件，JSONL 读入 < 100ms；压缩会引入"快照与事件不一致"的新 bug 类别。

只做一件：每周导出 `snapshot.md`（报表）到工作区，作为人肉备份。

**实现**：`src/report/snapshot.ts` 的 `weeklySnapshot()` 用 ISO 周标记（`snapshot-week`）保证一周只写一次；
插件挂载时执行，写失败只吞掉异常不影响启动——报表是便利，账本才是产品。

**报表口径**（与 PRD §5.8 一致，P0 已实现）：

- 「投递」只计已确认进入 `submitted` 及之后阶段的申请；`applying` / `failed` / `uncertain`
  单列为 `unconfirmed`，**不进分母**。分母被未确认的点击撑大，会让每个转化率都偏低。
- 「来源」按 `job.source`（search / recommend）分组，不是按申请的记录来源；
  问的是"哪个渠道值得加投"，那是岗位的属性。

---

## 7. 判重引擎

### 7.1 归一化

| 字段 | 规则 | 已知副作用（接受） |
|---|---|---|
| 公司 | NFKC → 小写 → 去空白 → 去「股份有限公司/有限公司/集团/控股/科技/网络/信息技术/技术/软件/电子商务」→ 去「北京市」类前缀 | 「小米科技」与「小米」归一；「上海汽车」不会误伤（只去 2 字+市） |
| 职位 | NFKC → 去「急招/急聘/双休/五险一金」→ 去「岗位/职位」后缀 → 去空白。**括号内容与资历词保留**（决策 #29） | 「高级后端工程师（急招）」→「高级后端工程师」；「后端工程师（Java）」≠「后端工程师（Go）」 |
| 城市 | 去「市/地区/站」→ 远程统一 `remote` | 「远程/全国/不限」都归 `remote` |
| URL | 去 hash、去全部 query | 跟踪参数不产生第二身份 |

**不做中文分词、不做拼音、不做同义词**（「后端」≠「服务端」）。理由：这些都会引入不可解释的误判，而误判不可恢复。宁可漏判。

**决策 #29（PRD §15）**：括号限定词与资历词属于职位身份，不参与归一。代价是漏判变多——
同一个岗位的「高级」与「普通」版本会分别出现；这是"宁可漏判，不可误杀"方向上的一次明确选择。
`test/dedupe/corpus/cases.json` 用两条用例钉住：`a bracket qualifier is part of the role`、
`a seniority word is part of the role`。

### 7.2 指纹

```
fingerprint = sha1(companyNorm + "\u0001" + titleNorm + "\u0001" + cityNorm).slice(0,16)
```

### 7.3 SimHash

- 64 位；token = 拉丁词（≥2 字符）+ 中文 bigram；
- 阈值 **≤ 3**（汉明距离），且**必须同城**；
- 只在 45 天窗口内比较；
- `jdHash` 存 16 位十六进制字符串（64 位整数放进 JSON number 会丢精度），空串视为"无 JD"，
  跳过 SimHash 判重（回填数据就是这种）。
- **token 少于 20 个的文本不生成哈希**（`MIN_JD_TOKENS`）：占位文本（如「面议」）只有一两个
  bigram，两个不相干的短文本可能偶然落进汉明距离阈值内，造成跨公司误判。真实 JD 是 500–2000 字，
  阈值远高于 20；⚠️ 具体数值待真机 JD 分布确定（§20）。

**为什么 ≤3 而不是 ≤8**：JD 文本通常 500–2000 字，bigram 维度高，距离 4 以上已经可能不是同一个岗位；阈值放宽会直接造成误杀，而误杀不可恢复。

### 7.4 三级判定（伪代码）

```ts
function decide(cand, state, now) {
  // 1. 硬重复
  if (state.byKey.has(`${cand.platform}:${cand.externalId}`)) return DUP('same-posting')
  if (state.byFingerprint.has(cand.fingerprint)) {
    const job = state.job(state.byFingerprint.get(cand.fingerprint))
    if (now - job.firstSeenAt < 45d) return DUP('same-role-company')
  }
  // 2. 跨来源同岗位
  for (job of state.jobsInWindow(45d, cand.cityNorm)) {
    if (job.jdHash && hamming(job.jdHash, cand.jdHash) <= 3) return DUP('cross-source-same-jd')
  }
  // 3. 冷却
  for (app of state.activeApps(companyNorm=cand.companyNorm, titleNorm=cand.titleNorm)) {
    if (now - app.updatedAt < 90d) return DUP('cooldown')
  }
  // 4. 疑似（不剔除，进待裁决）
  if (state.byFingerprintCompanyTitle.has(key(cand))) return SUSPECT('same-title-different-jd')
  // 5. 硬过滤
  const r = filter(cand, state.profile); if (r) return FILTERED(r)
  return NEW
}
```

顺序有意义：**先判重、后过滤**。反过来的话，一个被判重拦下的岗位会显示成"不符合条件"，用户会以为筛选器太严。

**P0 实现时的两处收敛**（硬规则优先于上面伪代码的宽松写法）：

- **城市必须相同**才走 SimHash 判重。伪代码里 `jobsInWindow(45d, cand.cityNorm)` 已按城市过滤，
  实现同样如此；跨城相似 JD 一律不算重复。
- **同公司不同职位永远算新岗位**，所以同公司 + 标题不同时直接跳过 SimHash 判重，哪怕 JD 一字不差
  （PRD §5.3 硬规则）。
- 疑似重复只剩一种情形：同「公司 + 职位 + 城市」但首次见到已在 45 天窗口之外，可能被重新发布。
  它进待裁决，不自动剔除。

### 7.5 误杀防护

- 疑似区**不进自动剔除**，必须用户裁决；
- 被过滤的岗位保留 `reason`，可一键捞回；
- 每条决策写 `job/decision` 事件，带 `reason` 与 `duplicateOf`，事后可审计"为什么没投它"。
- **无裁决不入队列**：队列只列有 `job/decision` 的岗位。回填与对账产生的岗位没有裁决事件，
  若按"默认 new"展示，等于引诱用户去投一个已经投过的岗位。
- **重复不落库**：判为 duplicate 的岗位只计数并记入 `ingest/summary`，不追加 `job/add`。
  否则每次扫描都会让事件日志线性膨胀，而日志本身就是产品价值；`duplicateOf` 指向已经持有
  该身份的岗位，理由仍然可追。

---

## 8. 筛选与排序

### 8.1 求值顺序

```
硬过滤（确定性，可解释）
  ├─ 公司黑名单
  ├─ 排除关键词（title + JD）
  ├─ 城市（remote 放行）
  └─ 薪资下限（仅当双方都可解析）
        ↓
排序（模型可参与，仅排序不淘汰）
```

### 8.2 模型介入点

模型只做两件事：
1. 给每个候选一个 `fitScore`（0–100）+ 一句理由；
2. 生成日报的自然语言结论。

**模型不得**：改变判重结论、删除候选、修改筛选规则。

### 8.3 排序分

```
score = 0.5 * fitScore
      + 0.2 * 新鲜度（48h 内 1.0，之后线性衰减到 0）
      + 0.2 * 关键词命中率（JD 中命中简历技能的比例）
      + 0.1 * 公司规模/融资阶段（⚠️ 可选，取不到则为 0）
```

排序分不落库（每次算），`fitScore` 落 `job/decision` 事件以便复现。

---

## 9. 投递执行

### 9.1 run 状态机

```
        startRun()
           │
           ▼
   ┌──► queued ──► running ──┬──► done
   │                 │       ├──► halted  (熔断)
   │                 │       └──► done-with-errors（全部失败但未触发熔断）
   │                 ▼
   └──resume────── paused
```

状态转移是纯函数：`transition(state, event) -> state`，单测覆盖全部分支（含非法转移返回错误）。

### 9.2 幂等

同一岗位在以下任一条件下不再投：
1. `app.state ∈ {submitted, uncertain, replied, interview, offer, rejected, withdrawn}`；
2. 活跃租约存在且未过期；
3. 本轮 `attempted` 集合已包含（内存去重，防 DOM 点击两次）。

三条叠加，保证"手抖点两次"和"面板+对话同时投"都不会重复。

**实现**：`src/run/executor.ts` 的 `JobRunner` 在**每次**尝试前重新做这三项检查（不是开跑时检查一次）。
拒绝开跑——活动 run、额度不足、ids 非法——发生在写任何事件之前，因此被拒的一轮不会留下半截
`run/start`。整批中途熔断时，已投的记录保留，剩余项留在 `queued`，下一轮重新授权。

### 9.3 节奏

```
baseGap = uniform(30, 90) 秒
每 5 个成功 → baseGap + uniform(180, 300) 秒
run 内累计投递 > 单轮上限(10) → 停止，剩余回 queued
当日累计 > 每日上限(30) → 拒绝 startRun（E_DAILY_QUOTA）
```

**上限不可配置**（写死），防止用户一时冲动改大。

**实现**：`src/run/pacing.ts`，纯函数，随机源可注入以便测试。额度检查是**整批拒绝**而不是截断：
截断会让用户勾选的一部分静默不投，比"今天只剩 3 个额度"更难解释。

### 9.4 熔断

触发条件（任一）：

| 条件 | reason |
|---|---|
| `uncertain` 出现 | `uncertain` |
| 业务码 9 / 31 / 32 / 36 / 37 | `rate-limited` / `ip-restricted` / `account-restricted` / `account-risk` / `stoken-expired` |
| 页面出现验证码 | `captcha` |
| 连续 2 次 `failed` | `consecutive-failures` |
| CDP 断开 / Chrome 退出 | `cdp-disconnected` |

**实现**：`src/run/breaker.ts`，`observe(state, outcome)` 是纯函数折叠。`uncertain` 与显式 halt 立即停；
`failed` 累计到 2 次停；业务码、验证码、CDP 断开由执行层映射成 `HaltReason` 后以 `halt` 传入——
数字到语义的映射留在平台适配层，熔断器不认识 BOSS 的错误码。

熔断后：
- 写 `run/halt` 事件（含 reason 与当时的截图）；
- 剩余项回 `queued`；
- **不自动恢复**。用户必须手动点"继续"（面板）或说"继续"（对话），且恢复前强制再对账一次。

### 9.5 授权

`startRun(ids, grantedBy)`：

```ts
type GrantedBy =
  | { kind: 'panel'; at: string }        // 面板按钮：技术强制
  | { kind: 'model'; at: string }        // 工具调用：靠 skill 约束
```

**工具侧的纵深防御**（因为对话路径不可强制）：
- `apply` 工具要求 `ids` 非空且 ≤ 10；
- 每个 id 必须存在且当前可投（状态/租约校验）；
- 单轮上限写死在代码里，不读配置；
- 返回结果里回显 `grantedBy`，会话日志可追溯"是谁授权的"。

---

## 10. 对账

### 10.1 拉取

```
navigate('/web/geek/chat')  // deliverList 的 referer 在这里
listen(/geekDeliverList/) → 拿到第一页
翻页：最多 10 页（config.reconcile.maxPages），每页间隔 1–2s
```

⚠️ 分页参数待实测（可能是 `page`/`cursor`）。若只能拿到第一页，明确告知"仅校验最近 N 条"，不假装全量。

**实现**：`src/reconcile/read.ts` 目前**只读第一页**，并固定返回 `partial: true`——工具的输出里会写明
"只核对了平台最近一页，差异可能包含更早的投递"。接口 pattern 按 `geek/deliver/list.json` 实现，同样待实测。

### 10.2 匹配

1. **主键**：`encryptJobId` ↔ 账本 `externalId`；
2. **兜底**：`companyNorm + titleNorm + cityNorm` 指纹；
3. 都匹配不上 → 视为"平台有、账本无"，走补记。

**实现**：`src/reconcile/boss.ts` 的 `reconcile()`。先按 `platform:externalId`，再按指纹；两条都不中才补记。
补记的 app 用 `source: 'reconcile'`、`resumeId: 'unknown'`（平台没说是哪份简历），时间取平台字段。

### 10.3 冲突（与 PRD §5.7 一致）

```ts
if (platformHas && !ledgerHas)      backfill('submitted', 'reconcile')
if (ledgerHas && !platformHas)      discrepancy('ledger-only')     // 不改状态
if (ledgerSaysQueued && platformHas) backfill('submitted', 'reconcile')
if (ledgerSaysRejected && platformHas) /* 不动 */
```

### 10.4 回填

- 幂等：以 `platform:externalId` 去重，重复对账不产生重复事件；
- `source: 'reconcile-backfill'`，`resumeId: 'unknown'`；
- 只进判重索引，不进报表（`report()` 过滤 `source !== 'reconcile-backfill'`）；
- 不写 `evidence`（没有截图，也不该伪造）。

**实现**：`job_ledger_backfill` 工具复用同一条读取路径（同样**只读第一页**），`source: reconcile-backfill`。
重复执行按 `platform:externalId` 幂等；输出会明说"只导入了平台最近一页"。

**差异列表不落库**：锁定的 schema 只有 `reconcile/summary`（计数），所以"账本有、平台无"的行由
`reconcile()` **返回**给调用方（工具/面板）显示，不新增事件类型。重启后列表清空，重新对账即可——
为一张诊断清单改动事件 schema 不划算。

---

### 10.5 投递表同步（PRD §5.11）

- 读：`.xlsx` 走 `tracker/xlsx.ts`（ZIP + OOXML，只用 Node 内置 `zlib`）；`.numbers` 走 `tracker/numbers.ts`（`osascript` 驱动 Numbers.app，不解析二进制）。
- 写：只改匹配到的行，其余行与归档其余部件原样复制；同一个 ZIP 重新打包后原子替换。
- 历史导入复用 `reconcile()`，标 `reconcile-backfill`：参与判重，不进转化率（#15）。
- 失败：写表失败**不改投递状态**；面板显示 `E_TRACKER_*`，下一次「立即同步」重试。
- 每次 `submitted` 由 executor 的 `onSubmitted` 回调顺手写一行（不阻塞投递）。

## 11. Host API 契约

### 11.1 约定

- 前缀 `/job-ledger/api/`，由 `ctx.webServer.register({ method, path, handler })` 挂载；
- 同源，依赖 DSH 的会话鉴权；额外要求请求头 `x-job-ledger-request: 1`（防 CSRF 的弱约束，等同 superagent 做法）；
- 响应统一 `application/json; charset=utf-8`；
- 失败：HTTP 状态 + `{ error: string, code: ErrorCode, values?: Record<string,string> }`。

**挂载**：`src/api/mount.ts` 注册**一条** `kind: 'prefix'` 路由 `/job-ledger/api`，handler 直接持有 Node 响应：
读 body（上限 64KB）、解析 JSON、写 `application/json`。没有 web server 的 profile（headless）不挂载，
工具照常工作——面板不是前置条件。

### 11.2 契约（type-only，client 与 host 共用）

```ts
export interface Api {
  'GET queue': { query?: { filter?: 'new'|'suspect'|'filtered'; limit?: number }
                 response: QueueView }
  'GET overview': { response: OverviewView }
  'GET reconcile': { response: ReconcileView }
  'GET run': { response: RunView }
  'GET profile': { response: SettingsView }

  'POST run/start': { body: { ids: string[] }; response: RunView }
  'POST run/pause': { body: { runId: string }; response: RunView }
  'POST run/resume': { body: { runId: string }; response: RunView }
  'POST run/halt': { body: { runId: string; reason?: string }; response: RunView }

  'POST reconcile/run': { response: ReconcileView }
  'POST profile': { body: { roles?: string[]; cities?: string[]; salaryMin?: number
                            trackerPath?: string }
                    response: SettingsView }
  'POST queue/update': { body?: { source?: 'search'|'recommend' }; response: QueueUpdateView }
  'POST jobs/:id/skip': { response: { jobId: string; status: 'skipped' } }
  'GET tracker': { response: TrackerView }
  'POST tracker/sync': { response: TrackerSyncView }
  'POST reconcile/ack': { body: { jobIds: string[] }; response: { acknowledged: number } }
  'POST apps/:id/state': { body: { state: AppState; note?: string }; response: { appId: string; state: AppState } }
}
```

**P5 已实现**：`GET queue / overview / reconcile / run / profile`、`POST run/start`、`POST reconcile/run`、
`POST apps/:id/state`、`POST profile`、`POST queue/update`、`POST jobs/:id/skip`。`run/pause`、`run/resume`、`run/halt`
**没有实现**——executor 还不能暂停一轮，返回 409 会撒谎，所以先不提供；`reconcile/ack` 不落库，改由客户端本地记忆
（差异列表本来就不持久化）。

视图类型（只读投影，均为小对象）：

```ts
interface QueueRow { jobId: string; title: string; company: string; city: string
  salary: string; reason: 'new'|'suspect'; duplicateOf?: string
  blocked?: 'leased'|'cooldown' }
interface QueueView { revision: number; rows: QueueRow[]; suspects: number; filtered: number }
// `POST queue/update` 的结果：一次发现的计数 + 发现后的清单，客户端一次渲染完
interface QueueUpdateView { revision: number; source: 'search'|'recommend'
  added: number; duplicates: number; filtered: number; suspects: number; invalid: number
  queue: QueueView }
interface OverviewView { revision: number; today: { submitted: number; quota: number }
  uncertain: number; discrepancies: number; repliedYesterday: number; run: RunView }
interface ReconcileView { revision: number
  ledgerOnly: { jobId: string; title: string; company: string }[]
  platformOnly: { externalId: string; title: string; company: string }[] }
interface RunView { runId?: string; state: 'idle'|'queued'|'running'|'paused'|'halted'|'done'
  total: number; done: number; current?: string; haltReason?: string; startedAt?: string }
interface SettingsView { revision: number
  target: { roles: string[]; cities: string[]; salaryMin: number }
  limits: { runSize: number; daily: number; salaryMinMax: number } }
// 投递表（PRD §5.11）：路径来自 profile/set，headers 是读到的表头，对不上就 error
interface TrackerView { revision: number; path: string; enabled: boolean
  format: 'xlsx'|'numbers'|'unknown'; headers: string[]; lastSyncAt?: string
  error?: { code: string; message: string } }
interface TrackerSyncView { revision: number; added: number; updated: number; skipped: number }
```

### 11.3 并发与幂等

- `POST run/start` 两次 → 第二次 `409 E_RUN_ACTIVE`；
- `POST apps/:id/state` 带非法转移 → `409 E_ILLEGAL_TRANSITION`（返回 `allowed` 列表）；
- `POST queue/update` 在一轮投递进行中 → `409 E_RUN_ACTIVE`：发现与点击共用同一个浏览器页面，不能同时导航；
- `POST jobs/:id/skip` 幂等（已 `skipped` 时不再追加事件）；已投递 → `409 E_ALREADY_APPLIED`，租约在身 → `409 E_LEASE_HELD`；
- 所有写命令幂等于"当前状态检查"，不引入 requestId（单用户场景，成本不划算）。

**实现**：`src/api/handlers.ts` 是一个纯分发器：`{ method, path, query, body, headers } → { status, body }`。
挂载到 `ctx.webServer` 的那一层只有几行，行为（鉴权头、视图形状、错误映射）不依赖 HTTP 框架，可以单测。

### 11.4 轮询

- 运行中：1s；空闲：5s；面板不可见（`document.visibilityState !== 'visible'`）：停止；
- 每次响应带 `revision`（事件计数）；`revision` 未变则客户端跳过重渲染（React `useMemo` + 浅比较）；
- payload 上限：queue 最多 200 行；超出分页。

---

## 12. 面板

### 12.1 注册

**实现**：`src/client/index.tsx`。⚠️ `slots` 与 `locale` 按**结构类型**声明——DSH 客户端包是运行时由宿主提供的
peer，本仓库没有安装它们的类型。签名若有出入，只需改这一个文件，其余都是普通 React。

```ts
export const inject = ['slots', 'locale']
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'dsh-job-ledger', locale: NS },
    (props) => <App t={props.t} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'dsh-job-ledger', order: 12, label: () => t('panel'), locale: NS },
    LedgerIcon))
}
```

### 12.2 四屏结构

```
App
├─ Header:   标题 + 运行状态 pill + 今日已投/额度
├─ TabBar:   待投 | 概览 | 对账差异（带差异数 badge） | 设置
├─ <Queue/>       全选/反选、行内理由、行内「删除」、头部「更新」、粘底操作条（已选 N/10 + 投递）
├─ <Overview/>    5 个数字卡片 + 目标摘要 + 当前 run 状态条
├─ <Reconcile/>   两个列表 + "重新对账"
└─ <Settings/>    目标岗位 / 城市（标签输入）+ 薪资下限 + 投递表路径 + 保存
```

**面板自己滚动**：宿主主栏（`.centerCol`）是 `overflow: hidden`，不会替插件滚动；面板根节点必须
`height: 100%; overflow-y: auto` 才能看到超出视口的内容，待投卡片再把行区域设为唯一滚动区、把「投递」操作条固定在卡片底部。

**设置屏的数据流**：`GET profile` 读投影里的目标 → 表单本地编辑 → `POST profile` 校验并追加一条
`profile/set` → 响应即新目标。host 不缓存，工具在每次调用时读 `SettingsStore.profile`，所以保存后
下一次 `job_ledger_discover` 就用新目标。投递表路径走同一条事件（`tracker.path`），读取与写入见 §5.11。

### 12.3 状态映射

| 后端 | 面板文案 | 颜色 |
|---|---|---|
| `idle` | 空闲 | 中性 |
| `running` | 投递中 N/M | 强调 |
| `paused` | 已暂停 | 警示 |
| `halted` | 已停止：<原因> | 危险 |
| `uncertain` 计数 > 0 | 有 N 条结果未知，需人工核对 | 危险，置顶 |

**待投的准入规则（实现）**：`queueRows()` 只返回**还能投**的岗位——已申请（submitted 及之后的所有阻断状态）或正在被点击（租约有效）的行不出现。
原因：投递后决策事件不会变，若不过滤，已投过的岗位会永远留在待投清单里，面板会一直劝你再投一次。
`failed` 不阻断，所以它会回来；`uncertain` 阻断，只在别处等人工核对。
被用户删除的岗位写 `job/status = skipped`，状态不再是 `new`，因此不会再进任何待投视图，也不受后续更新影响。

### 12.4 交互细节

- 投递按钮文案随选择变化：`投递 3 个`；未选时禁用并提示"先勾选岗位"；只投勾选项（PRD §15 #32）；
- **更新**（`POST queue/update`）：按 `SettingsStore.profile` 调 `discoverForModel()`，返回计数 + 新清单；运行中禁用；
  失败显示结构化文案（`E_LOGIN_REQUIRED` 引导扫码），保留原清单；成功后头部展示"新增 N / 判重 N / 过滤 N / 疑似 N"；
- **删除**（`POST jobs/:id/skip`）：写 `job/status = skipped`；行立即从本地清单消失（轮询未回来前也不闪回），
  成功后自动触发一次「更新」补满；连续删除用短防抖合并成一次补满；运行中禁用；
  `applying` 之后（含 `uncertain`）的岗位 host 拒绝删除，返回 `E_ILLEGAL_TRANSITION`；
- 点击后**不弹二次确认**（勾选本身就是确认），但 `halted` 后"继续"要确认（避免误触恢复风控中的账号）；
- 疑似重复行有"看对比"入口：展开显示 `duplicateOf` 的目标岗位标题与相似度；
- 所有失败显示 `code` 对应的中文文案 + "复制诊断"按钮（把 code + values 复制到剪贴板，便于反馈）。

### 12.5 空态

| 场景 | 文案 |
|---|---|
| 未登录 | "需要先登录 BOSS：点这里打开浏览器扫码" |
| 清单为空 | "没有可投的岗位。点「更新」按当前目标（岗位 / 城市 / 薪资）抓一页。" |
| 今日额度用完 | "今天已投 30 个，明天继续。剩余 N 个岗位已排队。" |
| 无新岗位 | "没有新岗位。最近一次发现：{时间}，共 {n} 条全部被判重或过滤。" |
| 对账平账 | "已平账，无需处理。" |

---

## 13. 工具与 Skill

### 13.1 工具清单

| 工具 | 参数 | 返回 |
|---|---|---|
| `job_ledger_profile` | 无 / 部分字段 | 当前配置 |
| `job_ledger_resume` | `{ raw?: boolean }` | 简历摘要（默认脱敏） |
| `job_ledger_discover` | `{ source?: 'search'\|'recommend', limit?: number }` | `{added, duplicates, filtered, suspects}` |
| `job_ledger_queue` | `{ filter?: 'new'\|'suspect'\|'filtered', limit?: number }` | 行数组 |
| `job_ledger_apply` | `{ ids: string[] }` | run 结果 |
| `job_ledger_login` | `{ timeoutSeconds? }` | 登录状态（等待扫码，默认 180s） |
| `job_ledger_record` | `{ appId?, jobId?, state, note? }` | 新状态（给 jobId 时取该岗位最近一次申请） |
| `job_ledger_reconcile` | `{ backfill?: boolean }` | 差异摘要 |
| `job_ledger_report` | `{ format?: 'table'\|'md' }` | 报表 |

### 13.2 Skill 的落地方式

Skill 不是文档，是**约束**。每条约束都要有对应的工具侧校验，否则就是摆设：

| Skill 约束 | 工具侧校验 |
|---|---|
| 投递前必须对账 | `apply` 内部先跑 `reconcile()`；有差异 → 拒绝（返回 `E_UNBALANCED`） |
| 必须先展示清单 | 无法强制；`apply` 返回里带 `grantedBy`，事后可审计 |
| 不得自动重试 uncertain | 状态机层禁止 `uncertain → applying` 转移 |
| 不得扩大单轮上限 | 上限常量写死 |

---

**实现**：`assets/job-ledger/SKILL.md` 存正文（改规则就是改 Markdown），`src/skill.ts` 读取并注册；
宿主没有 `skills` 服务时跳过——缺 skill 是降级体验，不是坏账本。

## 14. 配置

```yaml
- id: job-ledger
  name: dsh-job-ledger
  config:
    dataDir: ~/.dsh/job-ledger        # 默认 $DSH_HOME/job-ledger
    chromePath: ''                     # 空 = 自动探测
    debugPort: 9222
    privacy:
      resumeExposure: redacted         # redacted | full
    target:
      roles: []                        # 空 = 取自在线简历 expected
      cities: []
      salaryMin: 0                      # 元/月；与岗位 salaryMin 同单位
      excludeKeywords: [销售, 外包, 驻场, 培训, 中介, 保险]
      companyBlacklist: []
    limits:
      runSize: 10                      # 只读，代码写死
      daily: 30                        # 只读
    reconcile:
      maxPages: 10
    dedupe:
      cooldownDays: 90
      simhashDistance: 3
```

> `limits` 出现在 schema 里是为了**只读展示**（面板显示额度），配置写入时忽略并 warn。

**运行时可改的目标**：面板「设置」写的是 `profile/set` 事件（`target.roles` / `target.cities` /
`target.salaryMin`），优先级高于这里的 YAML。`Ledger.open(file, config.profile)` 把 YAML 当作重放基底，
事件在其上合并；面板从不改写 `cordis.patch.yml`。

---

## 15. 错误码

| code | 用户文案 | 动作 |
|---|---|---|
| `E_LOGIN_REQUIRED` | 需要登录 BOSS | 打开浏览器，等你扫码 |
| `E_CAPTCHA` | 遇到验证码，已停止本轮 | 人工处理后手动继续 |
| `E_RATE_LIMITED` | 触发频率限制 | 停止，建议 24h 后再试 |
| `E_ACCOUNT_RISK` | 账号异常风险 | **停止一切自动化**，去官网确认 |
| `E_STOKEN_EXPIRED` | 登录态过期 | 重新扫码 |
| `E_SELECTOR_MISSING` | 页面结构变了 | 报 bug（附截图），本轮 failed |
| `E_BODY_UNAVAILABLE` | 没取到响应内容 | 重试一次，仍失败则 failed |
| `E_NAV_TIMEOUT` | 页面加载超时 | failed |
| `E_SEND_UNCONFIRMED` | 已点击但无法确认送达 | 记为 uncertain |
| `E_ALREADY_APPLIED` | 该岗位已投过 | 跳过 |
| `E_LEASE_HELD` | 另一个运行正在投它 | 跳过 |
| `E_DAILY_QUOTA` | 今日额度已用完 | 拒绝开跑 |
| `E_RUN_ACTIVE` | 已有一轮在跑 | 409 |
| `E_ILLEGAL_TRANSITION` | 状态不允许这样变更 | 409 + allowed |
| `E_UNBALANCED` | 账本与平台不一致，先处理差异 | 拒绝开跑 |
| `E_CHROME_NOT_FOUND` | 没找到 Chrome | 提示安装或配 chromePath |
| `E_CDP_DISCONNECTED` | 浏览器连接断开 | 熔断 |
| `E_LEDGER_WRITE` | 账本写入失败 | 熔断，提示检查磁盘 |
| `E_LEDGER_VERSION` | 账本由更新版本的插件写入 | 拒绝启动，提示升级插件 |
| `E_LEDGER_STATE` | 账本状态异常（未知 id、重复 app id、结构不完整事件） | 拒绝该操作/启动，报出实体与位置 |
| `E_INVALID_ARGUMENT` | 参数不合法（如 ids 为空或超过单轮上限） | 拒绝该调用，报出期望范围 |
| `E_PRIVACY_BLOCKED` | 隐私设置为 redacted | 拒绝返回原文，提示改成 full |

---

## 16. 安全与隐私

1. **落盘**：`dataDir` 700；`events.jsonl`、`evidence/*` 600；`chrome-profile/` 700（含 cookie，最敏感）。
2. **脱敏**：`resumeExposure: redacted` 时，工具出口按**白名单**投影，不按黑名单删。白名单：期望职位、期望城市、期望薪资、工作年限、学历、技能标签、公司名+职位+起止年月。其余一律不出。
3. **日志**：`ctx.logger` 不打简历内容、不打 cookie、不打 `encryptedJobId` 以外的身份字段。
4. **证据截图**：可能含聊天内容，属敏感；面板不直接渲染（要用户去文件系统看），避免截图进前端缓存。
5. **不加密**是明确取舍（PRD 已记）；README 要写一句"这个目录等于你的简历"。

---

## 17. 测试

硬规则不是靠评审记住的：`scripts/check-rules.ts` 会被 `pnpm check` 与 CI 调用，扫描「重放请求、
合成点击、第二写者、ledger 反向依赖、client 越界 import、原生依赖、console 输出」七条，
报错时同时给出"哪里错 / 为什么 / 怎么改"。

### 17.1 单元

- **判重 golden corpus**：`test/dedupe/corpus/*.json`，每条含两个岗位 + 期望结论 + 理由。至少覆盖：同名不同城市、同公司不同职位、同 JD 跨来源、多 HR 重复发、括号噪声、全角/半角。
- **状态机**：全转移矩阵（含非法转移）。
- **重放**：正常、截断尾巴、未知事件类型、版本过高。
- **租约**：并发 claim、过期回收、双重校验。

### 17.2 契约

- 对 `Api` 的每个路由做 handler 级测试（不起 HTTP server，直接调 handler）。

### 17.3 CDP 录制回放

真实抓包一次，存成 fixture：

```
test/fixtures/cdp/
├─ resume.json          # 三个简历接口的响应
├─ search.json          # 搜索第一页
├─ deliver-list.json    # 投递列表
└─ apply-seq.json       # 点击后的请求/响应序列（含 code=0 与 code=9 两种）
```

`cdp` 层抽象成接口 `BrowserPort`：

```ts
interface BrowserPort {
  navigate(url: string): Promise<void>
  capture(pattern: RegExp, timeoutMs: number): Promise<unknown>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  screenshot(): Promise<Buffer>
}
```

真实实现 `CdpBrowser`；测试实现 `ReplayBrowser` 按 fixture 回放，含超时与错误分支。这样**判重、run、对账全部可以离线测**。

### 17.4 真机冒烟（人工，每版一次）

1. 冷启动 → 扫码 → 读简历；
2. 发现 10 条 → 判重正确；
3. 投 1 条 → 看到简历卡片 → 证据截图存在；
4. 拔网线 → halt → 重启 → 状态一致；
5. 对账 → 差异 0。

**不需要账号的那一半已经自动化**：`pnpm smoke:cdp` 启动真实 Chrome、连 CDP、打开 BOSS、读 DOM、截图、
验证缺失选择器的错误码，检查登录墙，并在一个本地测试页上验证两件事：**点击是可信事件**
（`event.isTrusted === true`，即没有用合成 `.click()`）与**数据来自页面自己发出的请求**（arm 后导航，
捕获到页面自身 `fetch` 的响应）。它还用一个本地页面验证登录等待的两条路径：URL 离开登录页 → 成功；
一直不离开 → 返回 false（而不是假装登录成功）。最后一步把 `lib/client.js` 喂给真实浏览器、
配一个**替身** `__ModuleLoader__`，确认它确实以 classic script 方式注册了包名——构建期 vm 检查的浏览器版本。

本地检查排在 BOSS 之前：BOSS 是第三方，慢或不可达时它的 20 秒超时会把后面的本地页检查一起拖坏；
现在 BOSS 失败只记 warning。2026-11-03 在本机（Chrome 156）跑通，同时暴露并修掉了四个真 bug：

1. 连的是 **browser 级** WebSocket，`Page.enable` 在那一层不存在——必须连 page target；
2. `currentUrl` 用 `Runtime.evaluate` 取，BOSS 的页面会卡住渲染线程（15s 无响应）——改走
   `Page.getNavigationHistory`，浏览器侧不看渲染线程脸色；
3. 首次访问 BOSS 时 `Page.loadEventFired` 可能迟迟不来——导航改为「load 或主框架提交后稳定 800ms」；
4. 未登录时 BOSS 重定向到 `/web/user/`，但重定向**晚于**框架提交——登录检查改为最多轮询 1.25s。

`pnpm smoke:cdp` 只能证明浏览器链路与登录墙，**证明不了**简历字段、岗位列表、点击投递——那些仍要账号。

---

## 18. 性能预算

| 操作 | 预算 | 手段 |
|---|---|---|
| 插件启动重放（1 万事件） | < 100ms | 单遍扫描 + 增量索引 |
| 单次发现（50 条）+ 判重 | < 2s | 索引 + 45 天窗口 |
| 面板首次渲染 | < 300ms | 首屏只取 overview + queue 前 50 |
| 轮询响应 | < 50ms | 只读投影，不扫全量事件 |
| 客户端包 | < 200KB gzip | external react/dsh |

---

## 19. 里程碑映射

| 阶段 | 本设计涉及 | 出口 |
|---|---|---|
| P0 | §6 账本、§7 判重、§9.1 状态机 | 单测全绿，零浏览器依赖 |
| P1 | §5.1–5.4、§13.1 resume | 读到结构化简历 |
| P2 | §5.3、§7、§8 | 43 条 → 正确剔除 |
| P3 | §5.5–5.8、§9、§15 | 真投 1 成功 + 1 uncertain 熔断 |
| P4 | §10 | 差异可计算，回填不污染漏斗 |
| P5 | §11、§12、§3 | 面板点投、中断、恢复 |
| P6 | §13.2、README | 陌生机器装通 |

---

## 20. 待实测（⚠️ 未验证项）

这些是本文档里唯一不能靠推理确定的部分，**必须抓包确认**，否则 P1 的简历解析与 P3 的点击判定会卡住：

| # | 待确认 | 怎么确认 | 影响 |
|---|---|---|---|
| 1 | 点击"立即沟通"后，页面发出的是哪个请求 | DevTools Network 过滤 `friend/add` | 决定 greet 的匹配规则 |
| 2 | "发送简历"是独立请求还是随打招呼一起 | 同上，观察是否有第二个写请求 | 决定成功判据（B 级是否可行） |
| 3 | 简历卡片在聊天流的 DOM 结构 | 投一次后检查 Elements | 决定兜底判定 |
| 4 | 搜索接口的分页参数与 `city` 编码 | 翻两页看请求差异 | 决定 P2 的翻页实现 |
| 5 | `geekDeliverList` 的分页与返回字段 | 抓第一页与第二页 | 决定对账能否全量；P4 已按"只读第一页 + 明确告知"实现 |
| 6 | 各接口返回的 `code` 语义是否与 spec 一致 | 故意触发一次 37 | 决定熔断映射 |
| 7 | 招呼语输入框是否可编辑 | 手动试 | 决定填槽是否落地为"输入"还是"仅选预设" |
| 8 | 简历三接口（`baseinfo` / `expect` / `status`）的响应字段名 | 登录后打开简历页，导出三个响应体 | 决定 `src/resume/parse.ts` 的映射；P1 先用合成 fixture 实现，并对字段名做别名兜底 |
| 9 | 岗位列表接口是否带 JD 文本 | 抓一页 `joblist.json` 看字段 | 决定首次发现能否用 SimHash；P2 按"不带"实现，此时只靠指纹判重 |
| 10 | JD 里的「匹配点」怎么抽 | 抓几个真实 JD，看硬性要求有没有可枚举的形态 | 决定 `{匹配点}` 能否自动填；目前只能由模型提议值并通过原文校验 |
| 11 | `.numbers` 的 AppleScript 路径在**换机器**后是否可用 | 另一台装了 Numbers 的 Mac 上跑一次「立即同步」，确认自动化授权与 `addRowBelow` 行为一致 | 决定 `tracker/numbers.ts` 是否需要按系统版本分支；已在本机（Numbers 26，文件名被重命名）实测追加与更新两条路径 |

**建议**：P1 开始前，花 30 分钟做完第 1–4、7 项抓包（手动投一次即可），把结果补进本文 §5.3 与 §5.6。抓包结果决定 P3 的 30% 工作量。
