---
type: architecture
title: Read harness data from local files
description: Read OpenCode SQLite databases and Pi session files read-only instead of adding harness plugins, SDKs, or APIs.
status: accepted
date: 2026-06-08
decision-makers: [Ariel Schiavoni]
tags: [ingestion, opencode, pi]
---

# 0001. Read harness data from local files

## Context and Problem Statement

Harness Meter needs token, cost, and session data from coding harnesses. OpenCode stores its history in a SQLite database. Pi stores each session as a JSONL file. Neither format is a documented public API, and both formats change between versions (OpenCode v1 and v2 use different tables).

## Decision Drivers

- Work without changing or extending the harnesses
- Import existing history, not only new usage
- Never modify harness data
- Avoid extra dependencies

## Considered Options

- Read the harnesses' local storage files read-only
- Add an OpenCode plugin or a Pi extension that pushes metrics
- Use an OpenCode SDK or API server

## Decision Outcome

Chosen option: read the local storage files read-only. The exporter polls every 60 seconds. It detects the OpenCode schema from table names on each cycle, so no version setting is needed. It normalizes every source into the same usage events.

## Consequences

- Good, because the full history is imported, including usage from before Harness Meter was installed.
- Good, because the harnesses need no installation or configuration.
- Good, because no SDK or new runtime dependency is needed.
- Bad, because storage formats are internal. A harness upgrade can change them and break or skew the import, as the OpenCode v2 migration showed.
- Bad, because updates arrive with a polling delay of up to 60 seconds.

## More Information

Revisit if a harness offers a stable usage API or export, or if a format change makes file parsing too fragile. See [0005](0005-read-opencode-v1-tables-after-upgrade.md) for how OpenCode upgrades are handled.
