# dsh-job-ledger

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的求职投递账本：**判重、冷却、证据链、与平台对账**。
它记录你投过什么、投成了什么；投不投由你决定。

> **状态：设计完成，实现未开始。**
> [PRD](./docs/PRD.md) v0.3（28 项决策已锁定） · [技术设计](./docs/TECH-DESIGN.md) v0.1
> 代码目前只有骨架（错误码表 + 构建链），里程碑 P0 起开始实现。

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

## 设计要点

- **单一入口**：面板按钮与模型工具都调同一个 `startRun()`，不存在两个投递器。
- **只监听不重放**：所有数据来自页面自身发出的请求，不构造、不签名、不伪造请求头。
- **判重偏保守**：三级判定（确定重复 / 疑似 / 新），宁可漏判，不可误杀——
  误杀意味着这个岗位从此不再出现，而你不会知道。
- **`uncertain` 是一等状态**：点了但不确定成没成，就记为不确定，永不自动重试。

## 安装（发布后）

```sh
dsh plugin --profile web add dsh-job-ledger
```

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

- `pnpm check` 跑完整门禁（typecheck + test + build）。
- Node `^22.19 || >=24`；测试直接用 `node --test` 跑 TypeScript，不需要额外测试框架。
- `lib/` 构建产物不入 git，发布时打进 npm tarball。

## 目录

```
docs/           PRD 与技术设计
src/shared/     错误码（host / tools / 面板共用）
test/           node:test
cordis.patch.yml  DSH bundle patch
```

## 许可

MIT
