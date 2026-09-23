---
description: "The taoguba (tgb.cn) blogger source: resolves a numeric user id or a /blog/{id} profile URL and collects that user's topics, post bodies, and replies for the ctx.bloggers seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-blogger-source-tgb

English | [中文](README.zh.md)

## Summary

`dsh-blogger-source-tgb` registers taoguba (tgb.cn) as one platform on the blogger seam. It accepts a numeric user id or a `tgb.cn` `/blog/{id}` profile URL, canonicalizes it to a `www.tgb.cn` reference, and maps the site's topic-list, topic-detail, and reply-list pages onto the seam's post and reply vocabulary. Every request goes through the `TgbClient` exported by `dsh-tool-tgb`, so the credential, no-redirect, timeout, and size rules stay in one place. The tools in `dsh-tool-tgb` and this provider read the same pages under different contracts.

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

Mount `dsh-blogger` (the registry) and this package, and configure the `cookie` credential reference with a logged-in tgb.cn `Cookie` header value.

### When to choose it

Choose this package when a consumer should read a tgb.cn user's posting activity through `ctx.bloggers` — for example `dsh-tool-blogger-skill`, which harvests a corpus and distills it. Choose `dsh-tool-tgb` instead when the model should read topics, replies, follows, or the home page directly.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-blogger'
- name: '@deepseek-ai/dsh-blogger-source-tgb'
  config:
    cookie: TGB_COOKIE   # credential reference; store the Cookie header value in the credential provider
```

| Field | Default | Meaning |
|---|---|---|
| `cookie` | required | Credential reference holding the logged-in tgb.cn `Cookie` request-header value; resolved once per request, so updating it needs no restart |
| `timeoutMs` | `30000` | Cooperative per-request timeout budget (ms) |
| `maxResponseBytes` | `4000000` | Per-response size cap in bytes |
| `requestIntervalMs` | `500` | Minimum pause between consecutive paginated requests |
| `userAgent` | current Chrome UA | Request User-Agent header value |

### Accepted references

- a bare numeric user id, for example `905478`;
- an HTTP(S) URL on `tgb.cn` or any of its sub-domains whose path is `/blog/{id}`, for example `https://www.tgb.cn/blog/905478`, `https://shuo.tgb.cn/blog/905478?from=home`, or `https://www.tgb.cn/blog/905478/`.

Anything else — a display name, a non-`/blog/` path, a foreign host, an id of zero, or an id beyond the safe-integer range — is rejected, so `matches` returns false and a direct `resolve` raises `BLOGGER_REFERENCE_INVALID`.

### Failures and recovery

- A missing credential, a redirect to the site's SSO login host, or a non-2xx status fails with the `TgbError` codes `TGB_AUTH_REQUIRED`, `TGB_REDIRECT_BLOCKED`, or `TGB_HTTP_STATUS`; a page whose structure no longer matches the parser fails with `TGB_PARSE_FAILED`.
- An unresolvable reference fails with `BLOGGER_REFERENCE_INVALID` from `dsh-blogger`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **One request path.** The provider holds a `TgbClient` and never calls `fetch` itself, so the web package group's no-redirect rule for credential-bearing requests and every deployment bound apply here unchanged.
- **The site's markup is the external specification.** Parsers anchor on `table.T1` rows, `.article-tittle`/`.p_coten`, and `div.blogReply-left`; structural drift fails loud rather than returning wrong data.
- **The post id is the `/a/` short code.** It is what the topic URL and `fetchPost` both take, so a `BloggerPostSummary.id` round-trips through a harvest corpus without a second lookup table.
- No invariant companion is published. The provider owns one client and registers one source, and both relations are the shared client's and the registry's own tested contracts rather than independent observations here.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, client construction, registration on `ctx.bloggers` |
| [`src/source.ts`](src/source.ts) | The `BloggerSource` implementation and the page-row mappings |
| [`src/reference.ts`](src/reference.ts) | The accepted user-reference grammar and canonicalization |

### Pagination

Each collection call builds its URLs from the seam request's `pageNo` and `maxPages` and delegates to the shared `collectPages` helper, which stops on an empty page, a repeated first item, or the page budget and reports `pagesFetched` and `hasMore`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web package map](../README.md) — the family this package joins and each role.
- [dsh-blogger](../blogger/README.md) — the seam contract this provider implements.
- [dsh-tool-tgb](../tool-tgb/README.md) — the model-facing tgb.cn tools, and the owner of the client and parsers this package reuses.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-blogger-skill`, which renders the collected posts, bodies, and replies into its own tool results while this package contributes no prompt, schema, or message.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **This is a scraper over server-rendered pages** — the parsers reuse `dsh-tool-tgb`'s anchors, so a site redesign fails loud with `TGB_PARSE_FAILED` rather than returning wrong data.
- **Only `/blog/{id}` is a profile reference** — a topic URL, a search URL, or a `shuo.tgb.cn` activity link that is not `/blog/{id}` is rejected; the caller must supply the user id.
- **The display name is not resolved here** — `resolve` performs no request, so it returns no `userName`; a consumer learns the name from the harvested posts, whose author column the site renders.
- **Login state rides entirely on the configured cookie** — the site's cookie expires on its own schedule, and the provider reports `TGB_AUTH_REQUIRED` instead of attempting a login flow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: a display name without a second endpoint

The site's profile page and its `/user/getIsLogin` endpoint are the only cheap name sources, and neither is a profile lookup. If a consumer needs the name at resolve time, the honest shape is an optional `describe(ref)` member on the seam rather than an extra request inside `resolve`.

</details>
