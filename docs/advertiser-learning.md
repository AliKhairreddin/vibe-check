# Advertiser learning

Owners and employees open **Admin console → Learning** (`/learning?offer=acp`). Employees can inspect the same evidence and history, but only owners can pause/resume processing, retry failures, disable a clarification, or restore an older version. Advertisers provide feedback in their existing review flow and cannot access this dashboard.

## What changes automatically

The system publishes versioned **learned clarifications**, separately from official guidelines and saved internal rules. A report records both its original `guideline_version` and its `learning_version`, plus the keys in `applied_learning`. The report links to its recorded learning revision. No previously completed report or advertiser decision is rewritten.

The LLM receives the current base guidelines and applicable learned clarifications. Clarifications are subordinate to explicit policy and internal rules. The baseline reviewer still runs first; a semantic application audit checks scope, observed evidence, and policy conflicts before a learned result can replace it. A red baseline is never downgraded by this feature, and learning cannot manufacture a new red verdict. Clear policy contradictions require changing the authoritative saved policy, not feedback voting.

Version history includes the full guideline content, additions/removals, publication time and actor, evaluated decision snapshots, and historical/prospective validation metrics. Restoring or disabling a clarification creates a new revision instead of altering history. Restoring requires the same base policy version and unchanged supporting decisions.

## Processing

1. The decision mutation records the decision, reason, note, whether it applies to similar creatives, an optional specific finding, and the original review versions. It queues an offer-scoped processing request in the same Convex transaction. Identical submissions are idempotent; edits are archived.
2. The existing maintenance cron wakes the backend to process durable learning work. Model calls do not happen inside the advertiser's request. Convex fences leases using a token and feedback generation, retries failures with backoff, and stops after five attempts. The dashboard offers a retry control. Processing is bounded to one offer per backend maintenance invocation and two replay calls at a time.
3. A bounded evidence snapshot is saved before temporary review intermediates are removed. It contains the extracted creative observations, transcript, OCR, and ad copy, not raw media. Oversized/truncated evidence and reviews using supplemental custom policy cannot support automatic publication. Historical decisions without a complete snapshot remain visible but cannot establish a new rule.
4. Explained decisions marked **Future similar creatives too** are eligible. False positives, confirmed issues, missed issues, and advertiser preferences are considered. Unexplained decisions, one-time exceptions, business choices, and feedback limited to one creative are excluded from rule discovery. Yellow is a request for judgment, not an assumed approval.
5. Exact and near-duplicate creative evidence is grouped before evaluation. Conflicting decisions within the same family exclude that family. Family deduplication is conservative token similarity (Jaccard ≥ 0.8), not a guarantee of identifying every visually related campaign.
6. A proposal sees only the discovery examples. An independent model call checks the proposal's policy compatibility, scope, supporting examples, and contradictions. Historical held-out labels never enter either prompt or the reviewer prompt.
7. A candidate must pass historical replay, then remain frozen while decisions arrive for later-created, unrelated creatives. Those cases are replayed in background against the frozen candidate without exposing their advertiser decisions to the reviewer. They never change the visible result while the candidate is being tested.
8. Passing candidates publish automatically. New conflicting reusable feedback can suspend active clarifications. Edited/withdrawn decisions and base-policy edits immediately suspend prior learning and fence out in-flight publication. New feedback arriving during testing is coalesced for another pass before a new clarification can publish.

## Conservative launch requirements

These are explicit engineering defaults, not measured production accuracy claims:

- At least 8 independent supporting discovery creatives, zero identified contradictions, and a 95% Wilson lower bound of at least 0.65.
- At least 6 separate, later historical validation creatives; at least 2 improvements and no regressions.
- At least 3 unrelated creatives created after the candidate was frozen; at least 1 further improvement and no regressions.
- No change in severe-consequence handling and no conflict with an explicit base policy rule.

A rejection is scored as requiring action (yellow or red), not automatically red. A reusable approval is scored as green. Business decisions and exceptions are excluded. The checks cannot guarantee future model accuracy; actual production feedback should inform subsequent threshold tuning. Agreement alone is not compliance proof, so policy checks and baseline protections apply independently.

Discovery examines up to 250 recent decisions and materializes at most 80 current-policy evidence snapshots per pass. Each proposal uses at most 24 discovery examples and 6 held-out examples. At most 20 clarifications are active per offer. Lexical matching orders the active clarifications, and a semantic audit determines which materially apply. Raw recent disagreement notes no longer bypass validation.

## Operations and failure behavior

- Uses existing `OPENROUTER_API_KEY`, provider privacy routing, and `OPENROUTER_MODEL`. `OPENROUTER_LEARNING_MODEL` optionally selects a different model for proposal/audit calls. No model fine-tuning or new external database is involved.
- New Convex tables: `learningEvidence`, `learningStates`, `learningRuns`, `learningShadows`, and `learningVersions`. Feedback additions on existing tables are optional for migration compatibility.
- If learning storage or a learned review fails, the normal reviewer remains usable. Saved decisions and official guidelines survive learning failures. Background work is resumable after container replacement; expired/stale workers cannot publish.
- Turning learning off creates a revision without active clarifications. Resuming queues validation; restoring an older revision explicitly restores its clarifications. Disabling one clarification preserves the others and suppresses automatic publication of that exact lesson key.
- Base guideline and learning revision numbers are separate. Together they identify the effective guideline set used by a review. This preserves the original policy revision history and makes automatic changes distinguishable from owner edits.
- Learning retains text evidence and decision audit snapshots in Convex. It does not retain raw creative media. Review deletion excludes the review from future discovery; removing/withdrawing reusable feedback schedules revalidation. Existing historical audit snapshots remain inspectable.

## Verification

`tests/learning.test.ts` exercises transactional feedback capture, idempotency, leases, publication requirements, tenant isolation, immutable versions, controls, and rollback. `backend/tests/test_learning.py` covers duplicate families, confidence bounds, excluded feedback, temporal separation, prospective evaluation, policy guards, and fallback behavior. Browser checks use local fixtures to exercise populated/empty history and owner/employee layouts without creating production feedback.
