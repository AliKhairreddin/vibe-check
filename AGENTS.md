# Agent Instructions

- At the end of every task in this repository, commit completed code changes and push them to GitHub.
- After pushing code, deploy Convex using the repository's configured Convex workflow.
- Do not attempt to deploy Cloudflare locally with `wrangler deploy`; this repository's Cloudflare deployment needs Docker for the configured container image, and GitHub Actions has the Docker-enabled runner for that work.
- After deploying Convex, rely on the push-triggered GitHub Actions deploy workflow to deploy Cloudflare, and monitor the workflow until the Cloudflare deploy step succeeds or fails.
- If credentials, network access, repository configuration, or another blocker prevents any of these steps, report the blocker clearly and leave the repository ready for the missing step to be run later.
