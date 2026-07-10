# Ad Compliance Creative Reviewer

Cloudflare-native MVP for reviewing MP4, JPG, PNG, and WebP ad creatives, or standalone pasted ad copy, against saved publisher guidelines plus optional pasted platform policies. It extracts video metadata with `ffprobe`, extracts WAV audio and samples video frames with `ffmpeg`, prepares still images for OCR with Pillow, runs OCR with Tesseract, transcribes audio through OpenRouter Speech-to-Text with a manual transcript override, optionally extracts compact visual observations from sampled frames with an OpenRouter vision model, and sends compact evidence to OpenRouter Chat Completions for a strict JSON compliance report.

## Stack

- Frontend: Vite, React, TypeScript, TanStack Router, TanStack Query, TanStack Table, Tailwind CSS, local shadcn-style components, lucide-react.
- Backend: FastAPI, Pydantic, ffmpeg/ffprobe, OpenCV/Pillow, pytesseract, OpenRouter.
- Cloud runtime: Cloudflare Worker, Cloudflare Containers, Convex.

## Cloudflare Architecture

`vibe-check.thatcanadian.dev` is served by a Cloudflare Worker.

- Static frontend routes are served from `frontend/dist` via Workers Static Assets.
- `/api/*` routes are forwarded to a Cloudflare Container running the FastAPI backend.
- Uploaded creatives, extracted audio, sampled frames, prepared image frames, OCR artifacts, and visual observation artifacts stay in temporary container scratch space only.
- Convex stores the uploaded filename, job status/progress, and final compliance report JSON.

R2 is not required for this MVP because uploaded creatives and frame artifacts are intentionally not durable.

## Local Development

```bash
cp .env.example .env
/opt/homebrew/bin/python3.12 -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
pnpm install
uvicorn backend.app.main:app --reload --port 8000
pnpm --dir frontend dev
```

Open the Vite dev URL and upload one or more MP4, JPG, PNG, or WebP creatives with optional ad copy and policy text, or paste standalone ad copy without a creative. Ad copy means the submitted platform caption/body text, separate from audio transcript and on-creative OCR text.
The UI creates one review job per selected creative and shows upload progress first,
then backend queue and processing progress for each job. Creatives larger than 8 MB are
sent as retryable 8 MB chunks so files up to the configured 200 MB application limit do
not exceed Cloudflare's plan-level per-request body limit. Upload admission and backend
processing both run in bounded parallel pools (four jobs at a time by default). With no
creative selected, each non-empty ad copy line becomes its own review job.

## Cloudflare Deployment

Cloudflare Containers require a Workers Paid plan. Docker or a compatible Docker engine must also be running on the machine or CI runner that executes `wrangler deploy`, because Wrangler builds and pushes the container image during deployment. The configured container instance type is `standard-1` so ffmpeg, Tesseract, and OpenCV have enough memory/disk for normal creative review jobs.

One-time setup:

```bash
pnpm install
pnpm run wrangler:types

shared_secret="$(openssl rand -hex 32)"
printf '%s' "$shared_secret" | pnpm exec convex env set --deployment energetic-partridge-813 CONVEX_HTTP_SECRET
printf '%s' "$shared_secret" | pnpm exec wrangler secret put CONVEX_HTTP_SECRET

pnpm exec wrangler secret put OPENROUTER_API_KEY
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_CHAT_ID
```

The production Convex URL is configured as `https://energetic-partridge-813.convex.cloud` in `wrangler.jsonc`. Keep `CONVEX_HTTP_SECRET` out of git and set the same random value in both Convex and Cloudflare.

Deploy:

```bash
pnpm run convex:deploy
pnpm run cloudflare:deploy
```

`pnpm run deploy` runs those two deployment steps in order. `pnpm run cloudflare:dry-run` builds the frontend and validates the Worker bundle without rolling out a container image.

### GitHub Actions deployment

The repository includes `.github/workflows/deploy.yml` to deploy on every push to `main` and from the manual **Run workflow** button in GitHub Actions. The GitHub-hosted Ubuntu runner has Docker available, so this path can build and upload the Cloudflare Container without Docker installed locally.

Required GitHub repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account id.
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token. Use the **Edit Cloudflare Workers** template and include Containers edit access if the template does not include it.
- `CONVEX_DEPLOY_KEY`: Convex production deploy key with `deployment:deploy` permission.

Cloudflare Worker secrets are managed directly in Cloudflare with `wrangler secret put`; the current deployment needs `OPENROUTER_API_KEY` and `CONVEX_HTTP_SECRET`, which are already set in Cloudflare.

