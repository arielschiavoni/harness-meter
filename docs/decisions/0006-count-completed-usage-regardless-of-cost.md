---
type: architecture
title: Count completed usage regardless of cost
description: Export completed usage with any token or cost value, including zero-cost usage, and skip incomplete streaming messages.
status: accepted
date: 2026-11-18
decision-makers: [Ariel Schiavoni]
tags: [accounting]
---

# 0006. Count completed usage regardless of cost

## Context and Problem Statement

Subscription and free models report zero cost but real token usage. Streaming messages change until they complete.

## Decision Drivers

- Show real token usage, even when it is free
- Avoid counting intermediate streaming values

## Considered Options

- Export only messages with positive cost
- Export any message with usage, including incomplete ones
- Export completed messages with any positive token or cost value

## Decision Outcome

Chosen option: export completed messages with any positive token or cost value. Cost is the value the source reports, not necessarily the invoiced amount.

## Consequences

- Good, because subscription usage (such as GitHub Copilot) appears in token panels.
- Good, because totals do not change while a message is streaming.
- Bad, because a message appears only after it completes.
