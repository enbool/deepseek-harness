---
description: "面向模型淘股吧（tgb.cn）数据工具：主贴列表、主贴内容、跟帖、关注列表与首页板块，构建于一个携带凭据的站点客户端之上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-tgb

[English](README.md) | 中文

## 概述

`dsh-tool-tgb` 让模型读取淘股吧（tgb.cn）数据：用户的主贴列表、单篇主贴内容（主贴正文）、用户的跟帖、用户的关注列表，以及首页的 本周上升达人 / 热门研股 板块（可选附带实时行情）。登录态是每次调用时解析的凭据引用；分页、超时与大小上限属于部署设置而非模型参数。列表工具串行翻页，在空页、首条目重复或页数预算处停止。包入口还导出 `TgbClient`、三个页面解析器及其 URL 构造函数，供其他包使用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在挂载了工具注册表与凭据提供方的组合中加载本包，并把 `cookie` 凭据引用配置为已登录 tgb.cn 的 `Cookie` 请求头值。

### 何时选择

当模型需要读取特定 tgb.cn 用户的发帖动态或首页社区板块时选择本包。这些工具是只读的站点读取，绝不发帖、跟帖或修改任何内容。`tgb_get_topics` 与 `tgb_get_topic_content` 配对使用：列表结果携带每个主贴的 `/a/` 短码，内容工具以它为参数。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-tool-tgb'
  config:
    cookie: TGB_COOKIE   # credential reference; store the Cookie header value in the credential provider
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cookie` | 必填 | 保存已登录 tgb.cn `Cookie` 请求头值的凭据引用；每次工具调用解析一次，更新后无需重启 |
| `timeoutMs` | `30000` | 单请求协作式超时预算（ms），附加到每个工具 |
| `maxPages` | `5` | 一次分页调用的页数预算；工具会拒绝更大的 `maxPages` 参数 |
| `maxResponseBytes` | `4000000` | 单响应大小上限（字节） |
| `maxOutputChars` | `200000` | 单次完整渲染输出的上限 |
| `requestIntervalMs` | `500` | 相邻分页请求之间的最小间隔 |
| `userAgent` | 当前 Chrome UA | 请求 User-Agent 头值 |

### 五个工具

- `tgb_get_topics` — 按 `userID` 列出用户主贴，含主贴 id、短码、计数（回帖/浏览/加油券/赞）与日期。支持 `pageNo`、`maxPages` 与站点自身的 `sortFlag: 'R'`（按最新回复排序）。
- `tgb_get_topic_content` — 按短码 `code`（仅字母与数字——URL 会被拒绝）取回单篇主贴，返回元数据与转换为 markdown 的主贴正文。
- `tgb_get_replies` — 按 `userID` 列出用户跟帖，每条含跟帖内容、来源主贴与该跟帖自身 URL；可选 `time` 日期过滤（`YYYY-MM-DD`）。
- `tgb_get_follows` — 列出用户的关注列表；省略 `userID` 时使用 cookie 对应的登录用户。返回列表所有者的关注/粉丝计数以及每个被关注用户的计数。
- `tgb_get_home_sections` — 解析首页的 本周上升达人 与 热门研股 板块；`includeQuotes: true` 会为热门研股追加实时行情。

分页工具返回 `{ pagesFetched, hasMore, … }`。当 `hasMore` 为 true 时，用更大的 `pageNo`（起始页加上 `pagesFetched`）再次调用。

### 失败与恢复

- 凭据缺失、任何重定向到站点 SSO 登录主机、或登录态端点回答 `status: false`（未登录），都会以 `TGB_AUTH_REQUIRED` 失败——更新凭据后重新调用。携带凭据的请求绝不跟随重定向；其他任何重定向以 `TGB_REDIRECT_BLOCKED` 失败。
- 超过 `maxResponseBytes` 的响应、超过 `timeoutMs` 的请求或非 2xx 状态分别以 `TGB_TOO_LARGE`、`TGB_TIMEOUT` 或 `TGB_HTTP_STATUS` 失败。
- 页面结构与解析器锚点不再匹配时以 `TGB_PARSE_FAILED` 显式失败；JSON 端点返回异常形状时以 `TGB_UPSTREAM_INVALID` 失败。所有失败都是模型可读取并转述的结构化错误结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计原则

- **固定的外部边界，不做开放代理。** 每个 URL 都由模块常量与经过校验的数字 id 或短码拼装；没有任何工具接受调用方提供的 URL。主机（`www.tgb.cn`、`shuo.tgb.cn`、`hq.tgb.cn`）是站点的外部规格，而非部署可调项。
- **携带凭据的请求绝不重定向。** 唯一的请求路径使用 `redirect: 'manual'`；SSO 登录主机映射为 `TGB_AUTH_REQUIRED`（站点的 cookie 失效信号），其余一律显式失败。这与 web 包组对携带凭据请求的规则一致。
- 不发布运行时不变式伴随包。本包不持有状态：所有工具都经由同一个客户端读取站点，该客户端的请求规则与解析器锚点由本包自身的测试覆盖。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、凭据引用校验、客户端构造、工具注册 |
| [`src/client.ts`](src/client.ts) | 唯一请求路径（cookie、重定向、超时、体积上限）与串行分页辅助 |
| [`src/sites.ts`](src/sites.ts) | 主机常量与 URL 构建器 |
| [`src/topics.ts`](src/topics.ts)、[`src/topic-content.ts`](src/topic-content.ts)、[`src/replies.ts`](src/replies.ts)、[`src/follows.ts`](src/follows.ts)、[`src/home.ts`](src/home.ts) | 每个页面或 JSON 端点一个解析器；结构漂移显式失败 |
| [`src/tools.ts`](src/tools.ts) | 五个面向模型的 schema、校验、渲染与呈现 |
| [`src/text.ts`](src/text.ts)、[`src/markdown.ts`](src/markdown.ts) | 共享文本归一化与 turndown HTML→markdown 转换器 |

### 分页流程

`collectPages` 串行取页并在请求之间按配置间隔暂停，合并条目直到页数预算、空页或首条目重复（站点越界时会重新返回第一页）。结果报告实际取了几页以及是否仍有新数据。

### 主贴正文

主贴页的正文块会先剥除站点内嵌的播放器与投票脚手架，再由共享 turndown 实例（GFM 表格与删除线）转换为 markdown。转换失败返回固定的省略标记而非原始标记。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 包地图](../README.zh.md) — 本包加入的包族与各角色。
- [dsh-credentials](../../credentials/credentials/README.zh.md) — `cookie` 字段所依托的凭据引用 seam。
- [dsh-tool-web](../tool-web/README.zh.md) — 通用的、不带凭据的搜索/抓取工具；任意 URL 请使用它们。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

五个工具：`tgb_get_topics`、`tgb_get_topic_content`、`tgb_get_replies`、`tgb_get_follows`、`tgb_get_home_sections`。数值与日期预算（`maxPages`、超时）属于部署设置；模型只传 id、短码、页码以及 schema 描述中的可选过滤参数。完整 schema 见[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-tgb)。

#### Token 影响

五个工具每请求固定 schema 成本。

#### KV Cache 影响

工具注册期间前缀稳定。插件生命周期变化可能从第一个变化的 schema token 起使复用失效。

### 工具结果

#### 模型看到什么

列表结果以进度行开头（`Topics of user 905478 — 2 pages fetched; more pages are available.`），随后每个条目一行 markdown，含链接与计数。主贴内容渲染为标题、元信息行与 markdown 正文。首页板块在中文标题下渲染两个板块（请求时附带行情）。被截断的输出以 `(Output truncated. Narrow the request — fewer pages or a specific page — for the rest.)` 结尾；失败变为 `Error: <message>`。

#### Token 影响

结果随请求页数扩展，`maxOutputChars` 限制每次输出。保留的结果会重发直到压缩。

#### KV Cache 影响

只追加；新可见内容跟随可复用请求前缀，不会使既有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些是本包当前的限制。

- **这是针对服务端渲染页面的爬虫** — 解析器锚定站点当前标记（`table.T1` 行、`blogReply` 块、`defaultContainerRight-*` 板块）。站点改版会以 `TGB_PARSE_FAILED` 显式失败而不是返回错误数据；`tests/fixtures/` 中的 fixtures 是可重录快照，用于复现此类漂移。
- **站点不是 API** — 超出页数预算的分页由模型决定，排序仅限站点自身的旗标，展示字符串（日期、价格/涨跌文本）原样透传而非归一化。
- **登录态完全依赖配置的 cookie** — cookie 按站点的时间表过期；工具报告 `TGB_AUTH_REQUIRED` 而不尝试任何登录流程，并且刻意不提供凭据刷新。
- **写操作不在范围内** — 工具只读；发帖、跟帖与关注管理均未建模。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与未定方向。它明确是非权威的——已交付的行为、限制与依据见上文各节。

#### 未来：基于 POST 的翻页回退

站点自身的主贴列表翻页提交的是表单（POST）而非信任 query 中的 `pageNo`；GET 翻页已对真实站点验证，但站点变更时需要 POST 重放回退。客户端的 `collectPages` 构建器目前是 URL 形状；POST 变体应扩展 `CollectPagesOptions.build`，而不是增加第二个循环。

</details>
