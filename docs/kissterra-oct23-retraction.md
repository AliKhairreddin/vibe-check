# Kissterra October 23 AGT retraction

The accidentally released `23 Oct 2026 Auto` batch is
`32d214fe1e5c42df90ccec9fdc1bfd40` (created October 26). Its 61 creatives include
20 `NAGT-CEL` files matching the reported AGT names. The two earlier attempts,
`a68b71144be84732aa65d8412ffc1342` and `9b0103517a974ea6876337088181864e`,
were already deleted and never released.

`reviewReleaseRepairs:retractKissterraOctober23Agt` is an internal operator
mutation with an exact job-ID/filename manifest. It checks the batch and all
20 reviews before writing, then atomically:

- Removes only Kissterra from their released offers and withholds its access projections.
- Blocks those review/offer pairs from later individual or batch releases.
- Records each retraction and its previous released offers in `reviewReleaseEvents`.
- Preserves review reports, original release timestamps, media, decisions, other
  advertisers' releases, and the other 41 creatives.

The production execution is explicit:

```bash
CONVEX_DEPLOYMENT=prod:energetic-partridge-813 pnpm exec convex run --prod reviewReleaseRepairs:retractKissterraOctober23Agt '{"dryRun":true}'
CONVEX_DEPLOYMENT=prod:energetic-partridge-813 pnpm exec convex run --prod reviewReleaseRepairs:retractKissterraOctober23Agt '{"dryRun":false}'
```

The first execution should match and change 20 reviews. Repeating it changes
zero records. The existing emailed share `1b64c35ab482484293c72f2a317e71eb`
automatically filters the withheld reviews and should contain the remaining
41. Advertiser detail/report/media checks and shared Partner API access use the
same withheld state. The repair sends no messages and does not recall delivered
emails, downloaded copies, or independently accessible Google Drive files.

Reversal requires a deliberate operator repair that clears the specific
`blockedReleaseOfferIds` entry and restores the audited release state and access
projection. Ordinary release controls cannot undo the block. Do not clear the
original `releasedAt` timestamp: previously released reviews must retain their
history-deletion protection.

Regression coverage in `tests/review-releases.test.ts` checks the dry run,
fail-before-write target validation, scope preservation, advertiser and share
visibility, idempotency, repeat-release protection, and projection refreshes.
