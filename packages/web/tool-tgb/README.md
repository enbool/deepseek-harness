---
description: "The model-facing taoguba (tgb.cn) data tools: topic lists, topic content, replies, follows, and home sections, over one credential-bearing site client."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-tgb

English | [中文](README.zh.md)

## Summary

`dsh-tool-tgb` lets models read taoguba (tgb.cn) data: a user's topic list (主贴), one topic's first post (主贴内容), a user's replies (跟帖), a user's followed users (关注列表), and the home page's 本周上升达人 / 热门研股 sections, optionally with realtime quotes. The site login state is a credential reference resolved per call; pagination budgets, timeouts, and size caps are deployment settings rather than model arguments. List tools paginate serially and stop on an empty page, a repeated first item, or the page budget, and report progress so the model can decide whether to fetch more.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the package in a composition that mounts the tool registry and a credential provider, and configure the `cookie` credential reference with a logged-in tgb.cn `Cookie` header value.

### When to choose it

Choose this package when the model should read a specific tgb.cn user's posting activity or the home page's community sections. The tools are read-only site reads; they never post, reply, or modify anything. `tgb_get_topics` pairs with `tgb_get_topic_content`: the list result carries each topic's `/a/` short code, which the content tool takes as its argument.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-tool-tgb'
  config:
    cookie: TGB_COOKIE   # credential reference; store the Cookie header value in the credential provider
