---
description: "淘股吧（tgb.cn）博客源：解析数字用户 ID 或 /blog/{id} 主页 URL，并为 ctx.bloggers 接缝采集该用户的主贴、正文与跟帖。"
kind: "package-reference"
---

# @deepseek-ai/dsh-blogger-source-tgb

[English](README.md) | 中文

## 概述

`dsh-blogger-source-tgb` 把淘股吧（tgb.cn）注册为博客接缝上的一个平台。它接受数字用户 ID 或 `tgb.cn` 的 `/blog/{id}` 主页 URL，将其规范化为 `www.tgb.cn` 引用，并把站点的主贴列表、主贴详情与跟帖列表页映射到接缝的主贴/跟帖词汇。所有请求都经由 `dsh-tool-tgb` 导出的 `TgbClient`，因此凭据、禁止重定向、超时与大小上限规则只有一处。`dsh-tool-tgb` 中的工具与本提供者读取同样的页面，只是契约不同。

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

挂载 `dsh-blogger`（注册表）与本包，并把 `cookie` 凭据引用配置为已登录 tgb.cn 的 `Cookie` 请求头值。

### 何时选用

当消费者需要通过 `ctx.bloggers` 读取 tgb.cn 用户的发帖活动时选用本包——例如采集语料并蒸馏的 `dsh-tool-blogger-skill`。若要让模型直接读取主贴、跟帖、关注或首页，则应改用 `dsh-tool-tgb`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-blogger'
- name: '@deepseek-ai/dsh-blogger-source-tgb'
  config:
    cookie: TGB_COOKIE   # credential reference; store the Cookie header value in the credential provider
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cookie` | 必填 | 保存已登录 tgb.cn `Cookie` 请求头值的凭据引用；每个请求解析一次，因此更新它无需重启 |
| `timeoutMs` | `30000` | 单请求协作式超时预算（毫秒） |
| `maxResponseBytes` | `4000000` | 单响应字节上限 |
| `requestIntervalMs` | `500` | 连续分页请求之间的最短间隔 |
| `userAgent` | 当前 Chrome UA | 请求 User-Agent 头值 |

### 接受的引用

- 裸数字用户 ID，例如 `905478`；
- `tgb.cn` 或其任一子域上路径为 `/blog/{id}` 的 HTTP(S) URL，例如 `https://www.tgb.cn/blog/905478`、`https://shuo.tgb.cn/blog/905478?from=home` 或 `https://www.tgb.cn/blog/905478/`。

其他输入——显示名、非 `/blog/` 路径、外部主机、为零的 ID，或超出安全整数范围的 ID——都会被拒绝：`matches` 返回 false，直接调用 `resolve` 则抛出 `BLOGGER_REFERENCE_INVALID`。

### 失败与恢复

- 凭据缺失、被重定向到站点 SSO 登录主机，或非 2xx 状态，会以 `TgbError` 错误码 `TGB_AUTH_REQUIRED`、`TGB_REDIRECT_BLOCKED` 或 `TGB_HTTP_STATUS` 失败；页面结构与解析器锚点不再匹配时以 `TGB_PARSE_FAILED` 失败。
- 无法解析的引用由 `dsh-blogger` 以 `BLOGGER_REFERENCE_INVALID` 失败。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 —— 点击展开</summary>

### 设计原则

- **单一请求路径。** 提供者持有 `TgbClient`，自身绝不调用 `fetch`，因此 web 包组针对携带凭据请求的禁止重定向规则以及每一项部署上限都原样适用。
- **站点标记即外部规范。** 解析器锚定 `table.T1` 行、`.article-tittle`/`.p_coten` 与 `div.blogReply-left`；结构漂移会显式失败，而不是返回错误数据。
- **主贴 ID 就是 `/a/` 短码。** 主贴 URL 与 `fetchPost` 都使用它，因此 `BloggerPostSummary.id` 可直接在采集语料中往返，无需第二张查找表。
- 不发布运行时不变式伴随包。本提供者只持有一个客户端并注册一个源，这两层关系分别由共享客户端与注册表自身的测试约定覆盖，此处没有独立的可观察量。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置模式、客户端构建、向 `ctx.bloggers` 注册 |
| [`src/source.ts`](src/source.ts) | `BloggerSource` 实现与页面行映射 |
| [`src/reference.ts`](src/reference.ts) | 可接受的用户引用语法与规范化 |

### 分页

每次采集调用都依据接缝请求的 `pageNo` 与 `maxPages` 构建 URL，并委托给共享的 `collectPages` 辅助函数：它在空页、首条目重复或页数预算处停止，并报告 `pagesFetched` 与 `hasMore`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 包地图](../README.zh.md) —— 本包所属家族及各包职责。
- [dsh-blogger](../blogger/README.zh.md) —— 本提供者实现的接缝契约。
- [dsh-tool-tgb](../tool-tgb/README.zh.md) —— 面向模型的 tgb.cn 工具，也是本包复用其客户端与解析器的所有者。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 `dsh-tool-blogger-skill`：由它把采集到的主贴、正文与跟帖渲染成自己的工具结果，而本包不贡献任何提示词、模式或消息。

#### KV 缓存影响

不直接导致失效；请求前缀的任何变化由具名消费者掌管。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下限制是本包当前的约束。

- **这是基于服务端渲染页面的抓取器** —— 解析器复用 `dsh-tool-tgb` 的锚点，因此站点改版会以 `TGB_PARSE_FAILED` 显式失败，而不是返回错误数据。
- **只有 `/blog/{id}` 可作为博主引用** —— 主贴 URL、搜索 URL，或不是 `/blog/{id}` 的 `shuo.tgb.cn` 活动链接都会被拒绝；调用方须提供用户 ID。
- **此处不解析显示名** —— `resolve` 不发起请求，因此不返回 `userName`；消费者从采集到的主贴中获得该名称，站点在作者列渲染它。
- **登录态完全依赖所配置的 cookie** —— 站点 cookie 按其自身节奏过期，提供者只报告 `TGB_AUTH_REQUIRED`，不会尝试登录流程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本开发者笔记是维护者的工作上下文：未决问题与尚未确定的方向。它明确非权威——已交付的行为、限制与理由见上文各节。

#### 未来：无需额外端点的显示名

站点只有个人主页与 `/user/getIsLogin` 这两个廉价的名称来源，且二者都不是按 ID 查询用户。若消费者需要在解析时拿到名称，合理形态是在接缝上新增可选的 `describe(ref)` 成员，而不是在 `resolve` 内额外发一次请求。

</details>
