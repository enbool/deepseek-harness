---
description: "三个面向模型的工具：通过 ctx.bloggers 汇集某位平台博主的语料——既可采集主贴、正文与跟帖，也可并入本地 markdown 文档——再经 ctx.llm 蒸馏成可加载的 SKILL.md。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-blogger-skill

[English](README.md) | 中文

## 概述

`dsh-tool-blogger-skill` 把一位论坛博主变成可复用的技能。`blogger_harvest` 用博主 ID 或主页 URL 在 `ctx.bloggers` 上解析，把该博主的主贴、正文与跟帖合并进一份持久的按博主划分的语料；`blogger_ingest_documents` 把本地 markdown 文档并入同一份语料。`blogger_build_skill` 读取该语料，在配置的技能根目录下写入两个文件：`SKILL.md`，一份可供另一位交易者直接照做的祈使句操作规程；以及它旁边的 `portrait.md`，即规则背后那位交易者的画像——他的世界观、他反复回到的论证，以及他自己的话。没有任何工具会写入平台；本地只写入语料与技能文件。

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

把本包与博客源、LLM 服务、文件系统后端一起加载；若希望生成的技能可被加载，还需加载文件系统技能提供者。

### 何时选用

当用户点名一位大V博主，并希望把该博主的思路作为指令使用时，选用本包。通用的淘股吧工具是 `dsh-tool-tgb`；本包从不直接访问平台，对任何已注册的源都可用。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-blogger'
- name: '@deepseek-ai/dsh-blogger-source-tgb'
  config:
    cookie: TGB_COOKIE
- name: '@deepseek-ai/dsh-tool-blogger-skill'
  config:
    provider: deepseek      # optional; omit provider and model to inherit the session route
    model: deepseek-chat
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `skillsRoot` | `.dsh/skills` | 写入 `SKILL.md` 的目录；相对路径按调用方会话的工作区解析 |
| `corpusRoot` | `.dsh/bloggers` | 存放语料的目录；相对路径按调用方会话的工作区解析 |
| `provider` / `model` | 继承 | 蒸馏模型路由；两者同时设置或同时省略，否则报 `BLOGGER_CONFIG_INVALID` |
| `maxPostPages` / `maxReplyPages` | `3` | 单次采集主贴、跟帖的页数预算；工具会拒绝更大的参数 |
| `maxPosts` | `20` | 单次采集可抓取的正文篇数；工具会拒绝更大的参数 |
| `maxCorpusPosts` / `maxCorpusReplies` | `300` / `600` | 单份语料保留的记录条数 |
| `maxPromptTokens` | `60000` | 单次请求的估算 Token 预算；超出预算的语料会按窗口分批读取 |
| `maxOutputTokens` | `16000` | 蒸馏请求的输出 Token 上限 |
| `maxOutputChars` | `20000` | 单次渲染工具输出的上限 |
| `timeoutMs` | `600000` | 工具调用的协作式超时预算（毫秒） |

### 工具

- `blogger_harvest` —— 解析 `user`（或 `user` 加显式 `source`）并采集一段页窗口。`postStartPage` 与 `replyStartPage` 决定两侧列表各自的起点，因此第二次调用能取到第一次取不到的页。它把结果合并进已存语料，保留更早一次采集已抓到的正文，并返回语料总量、本次新增量与分页事实，其中包含下次该传的页码。
- `blogger_ingest_documents` —— 把本地 markdown 文档并入同一份语料。`user` 指定博主，`source` 在能解析出平台源时默认取该博主的平台源，`userName` 给出显示名，`documents` 列出文件路径，`kind`（默认 `post`）规定未声明类型的文档按哪一类处理。当平台删掉了读者留有离线副本的主贴，或博主在平台上根本没有主贴时使用它。从未被平台收录的博主使用内置的 `local` 源，它为这个纯离线身份给出 `source: local`，使 `blogger_build_skill` 沿与平台源相同的 `ctx.bloggers` 路径解析；对它调用 `blogger_harvest` 没有可读的平台历史。
- `blogger_build_skill` —— 读取该语料并蒸馏为两个文件。能装进 `maxPromptTokens` 的语料一次读完；更大的语料按窗口分批读，每个窗口在 `<corpusRoot>/notes/<source>-<userID>/` 下写一份证据笔记，再由两次归并把笔记变成技能。窗口内容未变时其笔记会被复用而不重新生成。`SKILL.md` 是产物本身：一份祈使句写成的操作规程，覆盖适用范围、决策主干、判断规则、执行、仓位、禁止事项与操作前自检。其旁的 `portrait.md` 描写这些规则来自怎样一位交易者——他的世界观、反复出现的论证、自己承认过的错误——引用他的话但不点出任何主贴、日期或来源，`SKILL.md` 会链接到它。`skillName` 可覆盖模型提议的名称；文件写入 `<skillsRoot>/<skillName>-<显示名>/` 下，因此从技能根目录就能看出哪个目录属于哪位博主。