```

| Field | Default | Meaning |
|---|---|---|
| `cookie` | required | Credential reference holding the logged-in tgb.cn `Cookie` request-header value; resolved once per tool call, so updating it needs no restart |
| `timeoutMs` | `30000` | Cooperative per-request timeout budget (ms), attached to every tool |
| `maxPages` | `5` | Page budget for one paginated call; the tools reject larger `maxPages` arguments |
| `maxResponseBytes` | `4000000` | Per-response size cap in bytes |
| `maxOutputChars` | `200000` | Cap on one complete rendered tool output |
| `requestIntervalMs` | `500` | Minimum pause between consecutive paginated requests |
| `userAgent` | current Chrome UA | Request User-Agent header value |

### The five tools

- `tgb_get_topics` — list one user's topics by `userID`, with topic id, short code, counters (replies/views/tickets/likes), and dates. Supports `pageNo`, `maxPages`, and the site's `sortFlag: 'R'` (order by latest reply).
- `tgb_get_topic_content` — fetch one topic by its `code` (letters and digits only — a URL is rejected), returning metadata plus the first post converted to markdown.
- `tgb_get_replies` — list one user's replies by `userID`, each with the reply text, the source topic, and the reply's own URL; optional `time` date filter (`YYYY-MM-DD`).
- `tgb_get_follows` — list one user's followed users; without `userID`, the logged-in user from the cookie is used. Returns the owner's follow/fan counts plus each followed user's counters.
- `tgb_get_home_sections` — parse the home page's 本周上升达人 and 热门研股 sections; `includeQuotes: true` adds realtime quotes for the hot stocks.

Paginated tools return `{ pagesFetched, hasMore, … }`. When `hasMore` is true, call again with a higher `pageNo` (start page plus `pagesFetched`).

### Failures and recovery

- A missing credential, any redirect to the site's SSO login host, or a login-state endpoint answering `status: false` fails with `TGB_AUTH_REQUIRED` — update the credential and call again. Credential-bearing requests never follow redirects; any other redirect fails with `TGB_REDIRECT_BLOCKED`.
- A response over `maxResponseBytes`, a request over `timeoutMs`, or a non-2xx status fails with `TGB_TOO_LARGE`, `TGB_TIMEOUT`, or `TGB_HTTP_STATUS`.
- A page whose structure no longer matches the parser fails loud with `TGB_PARSE_FAILED`; a JSON endpoint answering off-shape fails with `TGB_UPSTREAM_INVALID`. All failures are structured error tool results the model can read and relay.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Fixed external surface, no open proxy.** Every URL is built from module constants and validated numeric ids or short codes; no tool accepts a caller-supplied URL. The hosts (`www.tgb.cn`, `shuo.tgb.cn`, `hq.tgb.cn`) are the site's external specification, not deployment tunables.
- **Credential-bearing requests never redirect.** One fetch path uses `redirect: 'manual'`; the SSO login host maps to `TGB_AUTH_REQUIRED` (the site's cookie-expired signal) and everything else fails loud. This matches the web package group rule for credential-bearing requests.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, credential reference validation, client construction, tool registration |
| [`src/client.ts`](src/client.ts) | The one request path (cookie, redirects, timeout, size cap) and the serial pagination helper |
| [`src/sites.ts`](src/sites.ts) | Origin constants and URL builders |
| [`src/topics.ts`](src/topics.ts), [`src/topic-content.ts`](src/topic-content.ts), [`src/replies.ts`](src/replies.ts), [`src/follows.ts`](src/follows.ts), [`src/home.ts`](src/home.ts) | One parser per page or JSON endpoint; structural drift fails loud |
| [`src/tools.ts`](src/tools.ts) | The five model-facing schemas, validations, renders, and presentations |
| [`src/text.ts`](src/text.ts), [`src/markdown.ts`](src/markdown.ts) | Shared text normalization and the turndown HTML→markdown converter |

### Pagination flow

`collectPages` fetches pages serially with the configured pause between requests, merging items until the page budget, an empty page, or a first-item repeat (the site re-serves page one past its end). The result reports how many pages were fetched and whether fresh data remained.

### Topic bodies

The topic page's first-post block is stripped of the site's player and vote scaffolding and converted to markdown by the shared turndown instance (GFM tables and strikethrough). A conversion failure yields a fixed omission marker instead of raw markup.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web package map](../README.md) — the family this package joins and each role.
- [dsh-credentials](../../credentials/credentials/README.md) — the credential-reference seam the `cookie` field rides on.
- [dsh-tool-web](../tool-web/README.md) — the general-purpose, credential-free search/fetch tools; use those for arbitrary URLs.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

Five tools: `tgb_get_topics`, `tgb_get_topic_content`, `tgb_get_replies`, `tgb_get_follows`, `tgb_get_home_sections`. Numeric and date budgets (`maxPages`, timeouts) are deployment settings; the model only ever passes ids, short codes, page numbers, and the optional filters described in the schemas.

#### Token effect

Fixed schema cost per request for the five tools.

#### KV Cache effect

Prefix-stable while the tools are registered. Plugin lifecycle changes may invalidate reuse from the first changed schema token.

### Tool results

#### What the model sees

List results open with a progress line (`Topics of user 905478 — 2 pages fetched; more pages are available.`), then one markdown line per item with a link and the counters. Topic content renders as a heading, a metadata line, and the markdown body. Home sections render the two sections (plus quotes when requested) under Chinese headings. A cut output ends with `(Output truncated. Narrow the request — fewer pages or a specific page — for the rest.)`; failures become `Error: <message>`.

#### Token effect

Results scale with the requested page count and the `maxOutputChars` cap bounds each output. Retained results are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **This is a scraper over server-rendered pages** — the parsers anchor on the site's current markup (`table.T1` rows, `blogReply` blocks, `defaultContainerRight-*` sections). A site redesign fails loud with `TGB_PARSE_FAILED` rather than returning wrong data; fixtures in `tests/fixtures/` are re-recordable snapshots for reproducing such drift.
- **The site is not an API** — pagination beyond the page budget is the model's decision, sort options are limited to the site's own flags, and display strings (dates, price/change text) are passed through verbatim instead of normalized.
- **Login state rides entirely on the configured cookie** — the cookie expires on the site's schedule; the tools report `TGB_AUTH_REQUIRED` instead of attempting any login flow, and there is deliberately no credential refresh.
- **Writes are out of scope** — the tools are read-only; posting, replying, and follow management are not modeled.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: POST-based pagination fallback

The site's own topic-list pager submits a form (POST) rather than trusting `pageNo` in the query; GET pagination is verified against the live site but a site change would need the POST replay fallback. The client's `collectPages` builder is URL-shaped today; a POST variant would extend `CollectPagesOptions.build` rather than add a second loop.

</details>
