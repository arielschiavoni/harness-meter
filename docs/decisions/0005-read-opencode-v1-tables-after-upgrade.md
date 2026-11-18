---
type: architecture
title: Read OpenCode v1 tables after an upgrade
description: Read both OpenCode table layouts, label v1-table messages opencode_v1, and skip v2 copies of them.
status: accepted
date: 2026-11-18
decision-makers: [Ariel Schiavoni]
tags: [opencode, migration, accounting]
---

# 0005. Read OpenCode v1 tables after an upgrade

## Context and Problem Statement

Upgrading OpenCode to v2 copies v1 history into new tables with the same message IDs, but leaves the v1 tables in place. v2 no longer writes to them. The copy is not complete: in a real upgraded database, 139 completed v1 messages ($23.52, over half of the v1 cost) existed only in the v1 tables. Reading only v2 lost them, and `opencode_v1` never appeared on the dashboard.

## Decision Drivers

- Do not lose history
- Do not count migrated copies twice
- Make the v1/v2 split visible in the Harness filter

## Considered Options

- Prefer v2 when both layouts exist (the previous behavior)
- Read both layouts, with the original v1 rows taking priority over v2 copies

## Decision Outcome

Chosen option: read both. Messages in the v1 tables are `opencode_v1`. Messages that exist only in v2 tables are `opencode_v2`. A v2 row is skipped when an eligible v1 row has the same ID. Across separate database files, all v1 tables are read before any v2 table.

## Consequences

- Good, because all available v1 history is exported once, with its original values.
- Good, because the labels show which OpenCode version produced each message.
- Neutral, because a session that started in v1 and continued in v2 is counted once, under `opencode_v1`.
- Bad, because this relies on v2 leaving the v1 tables unchanged. If a later OpenCode version removes or rewrites them, revisit this decision.
