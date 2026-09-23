---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-blogger-distill-request

English | [中文](2026-09-21-blogger-distill-request.zh.md)

## Summary

Add the blogger-distillation request record.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

A new root. No previous harness build wrote `blogger/distill-request`, so no committed log carries it and no reader needs an alternative. The event is required-on-read without the envelope's `ignorable` marker, matching `web/deepseek-search-llm-request`: a build without `dsh-tool-blogger-skill` refuses a log containing it rather than reconstructing a session whose auxiliary model input it cannot account for. The Session header version is unchanged.

<a id="verification"></a>
## Verification

`packages/skill/tool-blogger-skill/tests/tools.spec.ts` exercises both tools through the real tool registry, and `tests/profile.spec.ts` asserts that one distillation appends exactly one record carrying the source, user id, route, system prompt, messages, and output-token cap. `verify-persistence-catalog` regenerates `packages/core/session/src/known-event-types.ts` from the declaration, and this record's snapshot pins the declared payload.

<a id="dev-note"></a>
## Dev Note

None.
