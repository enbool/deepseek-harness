---
description: "博客源能力接缝（ctx.bloggers）：平台实现需满足的契约、持有它们的注册表，以及消费者用于采集的帖子/回复词汇。"
kind: "package-reference"
---

# @deepseek-ai/dsh-blogger

[English](README.md) | 中文

## 概述

`dsh-blogger` 是读取论坛平台指定博主的服务定义（Service Definition）。平台包向 `ctx.bloggers` 注册一个 `BloggerSource`；消费者把用户 ID 或主页 URL 交给该注册表，得到唯一识别该引用的源，再通过它采集该博主的主贴、正文与跟帖。新增平台只需一个新的提供者包，消费者无需改动。本包不含任何平台代码，自身也不发起网络请求。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载注册表，然后让各平台提供者自行注册。

### 何时选用

当你实现某个论坛平台、希望其博主可被读取时，或当你作为消费者不想绑定具体平台时，选用本包。只针对淘股吧的消费者既可经由此接缝调用 `dsh-blogger-source-tgb`，也可直接使用 `dsh-tool-tgb`。

### 最小配置

注册表没有配置项，加载该包即可注册。

```yaml
- name: '@deepseek-ai/dsh-blogger'
```

### 源契约

一个实现需提供五项成员。

- `id` 与 `displayName` —— 注册表键，以及面向模型与诊断文本中使用的平台名。
- `matches(input)` —— 对单个用户引用的纯语法判断：平台 ID 或主页 URL。
- `resolve(input, signal)` —— 把 `matches` 接受的引用规范化为 `BloggerRef`。除非平台确需一次请求，否则不做 I/O。
- `listPosts(ref, request)` 与 `listReplies(ref, request)` —— 各自返回一段有界分页，携带 `pageNo`、`maxPages` 与调用方的 `signal`。
- `fetchPost(ref, postId, signal)` —— 按 `BloggerPostSummary.id` 取回一篇主贴正文的 markdown。

`matches` 与 `resolve` 必须一致：`resolve` 接受的正是 `matches` 接受的那些引用。采集方法只会收到该源自己产出的引用。

### 解析规则

`resolve(input, signal)` 的选择与注册顺序无关：

- 恰好一个已注册源识别该引用 → 由该源解析；
- 没有源识别 → `BLOGGER_SOURCE_UNRECOGNIZED`；
- 多个源识别 → `BLOGGER_SOURCE_AMBIGUOUS`，并列出各 ID，供调用方显式传入 `source`。

### 失败与恢复

所有失败都是携带某个 `BLOGGER_*` 错误码的 `BloggerError`，调用方按错误码分支，绝不解析消息文本：`BLOGGER_SOURCE_DUPLICATE`、`BLOGGER_SOURCE_UNKNOWN`、`BLOGGER_SOURCE_UNRECOGNIZED`、`BLOGGER_SOURCE_AMBIGUOUS`，以及当某个源被要求解析其自身语法拒绝的引用时的 `BLOGGER_REFERENCE_INVALID`。平台自身的失败沿用其原有分类；`tgb.cn` 源抛出带 `TGB_*` 错误码的 `TgbError`。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 —— 点击展开</summary>

### 设计原则

- **一个引用只选中一个源。** 各平台普遍使用数字 ID，裸数字 ID 因此天然歧义，所以解析失败要显式报错，而不是按注册顺序取第一个。知道平台的调用方显式传入 `source`。
- **词汇与平台无关。** 各源把自身页面模型映射到 `BloggerPostSummary`、`BloggerPost` 与 `BloggerReply`；展示型字符串（时间、计数）原样透传，不重新解析为时间戳。
- **接缝只负责生命周期，不负责传输。** `register()` 是调用方上下文上的 Cordis effect，因此提供者的源会随其 fiber 一并消失。
- 不发布运行时不变式伴随包。注册表只持有一个内存映射，其唯一关系——某个源恰在其注册 effect 存活期间被列出——由本包自身的销毁测试直接观察。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 注册表服务、解析规则与公开再导出 |
| [`src/types.ts`](src/types.ts) | `BloggerSource` 契约，以及主贴、跟帖、分页与身份词汇 |
| [`src/errors.ts`](src/errors.ts) | `BLOGGER_*` 错误码与 `BloggerError` |

### 注册生命周期

`register(source)` 遇到重复 ID 会以 `BLOGGER_SOURCE_DUPLICATE` 拒绝，并返回 disposer。由于 effect 记录在调用方上下文上，销毁贡献该源的插件 fiber 即会移除其源（由本包的 HMR 安全测试覆盖）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 包地图](../README.zh.md) —— 本包所属家族及各包职责。
- [dsh-blogger-source-tgb](../blogger-source-tgb/README.zh.md) —— 本接缝最初为之构建的淘股吧（tgb.cn）提供者。
- [dsh-tool-blogger-skill](../../skill/tool-blogger-skill/README.zh.md) —— 采集语料并蒸馏为技能的消费者。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 `dsh-tool-blogger-skill`：由它把解析出的 `BloggerRef` 与采集到的主贴、跟帖转成自己的工具结果，而本包不贡献任何提示词、模式或消息。

#### KV 缓存影响

不直接导致失效；请求前缀的任何变化由具名消费者掌管。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下限制是本包当前的约束。

- **不内置任何平台** —— 本包自身不注册任何源，因此只挂载它而不挂载提供者包的部署解析不出任何引用。这是加载期的配置事实，而非运行期回退。
- **裸数字 ID 按设计即歧义** —— 两个使用数字 ID 的平台都会命中，注册表拒绝猜测而非任选其一。接受自由文本输入的消费者应把 `BLOGGER_SOURCE_AMBIGUOUS` 中的源列表呈现给调用方，由其指定其一。
- **每次调用只采集一段分页** —— 接缝只报告 `hasMore`，是否继续由消费者决定；它不持有游标，也不持有续采状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本开发者笔记是维护者的工作上下文：未决问题与尚未确定的方向。它明确非权威——已交付的行为、限制与理由见上文各节。

#### 未来：源上的平台元数据

`BloggerSourceInfo` 只报告 ID 与显示名。若要做一个列出各平台及其凭据状态的选取器，就需要更多信息；其合理位置是新增一个可选的提供者成员，而不是拓宽注册表的汇报内容。

</details>