### 语料

每位博主一个 JSON 文件，位于 `corpusRoot` 下，名为 `<source>-<userID>.json`。无论某次采集读的是哪一段窗口，记录都保持平台列表顺序（新在前）：从平台第一页开始的窗口合并到已存记录之前，从更靠后页开始的窗口则接在它们之后。主贴保留最新一份，并保留更早采集已抓到的正文；跟帖按 ID 去重；两个条数上限都作用在新的一端，因此越往下翻页越不会挤掉最新的内容。若文件不再符合记录语法，会以 `BLOGGER_CORPUS_INVALID` 显式失败，而不是交出一份半可信的语料。

每条记录都带 `origin`：采集来的记为 `platform`，摄入的文档记为 `offline`；在该字段出现之前写入的记录按平台记录处理。`maxCorpusPosts` 与 `maxCorpusReplies` 两个上限只覆盖平台记录，因为离线记录是用户显式摄入所选文档的结果，而非自动增长。文档的记录 ID 由其路径推导，因此重新摄入未改动的文档会替换原记录而不追加副本；frontmatter 的 `platformId` 会认领某条平台记录的 ID，因此平台仍在的主贴的离线副本会替换那条平台记录，而不会重复计数。

### 失败与恢复

- 没有已存语料 → `BLOGGER_CORPUS_MISSING`；已存语料既无主贴也无跟帖 → `BLOGGER_CORPUS_EMPTY`。先运行 `blogger_harvest`。
- 模型答案格式不符、`skillName` 非法，或被 `max-tokens` 截断 → `BLOGGER_PROFILE_INVALID`。再次运行 `blogger_build_skill`。
- 未配置模型且会话无可继承路由 → `BLOGGER_DISTILL_ROUTE_UNSET`。
- 无法解析、歧义或未知的源，沿用 `dsh-blogger` 的 `BLOGGER_*` 错误码；平台自身的失败沿用该源的错误码。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 —— 点击展开</summary>

### 设计原则

- **与源无关。** 工具只与 `ctx.bloggers` 交互，因此新增雪球、同花顺或任何其他平台只需一个提供者包，此处无需改动。
- **语料是持久的中间产物。** 采集与蒸馏是两次独立调用，因此一次漫长的采集不会因蒸馏失败而作废，重新蒸馏也无需重新采集。
- **模型以 JSON 作答，而非直接写 frontmatter。** 蒸馏返回 `{ name, description, content }`，由本包渲染 frontmatter，因此含冒号的描述仍是合法的 YAML 标量。
- 不发布运行时不变式伴随包。工具除配置的根目录外不持有状态：语料语法在读入边界强制，蒸馏请求记入会话，两者均由本包自身的测试覆盖。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置模式与路由成对校验 |
| [`src/tools.ts`](src/tools.ts) | 面向模型的模式、编排、渲染与根目录解析 |
| [`src/corpus.ts`](src/corpus.ts) | 语料记录语法、合并与 `ctx.fs` 访问 |
| [`src/profile.ts`](src/profile.ts) | 摘要、辅助 LLM 请求及其会话记录、答案语法与 `SKILL.md` 写入 |
| [`src/errors.ts`](src/errors.ts) | 稳定的错误码 |

### 采集流程

`blogger_harvest` 解析引用、读取已存语料、从调用方指定的起始页列出主贴与跟帖各一段有界窗口、只为仍缺正文的主贴且在 `maxPosts` 之内抓取正文，然后合并并写回。因此再次采集只需两侧各一次列表请求，加上从未见过的正文。由于两侧各自从自己的起始页读取，调用方靠传入上一次返回的 `nextReplyPage` 取到更早的跟帖，而无需重读第一页。

### 蒸馏流程

`blogger_build_skill` 把语料——平台记录与离线文档一视同仁——渲染成有序块，按 `maxPromptTokens` 分组成窗口，逐窗口读出证据笔记，然后做两次归并：一次写操作规程，一次写这些规则来自怎样一位交易者的画像。把归并拆开，是为了不让两份文档争夺同一个回答的输出预算——单个请求同时携带两者时正是这样超出了上限。每个请求都是手工构建而非由循环构建，因此自带系统提示词、被深度冻结，且从不被标记为循环请求。规程的回答由一个只含 name 与 description 的 JSON 头，以及标记行之后的纯 markdown 规程组成——这么长的文档无法在 JSON 字符串转义中存活——画像的回答则通篇是纯 markdown。解析失败时会把模型实际写出的前 300 个字符一并报出，供下一次调用修正。超出请求预算的记录会按段落边界拆成连续的多块，因此只有一个段落本身就超过整次请求时才会被硬切。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 包地图](../../web/README.zh.md) —— 这些工具读取的源家族。
- [dsh-blogger](../../web/blogger/README.zh.md) —— 接缝契约；淘股吧提供者见 [dsh-blogger-source-tgb](../../web/blogger-source-tgb/README.zh.md)。
- [技能子系统](../../../docs/subsystems/skills.zh.md) —— 写出的 `SKILL.md` 在何处被发现，以及如何抵达模型。

