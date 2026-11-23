---
name: verify-batch-ownership
description: Check batch retry ownership after changing batch mutations, review hydration, Drive retry or interrupted review and automation recovery.
---

# Verify batch ownership

Once a retry claims a job ID, only that job can change the batch item. A late failure used to replace a completed creative with its failed predecessor.

Run `scripts/test-batch-db.sh` with the project's JavaScript and Python dependencies installed. The command starts a fresh local Convex server. The FastAPI test submits a batch and reads its saved state after a delayed upload failure.

## Check the event orders

`test_recovery_preserves_the_replacement_batch_for_every_delivery_order` in `tests/e2e/test_batch_completion.py` runs every permutation of three Convex mutations. A replacement finishes, review recovery fails an older job, and an upload failure arrives without a job ID. The model has one batch item, two jobs and one delivery of each event. Convex commits each mutation atomically. The test reads the stored item and its hydrated public view after every step in all six orders. It also checks that recovery can still fail an item owned by the interrupted job. A separate case exercises stale and current automation jobs in the same recovery transaction.

Before the fix, finishing the replacement and then failing its predecessor stored the predecessor's ID and `failed` in the batch. To replay that implementation with today's assertions, run `scripts/test-batch-db.sh 00134dc`. The recovery and automation ownership assertions should fail on that revision.

The model starts with an assigned replacement. The retry API test separately checks the claim that establishes ownership, rejects an older callback before enqueue and exercises a changed outcome for the replacement. The tests cover stored batches and HTTP responses. They do not model worker crashes, file-only concurrency, elapsed lease time or provider delivery.

## Keep the model current

Compare the following operations with their model events when their contract changes.

- `backend/app/main.py` claims the job ID before enqueue in `retry_batch_drive_item`. `backend/app/review_pipeline/storage.py` sends that ID to Convex and preserves it in file-only mode.
- `convex/batches.ts` owns `claimItemRetry`, `updateItemStatus`, `finishItem`, `hydrateBatchItems` and `failInterruptedBatchItems`.
- `convex/reviews.ts` and `convex/automations.ts` project interrupted jobs into batches through `failInterruptedBatchItems`.

Last checked at `87080315be11cb22436c9fcb73806d4acddac135`. If a failing trace can occur in production, fix the transition. If the model permits an impossible event, correct its preconditions. Advance the sync commit after the historical replay still fails for the expected reason and the current implementation passes.
