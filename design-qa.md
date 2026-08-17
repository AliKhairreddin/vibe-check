# Responsive table width QA

## Visual truth

- Kissterra source: `output/ui-audit/19-kissterra-table-before.png` (live production capture)
- History source: `output/ui-audit/20-history-width-before.png` (live production capture)
- Kissterra implementation: `output/ui-audit/21-kissterra-table-after-wide.png`
- History implementation: `output/ui-audit/22-history-width-after-wide.png`
- Laptop implementations: `output/ui-audit/23-kissterra-table-after-laptop.png` and `output/ui-audit/24-history-width-after-laptop.png`
- Full comparison: `output/ui-audit/25-table-width-full-comparison.png`
- Focused comparisons: `output/ui-audit/26-history-table-focused-comparison.png` and `output/ui-audit/27-kissterra-table-focused-comparison.png`
- Wide CSS viewport: 1724 x 893, device scale factor 1
- Laptop CSS viewports: 1279 x 800 for Kissterra and 1280 x 800 for History, device scale factor 1
- State: desktop, light mode; Kissterra batch collapsed for visual comparison and expanded separately for overflow validation; History populated with one grouped batch row

The Kissterra source capture was 1709 x 885 pixels because the production browser reserved scrollbar chrome while reporting a 1724 x 893 CSS viewport. It was normalized to 1724 x 893 only inside the comparison montage. The implementation capture was 1724 x 893 pixels. History source and implementation captures were both 1724 x 893 pixels. Laptop captures used their native CSS viewport sizes without density normalization.

The local implementation used production-shaped fixture data for the password-protected Kissterra list and read-only production API data for History. Counts and filenames therefore differ from the source captures, but route, interaction state, component structure, typography, and layout are equivalent.

## Findings and comparison history

1. **P2 — Kissterra table always overflowed its card.**
   - Earlier evidence: the table was fixed at 1216 px while its wrapper was 1182 px, creating a 34 px horizontal scrollbar even on a wide display.
   - Fix: widened the centered client shell to 1536 px and reduced the table minimum to 1088 px below the 2xl breakpoint while retaining the 1216 px desktop minimum.
   - Post-fix evidence: at 1724 px the table and wrapper are both 1438 px. At 1279 px they are both 1181 px. The expanded decision row also remains 1181 px with no overflow.

2. **P1 — History status overlapped Offer results.**
   - Earlier evidence: the status track was 96 px, but the “Complete With Failures” badge measured 148.5 px and visibly crossed into the adjacent rail.
   - Fix: History now uses the full content canvas, the status track is 176 px, the table minimum is 928 px, and the offer rail scales from 320 px to 448 px with viewport space.
   - Post-fix evidence: at 1724 px the 148.5 px badge ends 19.5 px before the status boundary; the table and wrapper are both 1380 px. At 1280 px the table and wrapper are both 936 px, status ends exactly where Offer results begins, and actions remain in their own 112 px track.

No actionable P0, P1, or P2 findings remain.

## Fidelity surfaces

- **Fonts and typography:** existing Geist family, weights, sizes, line heights, truncation, and hierarchy are unchanged. Laptop Upload text truncates within its own flexible track instead of colliding with neighbors.
- **Spacing and layout rhythm:** existing card padding, gutters, row height, radii, and vertical rhythm are preserved. Only the available shell width and table tracks changed.
- **Colors and visual tokens:** existing background, border, badge, rail, and semantic result tokens are unchanged.
- **Image quality and assets:** no imagery, icons, or generated assets were added or replaced. Existing creative thumbnails retain their native treatment.
- **Copy and content:** headings, labels, descriptions, table copy, and actions are unchanged.

## Interaction and responsive checks

- Kissterra expand/collapse works at the laptop viewport.
- The expanded Kissterra row has no horizontal overflow; the decision and reviewed cells remain separate.
- History search enters the no-match state and Reset restores the populated table.
- Wide and 13-inch laptop layouts preserve all persistent controls and table actions.
- Browser console checked after interactions: no warnings or errors.
- Production frontend build passes.

## Follow-up polish

- No P3 items required for this scoped layout fix.

final result: passed
