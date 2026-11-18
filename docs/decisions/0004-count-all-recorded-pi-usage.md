---
type: architecture
title: Count all recorded Pi usage
description: Include Pi usage from assistant replies, tool results, cache warming, compaction, and branch summaries, without guessing missing attribution.
status: accepted
date: 2026-11-18
decision-makers: [Ariel Schiavoni]
tags: [pi, accounting]
---

# 0004. Count all recorded Pi usage

## Context and Problem Statement

Pi records model usage in assistant replies and also outside them: nested tool usage, standalone `usage` entries such as cache warming, and compaction and branch summaries. Some of this usage has no provider or model. OpenCode reports only assistant-message usage.

## Decision Drivers

- Totals should match what Pi actually consumed
- No double counting
- Honest attribution

## Considered Options

- Count assistant replies only, like OpenCode
- Count all recorded usage

## Decision Outcome

Chosen option: count all recorded usage, across all branches, not only the current context. Usage without a provider or model is labeled `unknown` and is not attributed to the session's model. `reasoning` and `cacheWrite1h` are not added again, because they are already included in `output` and `cacheWrite`. Copied fork history is deduplicated (see [0003](0003-use-a-durable-event-ledger-and-outbox.md)).

## Consequences

- Good, because Pi totals include all consumption that Pi records.
- Bad, because some usage appears under `unknown` in provider and model breakdowns.
- Bad, because Pi and OpenCode totals have different coverage, so they are not strictly comparable.
- Neutral, because dashboard totals can differ from the sum of Pi's per-file statistics, which count inherited fork history again.
