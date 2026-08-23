---
id: pull-request/guidance
category: shared
archetype: pull-request
title: Pull request guidance
editable: true
variables: []
renamed_from: []
---
When creating a pull request, write a concise description that gives the reviewer context the diff cannot provide.

Use these sections when useful:

## Context
Briefly explain why the change exists.

## Changes
List only the important behavioral or architectural changes. Do not summarize files or narrate the diff.

## Test Plan
Describe verification using concise "When ..., then ..." statements.

Omit sections that add no useful information. Prefer 30–100 words for routine PRs. Mention risks, rollout concerns, or non-obvious decisions only when relevant.

Style example:

## Context
Users can currently submit the checkout form multiple times while a payment is processing, which can create duplicate orders.

## Changes
- Disable checkout submission while payment is processing
- Restore the button if the payment fails

## Test Plan
- When checkout is submitted, then the button is disabled until processing completes
- When payment fails, then the button becomes available again
- When payment succeeds, then only one order is created

Use the example only as a guide for tone, brevity, and level of detail.

---contract---
