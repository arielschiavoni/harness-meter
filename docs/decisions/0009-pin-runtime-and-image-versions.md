---
type: architecture
title: Pin runtime and image versions
description: Pin Bun, bun-types, Grafana, and Prometheus to exact versions and install from a frozen lockfile.
status: accepted
date: 2026-11-18
decision-makers: [Ariel Schiavoni]
tags: [dependencies, reproducibility]
---

# 0009. Pin runtime and image versions

## Context and Problem Statement

Bun 1.3.14 reproducibly crashed during an idle wait on the tested ARM64/Linux 7.0 Docker host (`embedder failed to suspend thread`, exit 133). Bun 1.4.4 passed the same check. Floating image tags can change the stack without notice.

## Decision Drivers

- Reproducible builds and type checks
- Avoid the known Bun crash
- Upgrade on purpose, not by accident

## Considered Options

- Use floating tags such as `latest`
- Pin exact versions and update them explicitly

## Decision Outcome

Chosen option: pin exact versions: the Bun 1.4.4 image and `bun-types` 1.4.4, Grafana 13.3.1, and Prometheus 3.16.0. Install with `bun install --frozen-lockfile`.

## Consequences

- Good, because builds and type checks match the deployed runtime.
- Good, because the stack changes only when someone updates a version.
- Bad, because updates must be checked and applied by hand.
- Neutral, because a Grafana upgrade migrates its database, so going back requires a backup.
