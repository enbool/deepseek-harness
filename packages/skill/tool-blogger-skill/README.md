---
description: "Two model-facing tools that harvest one platform blogger's posts, bodies, and replies into a local corpus through ctx.bloggers, then distill that corpus through ctx.llm into a loadable SKILL.md."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-blogger-skill

English | [中文](README.zh.md)

## Summary

`dsh-tool-blogger-skill` turns one forum blogger into a reusable skill. `blogger_harvest` takes a blogger's id or profile-page URL, resolves it against `ctx.bloggers`, collects that blogger's posts, post bodies, and replies, and merges them into a durable per-blogger corpus. `blogger_build_skill` reads that corpus and writes two files under the configured skill root: `SKILL.md`, an operating procedure written in the imperative so another trader can act on it, and `portrait.md`, the evidence portrait with the quotes, dates, and cases behind its rules. Both tools are read-only over the platform; only the corpus and skill files are written locally.

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

Load the package beside a blogger source, an LLM service, a filesystem backend, and (for the generated skills to be loadable) the filesystem skill provider.

### When to choose it

Choose this package when a user names a 大V blogger and wants that blogger's reasoning available as instructions. The generic blogger tools are `dsh-tool-tgb`; this package never talks to a platform directly and works with any registered source.

### Minimal configuration

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

| Field | Default | Meaning |
|---|---|---|
| `skillsRoot` | `.dsh/skills` | Directory the `SKILL.md` files are written under; a relative path resolves against the calling session's workspace |
| `corpusRoot` | `.dsh/bloggers` | Directory the corpora are stored under; a relative path resolves against the calling session's workspace |
| `provider` / `model` | inherited | Distillation model route; set both or neither, `BLOGGER_CONFIG_INVALID` otherwise |
| `maxPostPages` / `maxReplyPages` | `3` | Page budget for one harvest's post and reply collection; the tools reject larger arguments |
| `maxPosts` | `20` | Post bodies one harvest may fetch; the tools reject a larger argument |
| `maxCorpusPosts` / `maxCorpusReplies` | `300` / `600` | Records one corpus retains |
| `maxPromptChars` | `400000` | Character budget for the corpus digest sent to the model |
| `maxOutputTokens` | `16000` | Output-token cap for the distillation request |
| `maxOutputChars` | `20000` | Cap on one complete rendered tool output |
| `timeoutMs` | `600000` | Cooperative tool-call timeout budget (ms) |

### The two tools

- `blogger_harvest` — resolve `user` (or `user` plus an explicit `source`) and collect one page window. `postStartPage` and `replyStartPage` choose where each list begins, so a second call reaches pages the first could not. It merges into the stored corpus, keeps a body an earlier harvest already fetched, and returns the corpus totals, the per-call additions, and the pagination facts including the page to pass next.
- `blogger_build_skill` — read that corpus and distill it into two files. `SKILL.md` is the product: an imperative operating procedure covering when the method applies, the decision spine, the judgement rules, execution, position sizing, refusals, and a pre-trade checklist. `portrait.md` beside it carries the quotes, dates, and cases that license those rules, and `SKILL.md` links to it. `skillName` overrides the model's proposed name; the files land under `<skillsRoot>/<skillName>/`.

### The corpus

One JSON file per blogger, named `<source>-<userID>.json` under `corpusRoot`. Records stay in platform list order, newest first, whichever window a harvest read: a window starting at the platform's first page is merged ahead of the stored records, and a window starting past it continues after them. Posts keep the newest copy and any body an earlier harvest fetched; replies deduplicate by id; both caps apply to the newest end, so paginating deeper never evicts the newest material. A file that no longer matches the record grammar fails loud with `BLOGGER_CORPUS_INVALID` rather than yielding a half-trusted corpus.

### Failures and recovery

- No stored corpus → `BLOGGER_CORPUS_MISSING`; a stored corpus with no posts and no replies → `BLOGGER_CORPUS_EMPTY`. Run `blogger_harvest` first.
- An off-format model answer, an invalid `skillName`, or a `max-tokens` cut → `BLOGGER_PROFILE_INVALID`. Run `blogger_build_skill` again.
- No configured model and no session route to inherit → `BLOGGER_DISTILL_ROUTE_UNSET`.
- Unresolvable, ambiguous, or unknown sources surface the `BLOGGER_*` codes from `dsh-blogger`; platform failures keep the source's own codes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Source-agnostic.** The tools talk only to `ctx.bloggers`, so adding 雪球, 同花顺, or any other platform is one provider package and no change here.
- **The corpus is the durable intermediate.** A harvest and a distillation are separate calls, so a long collection survives a failed distillation and a re-distillation needs no re-harvest.
- **The model answers in JSON, not in frontmatter.** The distillation returns `{ name, description, content }`; this package renders the frontmatter, so a description containing a colon stays a valid YAML scalar.
- No invariant companion is published. The tools hold no state beyond the configured roots: the corpus grammar is enforced at the read boundary and the distillation request is recorded in the session, both covered by the package's own tests.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema and route pairing validation |
| [`src/tools.ts`](src/tools.ts) | The two model-facing schemas, orchestration, rendering, and root resolution |
| [`src/corpus.ts`](src/corpus.ts) | The corpus record grammar, the merge, and the `ctx.fs` access |
| [`src/profile.ts`](src/profile.ts) | The digest, the auxiliary LLM request and its session record, the answer grammar, and the `SKILL.md` writer |
| [`src/errors.ts`](src/errors.ts) | The stable error codes |

