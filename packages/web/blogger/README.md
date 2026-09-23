---
description: "The blogger source capability seam (ctx.bloggers): the contract one platform implementation satisfies, the registry that owns them, and the post/reply vocabulary a consumer harvests through."
kind: "package-reference"
---

# @deepseek-ai/dsh-blogger

English | [中文](README.zh.md)

## Summary

`dsh-blogger` is the Service Definition for reading a named blogger on a forum platform. A platform package registers one `BloggerSource` on `ctx.bloggers`; a consumer hands that registry a user's id or profile-page URL, receives the one source that recognizes the reference, and collects that blogger's posts, post bodies, and replies through it. Adding a platform is one new provider package and no consumer change. The package holds no platform code and makes no network request itself.

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

Mount the registry, then let each platform provider register itself.

### When to choose it

Choose this package when you implement a forum platform whose bloggers should be readable, or when you consume blogger data without committing to a platform. A consumer that wants taoguba specifically can call `dsh-blogger-source-tgb` through this seam or use `dsh-tool-tgb` directly.

### Minimal configuration

The registry takes no config; it is registered by loading the package.

```yaml
- name: '@deepseek-ai/dsh-blogger'
```

### The source contract

One implementation supplies five members.

- `id` and `displayName` — the registry key and the platform name used in model-facing and diagnostic text.
- `matches(input)` — a pure syntactic test for one user reference: a platform id or a profile URL.
- `resolve(input, signal)` — the identity `matches` accepted, canonicalized to a `BloggerRef`. It performs no I/O unless the platform needs one.
- `listPosts(ref, request)` and `listReplies(ref, request)` — one bounded page slice each, with `pageNo`, `maxPages`, and the caller's `signal`.
- `fetchPost(ref, postId, signal)` — one post body as markdown, keyed by a `BloggerPostSummary.id`.

`matches` and `resolve` must agree: `resolve` accepts exactly the references `matches` accepted. Collection methods receive only a reference this source itself produced.

### Resolution rules

`resolve(input, signal)` is selection-order-independent:

- exactly one registered source matching the reference → that source resolves it;
- none matching → `BLOGGER_SOURCE_UNRECOGNIZED`;
- several matching → `BLOGGER_SOURCE_AMBIGUOUS`, naming the ids so the caller can pass `source` explicitly.

### Failures and recovery

Every failure is a `BloggerError` carrying one `BLOGGER_*` code, so callers route on the code and never on message text: `BLOGGER_SOURCE_DUPLICATE`, `BLOGGER_SOURCE_UNKNOWN`, `BLOGGER_SOURCE_UNRECOGNIZED`, `BLOGGER_SOURCE_AMBIGUOUS`, and `BLOGGER_REFERENCE_INVALID` for a source asked to resolve a reference its own grammar rejects. Platform failures keep their own taxonomy; a `tgb.cn` source raises `TgbError` with the `TGB_*` codes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **One reference selects one source.** A bare numeric id is ambiguous across platforms that all use numeric ids, so resolution fails loud instead of picking by registration order. A caller that knows the platform passes `source`.
- **The vocabulary is platform-neutral.** A source maps its own page model onto `BloggerPostSummary`, `BloggerPost`, and `BloggerReply`; display strings (times, counters) pass through verbatim rather than being re-parsed into timestamps.
- **The seam owns lifetime, not transport.** `register()` is a Cordis effect on the calling context, so a provider's sources disappear with the provider's fiber.
- No invariant companion is published. The registry owns one in-memory map whose only relation — a source is listed exactly while its registration effect is live — the package's own disposal tests observe directly.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The registry service, resolution rules, and the public re-exports |
| [`src/types.ts`](src/types.ts) | The `BloggerSource` contract and the post, reply, page, and identity vocabulary |
| [`src/errors.ts`](src/errors.ts) | The `BLOGGER_*` codes and `BloggerError` |

### Registration lifetime

`register(source)` rejects a duplicate id with `BLOGGER_SOURCE_DUPLICATE` and returns a disposer. Because the effect files on the calling context, disposing the contributing plugin's fiber removes its sources (covered by the package's HMR-safety test).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web package map](../README.md) — the family this package joins and each role.
- [dsh-blogger-source-tgb](../blogger-source-tgb/README.md) — the taoguba (tgb.cn) provider this seam was built for.
- [dsh-tool-blogger-skill](../../skill/tool-blogger-skill/README.md) — the consumer that harvests a corpus and distills it into a skill.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-blogger-skill`, which turns a resolved `BloggerRef` and the collected posts and replies into its own tool results while this package contributes no prompt, schema, or message.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **No platform is bundled** — the package registers nothing on its own, so a deployment that mounts it without a provider package resolves no reference. That is a load-time configuration fact, not a runtime fallback.
- **A bare numeric id is ambiguous by design** — two platforms using numeric ids both match, and the registry refuses rather than guessing. Consumers that accept free-form user input should surface the `BLOGGER_SOURCE_AMBIGUOUS` source list and let the caller name one.
- **Collection is one page slice per call** — the seam reports `hasMore` and leaves continuing to the consumer; it holds no cursor and no resume state.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: platform metadata on the source

`BloggerSourceInfo` reports only an id and a display name. A picker that lists platforms with their credential state would need more, and the honest place for it is a separate optional provider member rather than widening the registry's report.

</details>