-----

<a id="model-experience"></a>
## 模型体验

### 工具模式

#### 模型看到什么

三个工具：`blogger_harvest`、`blogger_ingest_documents` 与 `blogger_build_skill`。`blogger_harvest` 接收博主引用（`user`，可选 `source`）、两侧列表各自的起点（`postStartPage`、`replyStartPage`）、各自的读取页数（`postPages`、`replyPages`）与正文预算（`maxPosts`）。`blogger_ingest_documents` 接收同样的引用、可选的显示名（`userName`）、文档路径（`documents`），以及未声明类型的文档默认归入的类型（`kind`）。`blogger_build_skill` 接收同样的引用与可选的 `skillName`。所有数值上限都是部署设置；模型只传入引用、工具上报过的起始页，与部署允许的预算。完整 schema 见[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-blogger-skill)。

#### Token 影响

三个工具带来固定的每请求模式开销。

#### KV 缓存影响

工具注册期间前缀稳定。插件生命周期变化可能从第一个模式 Token 起使复用失效。

### 工具结果

#### 模型看到什么

`blogger_harvest` 先渲染一行摘要，给出源、用户 ID、显示名、主贴与正文数、跟帖数；再渲染一行说明本次新增了多少、读取了哪一段页窗口；随后在任一侧仍有更多时，给出下次该传的确切 `postStartPage` 或 `replyStartPage`；最后给出语料路径。`blogger_ingest_documents` 渲染博主身份、读取的文档篇数、新增的主贴与跟帖数，以及语料路径。`blogger_build_skill` 渲染技能名、参与蒸馏的条数、规程路径、画像路径、描述，以及读了多少证据、用了多少次模型请求。被截断的输出以 `(Output truncated. Narrow the request — fewer pages or fewer posts — for the rest.)` 结尾；失败呈现为 `Error: <message>`。

#### Token 影响

结果大小恒定：报告的是计数、路径与分页事实，而非采集到的文本。语料本身从不进入对话。

#### KV 缓存影响

仅追加；新可见内容位于可复用请求前缀之后，不会使既有 KV 缓存条目失效。蒸馏请求是一次独立的模型调用，与会话不共享前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下限制是本包当前的约束。

- **模型只看到计数，看不到内容** —— 工具结果不携带采集到的文本，因此模型无法评判语料本身，只能决定是否继续采集或开始蒸馏。想阅读原文的用户请使用源自身的工具。
- **重新生成会覆盖** —— `blogger_build_skill` 无条件写入 `<skillsRoot>/<name>/SKILL.md` 及其 `portrait.md`，因此用已有名称重新生成会直接替换这两个文件，既不合并也不确认。
- **技能名装不下博主的名号** —— 技能名文法是小写 ASCII kebab-case，因此平台用中文写出的名号只能落在目录上，frontmatter 的 `name` 仍保持 ASCII。手工改过名的技能则留在它原来所在的目录里。
- **规程的质量取决于语料** —— 只有寥寥数篇主贴的博主，模型无法把规则建立在反复出现的行为之上，而本包也无法区分语料厚薄。规程自身的「适用范围」一节就是模型对此的诚实交代；会话日志记录了证据规模与请求次数。
- **超出单次请求的语料会分窗口读取** —— 归并一遍要读完所有窗口笔记，因此当一个语料大到需要非常多窗口时，最终会超出该预算并以 `BLOGGER_EVIDENCE_TOO_LARGE` 显式失败，而不是发出一个被截断的请求。分层归并是后续要做的事。
- **蒸馏只尝试一次** —— 该请求是手工构建的 `ctx.llm.stream` 调用，从不重试；提供者失败会呈现给模型，由模型再次调用工具。
- **文档在语料中的身份来自其路径** —— 重命名或移动文档文件会新建一条记录，而不会替换原有记录；又因为离线记录不受保留上限约束，被取代的那条会一直留在语料里。
- **摄入只读取 markdown** —— 文档是带可选 frontmatter 的 markdown，因此保存下来的 HTML 页面、PDF 或 Word 文件必须先转成 markdown。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本开发者笔记是维护者的工作上下文：未决问题与尚未确定的方向。它明确非权威——已交付的行为、限制与理由见上文各节。

#### 未来：面向大语料的 map-reduce

拥有数千篇主贴的博主会超出任何单个提示词。合适的形态是对摘要切片做多轮蒸馏并归并为一份画像，但这需要在轮次之间有持久中间产物，以及针对相互冲突规则的一条归并规则——两者目前都不存在，当前的单次调用对其上限是诚实的。

#### 未来：采集状态工具

目前没有任何东西列出哪些博主已有语料、其新鲜度如何，因此模型只能通过失败才发现语料缺失。一个只读的列举工具需要语料存储能枚举其根目录，而 `ctx.fs.listDir` 支持这一点。

</details>
