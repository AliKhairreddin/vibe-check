# Legacy advertiser vertical audit — October 14, 2026

Audited production version 5 of Lead Economy, Kissterra, and Smart Financial. Auto and Home previously inherited the same complete policy. The original official text and current internal overrides match the repository's policy seeds. Those sources remain unchanged in version history.

## Assignment

| Advertiser | Auto only | Home only | Shared |
| --- | --- | --- | --- |
| Lead Economy | Source $30 minimum; current $31/month override and associated guaranteed Auto rate claims; Auto carrier and free Auto examples; car-crash exception | Existing house-fire exception; no explicit Home floor or Home price disclaimer supplied | Remaining general restrictions and current internal rules |
| Kissterra | $19/month floor; synchronized $89/month average expenditure disclaimer; approved dollar savings examples; Auto email/government wording; car-crash exception | Existing house-fire exception; no explicit Home floor or Home price disclaimer supplied | Traffic, channel, brand, testimonial, general claim, discount percentage, and enforcement rules |
| Smart Financial | $39/month floor; driving-history, car-crash, stolen-property, Auto savings/bundling examples | Source Home/Renters $50/month rule; **current Home $31/month override**; house-fire exception | General restrictions, disclosures, discount percentage, and enforcement rules |

Smart Financial's Renters, Health, Life, and Commercial source sections are stored under their corresponding verticals as inactive drafts. Life retains $29/month and Commercial $25/month. Renters retains the source's $50/month; the override explicitly says Home, so it is not extended to Renters. No additional publisher verticals are activated.

General statements remain shared; clauses explicitly describing Auto prices, disclosures, or driving move to Auto. Combined car-crash/house-fire exceptions are split by subject, preserving the injury prohibition. Unqualified approved dollar savings examples alongside Kissterra/Smart Financial's Auto material are assigned conservatively to Auto rather than assumed approved for Home. The exact severe-consequence override and its stable rule ID remain shared and unchanged.

Home remains available for all three advertisers with their shared rules and applicable Home clauses. Lead Economy and Kissterra explicitly identify the missing Home floor/disclaimer instead of substituting Auto values. This migration supplies no new advertiser-approved Home price claims.

## Review behavior

Publisher submissions compose shared plus the selected vertical. Internal reviews, Drive automations, live scans, and API submissions freeze the applicable policy set at submission, then select the creative's vertical before analysis. Explicit selections take precedence; existing filename classification remains in place for integrations without a selection (HOME, then AUTO, otherwise Auto). An unconfigured/disabled vertical is excluded from that advertiser's evaluation and never falls back to its Auto policy. Existing historical snapshots are not re-evaluated.

Only selected rules enter the model evidence. Existing unscoped learned clarifications are excluded from scoped reviews because their vertical applicability has not been established. Each result records its shared guideline version and vertical policy version. Retried jobs use their frozen policies, not current edits.

## Migration and verification

`scripts/assign-legacy-verticals.py` pins the exact audited source hashes, requires version 5, and produces a reviewable plan before applying anything. The internal Convex mutation updates all three shared profiles and their verticals atomically, preserves the original revisions, rejects concurrent source/vertical edits, and safely reports an already-applied plan. The legacy seed sync skips advertiser-managed vertical policies.

Run the script with a private backup shaped as `{clientId: {profile: offers:get result}}`:

```sh
.venv/bin/python scripts/assign-legacy-verticals.py /private/path/backup.json --plan /private/path/plan.json
# After deploying the matching backend:
.venv/bin/python scripts/assign-legacy-verticals.py /private/path/backup.json --apply
```

Regression tests cover all six Auto/Home effective policies, exact enforcement preservation, source guards, atomic migration/idempotency, disabled verticals, snapshot persistence/retries, and model evidence/learning isolation. Production verification should compare publisher and internal effective snapshots for each Auto/Home pair and confirm the original v5 revisions remain intact.
