## 这个 PR 做了什么

<!-- 一句话说明。关联文档：docs/PRD.md / docs/TECH-DESIGN.md -->

## 改了哪一层

- [ ] `src/cdp/**` — 浏览器驱动
- [ ] `src/ledger/**` — 账本与事件
- [ ] `src/dedupe/**` — 判重
- [ ] `src/run/**` — 投递执行
- [ ] `src/api/**` / `src/client/**` — host API 与面板
- [ ] 文档 / 构建 / CI

## 硬规则自查（碰了对应层才需要勾）

- [ ] 没有重放请求：不构造 URL、不手动拼 header、不调用非页面自身发起的接口
- [ ] 点击走 `Input.dispatchMouseEvent`，不是 `element.click()`
- [ ] 判重没有新增"可能误杀"的宽松条件；疑似重复仍进待裁决
- [ ] `uncertain` 不会被自动重试；熔断停的是整轮，不是单个岗位
- [ ] 账本只追加，写入 fsync 后才算成功，重放遇坏行即停

## 怎么验证

<!-- 命令 / 截图 / 手动步骤。若涉及真机投递，说明用哪个账号、投了几条 -->
