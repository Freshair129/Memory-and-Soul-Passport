---
version: "0.1.0b"
created_at: "2026-09-17T03:35:00+07:00,RWANG,b4ba371"
last_update: "2026-09-17T03:35:00+07:00,RWANG"
status: beta
attributes:
  domain: mission-state-protocol
  scope: phase6-implementation-review
---

# Phase 6 live-source and cursor review

## Symptom

The uncommitted implementation returned saved consolidation results after
source revocation, accepted another agent's THREAD-visible source without
thread attachment, and accepted a modified pagination position.

## Evidence

Independent Luna/max read-only review identified the paths. Real-stdio
regressions reproduced all three as `Missing expected rejection` in
`.tmp/phase6-review-reproduction.log`: replay after REVOKED, unattached
agent/workspace source access, and altered cursor timestamp.

## Root Cause

The replay branch returned before live source eligibility; the source helper
enforced AGENT visibility but omitted THREAD membership; cursor encoding and
scope binding were mistaken for integrity protection.

## Why the issue escaped detection

Initial tests covered wrong target tuples, successful retries and malformed
cursor syntax, but not source lifecycle changes, THREAD attachment, or a
well-formed edited cursor. These are development findings, not deployed incidents.

A final independent ordering review found promotion decoded the entity body
before checking its source vault owner. A stored malformed-JSON fixture under
another principal's vault reproduced a parse error instead of `not_found`
(`.tmp/phase6-promotion-order-repro.log`). The source lookup must first read
only its vault reference, authorize that row, and only then decode content.
The earlier happy-path tuple tests used valid JSON and missed this ordering
oracle; the malformed-content regression now covers it.

## Proposed prevention

Revalidate live authorized sources before saved success, enforce the current
source thread agent/workspace attachment for episodic access, authenticate
cursor bytes with the configured tenant service key, and retain all three
real-process regressions. Passport reads keep their approved agent-agnostic
subject boundary. Canonical request hashing also preserves idempotency across
equivalent JSON member orderings.

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-17 | beta | Record independently reviewed and reproduced pre-publication failures | working-tree | RWANG |
