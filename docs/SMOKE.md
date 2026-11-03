# 真机冒烟（TECH §17.4）

本文是给"重启之后、在**新会话**里跑一次"用的清单。`README` 的 8 项未验证，靠这一次跑完能划掉大半。

## 前置

```sh
cd ~/Desktop/dsh-job-ledger
pnpm build                                   # 产物在 lib/
dsh plugin --profile web add "$PWD"          # 已执行过；链到本仓库
dsh plugin --profile web why dsh-job-ledger  # 应看到 link: 路径
```

重启 DSH Web（Quit 后重新 `dsh web`，或你平时的启动方式）。**重启会结束当前会话**，所以之后在新会话里按下面走。

## 0. 看它有没有装上

```sh
ls ~/.dsh/job-ledger            # 挂载时会创建目录并写 snapshot（每周一次）
tail -20 ~/.dsh/logs/*.log      # 若插件加载失败，错误在这里
```

若日志里出现插件加载错误，把整段贴出来；卸载用：

```sh
dsh plugin --profile web remove dsh-job-ledger
```

## 1. 读简历（P1）

对话里说：

> 读一下我的在线简历

预期：返回 `后端工程师 / 深圳 / 25-35K / 5 年` 这类摘要；首次会弹 Chrome 让你扫码。

**要记录的**：成功的话，摘要长什么样；失败的话，错误码（`E_LOGIN_REQUIRED` / `E_BODY_UNAVAILABLE` / `E_NAV_TIMEOUT`）。
失败最有价值——它直接告诉我们 `src/cdp/boss.ts` 里的接口 pattern 或字段名错在哪。

## 2. 发现 + 判重（P2）

> 抓一页推荐岗位，10 条

预期：`新增 x / 判重 y / 过滤 z / 疑似 n / 无法识别 m`，然后

> 看看待投清单

预期：列出岗位，每条带理由。**要记录**：明显该被判重却没判的、或明显不同却被判重的例子。

## 3. 投 1 条（P3，会真的投出去）

**先确认你愿意让这次投递真的发出去。** 选一个你确实想投的岗位：

> 投递 <jobId>

预期：`投递成功 1 / 不确定 0 / …`；`~/.dsh/job-ledger/evidence/<appId>.png` 出现截图。

**要记录**：返回文案；有没有截图；BOSS 那边是否真的收到了招呼语/简历。
若是 `uncertain`，把 `tail -5 ~/.dsh/job-ledger/events.jsonl` 贴出来——这正是最需要修的状态。

## 4. 对账（P4）

> 对账

预期：`对账完成：匹配 x / 补记 y / 差异 z（只核对了平台最近一页…）`。
**要记录**：差异条数与两侧列表是否合理。

## 5. 报表

> 出个投递报表

预期：三张表 + 一句结论。

## 回传给我什么

一个新会话里贴这四样，我就能开始修：

1. 每步的**工具返回原文**（成功或错误码都行）；
2. `tail -20 ~/.dsh/job-ledger/events.jsonl`；
3. `ls ~/.dsh/job-ledger/evidence`；
4. 任何加载失败时的日志片段。

对应的修复面很小：接口字段在 `src/cdp/boss.ts` 与 `src/resume/parse.ts`，选择器全在 `src/cdp/boss.ts`。