### Harvest flow

`blogger_harvest` resolves the reference, reads the stored corpus, lists one bounded window of posts and replies starting at the page the caller named, fetches bodies only for posts that still lack one and only up to `maxPosts`, then merges and writes. A re-harvest therefore costs one list request per side plus the bodies it has never seen. Because each list is read from its own start page, a caller reaches older replies by passing the `nextReplyPage` the previous call returned rather than by re-reading page one.

### Distillation flow

`blogger_build_skill` renders a bounded digest of the corpus, appends the exact request to the session log, streams `ctx.llm`, checks the terminal finish reason, parses the JSON answer, and writes both files. The request is hand-built rather than loop-built, so it carries its own system prompt, is deep-frozen, and is never marked as a loop request. One call produces both documents because they must agree: the procedure states the rules, and the portrait holds the evidence for exactly those rules.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web package map](../../web/README.md) — the source family these tools read through.
- [dsh-blogger](../../web/blogger/README.md) — the seam contract, and [dsh-blogger-source-tgb](../../web/blogger-source-tgb/README.md) for the taoguba provider.
- [Skill subsystem](../../../docs/subsystems/skills.md) — where the written `SKILL.md` is discovered and how it reaches the model.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

Two tools: `blogger_harvest` and `blogger_build_skill`. `blogger_harvest` takes the blogger reference (`user`, plus an optional `source`), where each list starts (`postStartPage`, `replyStartPage`), how far each reads (`postPages`, `replyPages`), and a body budget (`maxPosts`). `blogger_build_skill` takes the same reference and an optional `skillName`. Every numeric bound is a deployment setting; the model only ever passes a reference, a start page the tool reported, and the budgets the deployment permits. The complete schemas are in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-blogger-skill).

#### Token effect

Fixed schema cost per request for the two tools.

#### KV Cache effect

Prefix-stable while the tools are registered. Plugin lifecycle changes may invalidate reuse from the first changed schema token.

### Tool results

#### What the model sees

`blogger_harvest` renders a summary line naming the source, user id, display name, post and body counts, and reply count, then a line reporting what this call added and which page window it read, then — while either list still has more — the exact `postStartPage` or `replyStartPage` to pass next, then the corpus path. `blogger_build_skill` renders the skill name, the counts it distilled, the procedure path, the portrait path, the description, and the digest size. A cut output ends with `(Output truncated. Narrow the request — fewer pages or fewer posts — for the rest.)`; failures become `Error: <message>`.

#### Token effect

Results are constant-size: they report counts, paths, and pagination facts rather than the harvested text. The corpus itself never enters the conversation.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries. The distillation request is an independent model call and shares no prefix with the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints.

- **The model reads counts, not content** — the tool results carry no harvested text, so the model cannot judge the corpus itself; it can only decide whether to harvest more or to distill. A user who wants to read the writing uses the source's own tools.
- **Regeneration overwrites** — `blogger_build_skill` writes `<skillsRoot>/<name>/SKILL.md` and its `portrait.md` unconditionally, so regenerating under an existing name replaces both files with no merge and no confirmation.
- **The procedure is only as good as the corpus** — a blogger with a handful of posts yields rules the model cannot ground in repeated behaviour, and the package cannot tell a thin corpus from a rich one. The procedure's own "when this applies" section is the model's honest statement of that; the session log records the digest size.
- **The digest is a straight truncation** — `maxPromptChars` cuts the corpus at a block boundary, so a very large corpus loses its oldest posts and replies from the prompt without the model being told which ones went missing beyond the `digestTruncated` flag.
- **Distillation is single-attempt** — the request is a hand-built `ctx.llm.stream` call, which never retries; a provider failure surfaces to the model, which must call the tool again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: map-reduce over a large corpus

A blogger with thousands of posts exceeds any single prompt. The shape that fits is repeated distillation passes over digest slices folded into one profile, but that needs a durable intermediate between passes and a merge rule for conflicting rules — neither exists yet, and the current single call is honest about its bound.

#### Future: a harvest-status tool

Nothing lists which bloggers have corpora or how stale they are, so the model discovers a missing corpus only by failing. A read-only listing tool would need the corpus store to enumerate its root, which `ctx.fs.listDir` supports.

</details>
