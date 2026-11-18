---
type: architecture
title: Use a durable event ledger and outbox
description: Store usage event identities and pending metric samples in local SQLite before remote write, so retries, restarts, and copies never inflate totals.
status: accepted
date: 2026-11-18
decision-makers: [Ariel Schiavoni]
tags: [metrics, prometheus, reliability]
---

# 0003. Use a durable event ledger and outbox

## Context and Problem Statement

Usage is pushed to Prometheus with remote write. The exporter re-reads sources after restarts and rewritten files. Pi forks copy earlier entries, and the same OpenCode message can exist in v1 and v2 tables. A timestamp watermark alone re-sent session samples whenever a session was updated. Two events with the same labels and millisecond overwrite each other in Prometheus.

## Decision Drivers

- Restarts, retries, rescans, and copies must not change totals
- Count each session once
- Keep metric labels bounded (no per-event labels)
- One failing write must not block all later imports
- No new dependency

## Considered Options

- Timestamp watermarks only (the previous approach)
- A unique per-event label on every sample
- A local SQLite ledger of event identities with an outbox of pending samples

## Decision Outcome

Chosen option: a SQLite ledger and outbox, using `bun:sqlite`.

- Each usage event has a stable identity. Duplicates are ignored, and the first payload is kept.
- A session is counted at its first eligible usage.
- Samples with the same labels and millisecond are summed before sending. A late event for an already-sent millisecond moves to the next free millisecond.
- A sample is marked sent only after Prometheus accepts it. Network errors, 429, and 5xx are retried. Other 4xx responses are permanent: they are logged and skipped, because Prometheus already stores the valid samples in that request.
- Delivered samples older than 730 days are pruned. Event identities are kept.

## Consequences

- Good, because totals are stable across restarts, retries, and repeated imports.
- Good, because label cardinality stays bounded.
- Bad, because a later change to an already-imported event is not applied. A clean rebuild is needed to reconcile rewritten or deleted source data.
- Bad, because the state database grows with the number of events.