With GitHub CLI:

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --body "33fc046ae39af5e3cc14e465646b1544"
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CONVEX_DEPLOY_KEY
```

The Worker is configured in `wrangler.jsonc` for:

```text
https://vibe-check.thatcanadian.dev
```

If the custom domain cannot be created by Wrangler, add it in the Cloudflare dashboard under Workers & Pages > vibe-check > Settings > Domains & Routes, or re-authenticate Wrangler with a token/profile that can manage the `thatcanadian.dev` zone.

## Environment Variables

- `OPENROUTER_API_KEY`: required for real LLM review and automatic audio transcription. Store as a Cloudflare Worker secret.
- `OPENROUTER_MODEL`: default model, currently `deepseek/deepseek-v4-flash`.
- `OPENROUTER_VISION_ENABLED`: set to `false` to skip sampled-frame vision review, default `true`.
- `OPENROUTER_VISION_MODEL`: vision pre-pass model, currently `minimax/minimax-m3`.
- `OPENROUTER_VISION_MAX_FRAMES`: maximum sampled frames sent to the vision model per creative, default `12`.
- `OPENROUTER_VISION_MAX_IMAGE_EDGE`: resized max image dimension before vision upload, default `1024`.
- `OPENROUTER_VISION_JPEG_QUALITY`: JPEG quality for vision input frames, default `75`.
- `OPENROUTER_STT_MODEL`: default speech-to-text model, currently `openai/whisper-large-v3`.
- `OPENROUTER_STT_LANGUAGE`: optional ISO-639-1 transcription language code. Leave empty for auto-detection.
- `OPENROUTER_STT_CHUNK_SECONDS`: automatic transcript chunk size for approximate audio timestamps, default `10`.
- `OPENROUTER_STT_MAX_CHUNKS`: maximum automatic transcript chunks, default `30`.
- `CONVEX_DEPLOYMENT`: Convex deployment selector for CLI commands, currently `prod:energetic-partridge-813`.
- `CONVEX_URL`: Convex deployment URL ending in `.convex.cloud`. This is non-secret config in `wrangler.jsonc`.
- `CONVEX_HTTP_SECRET`: shared secret used by the container when writing to Convex. Store the same value in Convex env vars and Cloudflare Worker secrets.
- `APP_PASSWORD`: optional simple API password gate for deployed MVP.
- `APP_PUBLIC_URL`: public app URL used when Telegram notifications link to completed reports.
- `TELEGRAM_BOT_TOKEN`: optional bot token for completed-review Telegram alerts. Store as a Cloudflare Worker secret.
- `TELEGRAM_CHAT_ID`: optional group chat id for completed-review Telegram alerts. Store as a Cloudflare Worker secret.
- `TELEGRAM_MESSAGE_THREAD_ID`: optional Telegram topic/thread id when posting into a forum topic.
- `MAX_UPLOAD_MB`: upload limit, default `200`.
- `JOB_DATA_DIR`: scratch job artifact directory inside the container, default `/tmp/vibe-check/jobs` in Cloudflare.
- `JOB_WORKER_CONCURRENCY`: number of review jobs processed in parallel, default `4` and capped at `8` to protect a single container from accidental overload.

## API

- `POST /api/reviews`: create a job with one MP4, JPG, PNG, or WebP creative, optional platform caption/body ad copy, optional additional policy text, notes, optional manual transcript override, model, frame interval, scene toggle. If no creative file is submitted, `ad_copy` is required and the job reviews copy only.

Saved default guidelines live in `backend/app/review_pipeline/guidelines/general_publisher_ad_creative_guidelines.md` and are included in every LLM review. Any submitted `policy_text` is appended as additional policy context.
- `GET /api/reviews`: recent review history with filename, upload date, status, progress, and final result when available.
- `GET /api/reviews/{job_id}`: status and progress.
- `GET /api/reviews/{job_id}/report`: structured report JSON.
- `GET /api/reviews/{job_id}/report.json`: downloadable report.
- `GET /api/reviews/{job_id}/frames/{filename}`: frame thumbnail.

## Job Records

Each job persists a Convex `reviews` row with the job id, uploaded filename or copy preview, upload/update timestamps, current status/progress, and final report JSON. Reports include separate creative and ad-copy source results when the LLM returns them. Result verdicts use a four-level scale: `green` (ready to run), `yellow` (minor fixes), `orange` (human review required), and `red` (do not publish without material changes). Multi-creative uploads and multi-line copy-only submissions are represented as multiple jobs in the UI. Creatives, frames, OCR scratch files, visual observation scratch files, and audio extracts are deleted from the container after processing.

## Cost-Saving Notes

The backend sends at most `OPENROUTER_VISION_MAX_FRAMES` resized sampled frames to the vision pre-pass, then sends only compact visual observations to the final compliance LLM. It also sends timestamped transcript chunks, deduplicated OCR text, and sampled frame references. Increase frame sampling intervals or lower the vision frame cap to reduce OCR, vision, and transcription cost.

## Limitations

- 1 frame/sec can miss quick flashes.
- OCR can miss stylized, animated, obscured, or tiny text.
- Automatic transcription uses OpenRouter Speech-to-Text and requires `OPENROUTER_API_KEY`; automatic audio timestamps are approximate chunk ranges, not word-level alignment. Paste a manual transcript when audio is unavailable or transcription fails.
- Long audio may exceed upstream transcription timeouts; short ad creatives are the intended MVP path.
- Visual review depends on selected model capability and is based on capped, resized sampled frames rather than every video frame.
- Automated review is not official platform approval and should be treated as decision support.

## Testing

```bash
pnpm run test
pnpm run build
pnpm run typecheck:worker
```
