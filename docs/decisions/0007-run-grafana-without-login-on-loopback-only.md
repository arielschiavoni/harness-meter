---
type: architecture
title: Run Grafana without login on loopback only
description: Give anonymous users the Grafana Admin role, hide the login form, and bind Grafana and Prometheus to 127.0.0.1.
status: accepted
date: 2026-11-18
decision-makers: [Ariel Schiavoni]
tags: [security, grafana, deployment]
---

# 0007. Run Grafana without login on loopback only

## Context and Problem Statement

Harness Meter runs on one developer's machine for one user. A Grafana login with a default password adds a step without real protection. Without a login, anyone who can reach the ports has full access, and Prometheus has no authentication at all.

## Decision Drivers

- No login for the local user
- Keep the dashboards editable
- Do not expose the services to the network

## Considered Options

- Keep the Grafana login (`admin`/`admin`)
- Anonymous access with the Viewer role
- Anonymous access with the Admin role, and both ports bound to `127.0.0.1`

## Decision Outcome

Chosen option: anonymous Admin with the login form disabled, and Grafana and Prometheus bound to `127.0.0.1` only.

## Consequences

- Good, because the dashboard opens directly and stays editable.
- Good, because other machines cannot reach Grafana or Prometheus.
- Bad, because any local process or user can administer Grafana.
- Bad, because remote access requires re-enabling authentication first.

## More Information

Revisit if the stack is shared or exposed beyond the local machine. Related: [0008](0008-mount-only-harness-data-read-only.md).
