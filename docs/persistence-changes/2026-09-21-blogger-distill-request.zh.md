---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-21-blogger-distill-request

[English](2026-09-21-blogger-distill-request.md) | 中文

## 概述

新增博主蒸馏请求记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-blogger-distill-request
baseline: false
changes:
  - root: "event:blogger/distill-request"
    previous: null
    after: "d7b980e2b58acdabd42156812a8f324b478323c0516c04487d452feb27088d45"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增的根。此前没有任何 harness 版本写入 `blogger/distill-request`，因此没有已提交日志携带它，读取方也无需替代方案。该事件默认必读，不带信封的 `ignorable` 标记，与 `web/deepseek-search-llm-request` 一致：未加载 `dsh-tool-blogger-skill` 的构建会拒绝包含它的日志，而不是重建一个无法交代其辅助模型输入的会话。会话头部版本不变。

<a id="verification"></a>
## 验证

`packages/skill/tool-blogger-skill/tests/tools.spec.ts` 通过真实工具注册表演练两个工具，`tests/profile.spec.ts` 断言一次蒸馏恰好追加一条记录，携带来源、用户 ID、路由、系统提示词、消息与输出 Token 上限。`verify-persistence-catalog` 依据该声明重新生成 `packages/core/session/src/known-event-types.ts`，本记录的快照固定了声明的负载。

<a id="dev-note"></a>
## 开发备注

无。
