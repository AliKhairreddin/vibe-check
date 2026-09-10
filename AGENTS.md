# Agent Instructions

- At the end of every task in this repository, commit completed code changes and push them to GitHub.
- After pushing code, deploy Convex using the repository's configured Convex workflow.
- Do not attempt to deploy Cloudflare locally with `wrangler deploy`; this repository's Cloudflare deployment needs Docker for the configured container image, and GitHub Actions has the Docker-enabled runner for that work.
- After deploying Convex, rely on the push-triggered GitHub Actions deploy workflow to deploy Cloudflare, and monitor the workflow until the Cloudflare deploy step succeeds or fails.
- If credentials, network access, repository configuration, or another blocker prevents any of these steps, report the blocker clearly and leave the repository ready for the missing step to be run later.

## Responsive page widths

- Choose page width for the content and task. Centered layouts with side whitespace are intentional, standard UI patterns; do not remove `max-w-*` constraints merely to fill the screen or make every route the same width.
- Preserve comfortable maximum widths for forms, settings, automation editors, plan summaries, marketing pages, and readable prose. Avoid stretching inputs, text lines, or sparse cards across a large display.
- Use wider or full-width layouts when they materially improve tables, review grids, comparisons, or multi-pane documentation. Review history, batch results, and API docs are existing examples. Dashboards may stay constrained when that keeps cards and charts balanced.
- Before widening a page, compare the rendered layout at the same viewport and content state. Keep the change only if it improves readability, information density, or interaction without creating stretched controls, excessive gaps, or unbalanced cards. Check parent and nested width constraints when useful content is actually cramped.
- For layout changes, inspect mobile and wide desktop widths (at least 1920px), with the sidebar expanded and collapsed. Keep responsive edge padding and prevent page-level horizontal overflow; wide tables may scroll inside their own containers.
- References: [Atlassian grid guidance](https://atlassian.design/foundations/grid) supports both fixed and fluid grids; [USWDS typography](https://designsystem.digital.gov/components/typography/) explains readable line lengths.
