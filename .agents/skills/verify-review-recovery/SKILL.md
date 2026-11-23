---
name: verify-review-recovery
description: Verify concurrent recovery claims and missing-media decisions when changing interrupted review selection, ownership, heartbeats, or timestamps.
---

# Verify interrupted review ownership

A recovery worker may claim or fail only the interrupted review it observed. A stale missing-media result can otherwise discard newer work.

Install the locked dependencies with `pnpm install --frozen-lockfile`. Run the bounded state checker with Node 22.18.0 from the repository root.

```sh
pnpm dlx node@22.18.0 --experimental-strip-types --test --test-name-pattern='recovery model' tests/review-recovery.test.ts
```

The model starts with two maintenance workers holding the same observation of one review. Each can claim or fail it. An owner can report progress, finish, or send a heartbeat. The clock can cross the three-minute grace boundary once. The checker tries all 288 schedules within these bounds and compares the Convex handlers' decisions and persisted review to the model. A rejected action must leave the record intact.

Read an assertion's event sequence from left to right. Before `c91cb55`, an owner heartbeat followed by a missing-media decision failed a healthy review. At `dd296ea`, owner progress invalidated both workers' observations. After another grace period, a worker could still fail the changed review. In a scratch checkout, remove the timestamp comparison in `observedInterruptedReview` to replay the latter trace. Restore it and rerun.

## Coverage

- `convex/reviews.ts` exposes `listInterrupted`, `claimInterrupted` and `failInterrupted`. Each handler call is one serializable Convex transaction.
- `convex/reviewRecovery.ts` checks ownership, heartbeat age and the selected timestamp. Listing and deciding are separate transactions.
- `backend/app/review_pipeline/recovery.py` and `queue.py` carry the selected timestamp across media preparation for both decisions. Old containers that send only job IDs defer the missing-media decision to a newer recovery pass.
- `tests/review-recovery.test.ts` runs the real handlers with a deterministic clock and in-memory rows. Its reference state records whether the observation was consumed and whether the owner still has a fresh heartbeat.

The model covers committed orderings for one review. Network transport, media availability, batch projections, fairness and database conflict retries are outside its bounds. Separate tests cover legacy ownership, worker idleness and backend authentication.

Last checked against `23cca364cf559a9b4b9029904c3478a464e5490d`. When these paths change, compare the model events to the production transaction boundaries. If a counterexample is possible in production, fix the transition and rerun. If its preconditions are impossible, correct the model and replay the historical defect before advancing the sync commit.
