---
type: architecture
title: Mount only harness data, read-only
description: Mount only the OpenCode database files and the Pi sessions directory into the exporter, read-only, and fail on missing paths.
status: accepted
date: 2026-11-18
decision-makers: [Ariel Schiavoni]
tags: [security, deployment]
---

# 0008. Mount only harness data, read-only

## Context and Problem Statement

The OpenCode data directory also contains `auth.json` with credentials. Mounting the whole directory exposes them to the exporter container. With Docker's short bind syntax, a missing host path is created as an empty, root-owned directory.

## Decision Drivers

- Least privilege: the exporter must not see credentials
- Never write to harness data
- Clear errors for missing sources

## Considered Options

- Mount the whole OpenCode data directory
- Mount only `opencode.db`, `opencode.db-wal`, `opencode.db-shm`, and the Pi sessions directory

## Decision Outcome

Chosen option: mount only those files and the sessions directory, read-only, using the long bind syntax with `create_host_path: false`.

## Consequences

- Good, because credentials stay out of the container.
- Good, because a missing source fails clearly instead of creating empty directories.
- Good, because separate SQLite file mounts avoid stale WAL data on some macOS/Podman (virtiofs) setups.
- Bad, because all three SQLite files must exist, and an OpenCode-only or Pi-only setup needs a Compose override.

## More Information

Related: [0001](0001-read-harness-data-from-local-files.md), [0007](0007-run-grafana-without-login-on-loopback-only.md).
