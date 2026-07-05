# Ad Compliance Video Reviewer

Docker-first MVP for reviewing MP4 ad videos against pasted platform policies. It extracts video metadata with `ffprobe`, samples frames with `ffmpeg`, runs OCR with Tesseract through an abstraction, uses a manual transcript fallback, and sends compact evidence to OpenRouter Chat Completions for a strict JSON compliance report.

## Stack

- Frontend: Vite, React, TypeScript, TanStack Router, TanStack Query, TanStack Table, Tailwind CSS, shadcn-style Base UI-ready local components, lucide-react.
- Backend: FastAPI, Pydantic, ffmpeg/ffprobe, OpenCV/Pillow, pytesseract, OpenRouter.
- Runtime: Docker and docker-compose. The video processor runs in a Linux container, not Cloudflare Workers.

## Local development

```bash
cp .env.example .env
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload --port 8000
cd frontend
pnpm install
pnpm dev
```

Open the Vite dev URL and upload an MP4 with ad copy and policy text.

## Docker

```bash
cp .env.example .env
# edit OPENROUTER_API_KEY in .env
docker compose up --build
```

Open <http://localhost:8000>.

## Environment variables

- `OPENROUTER_API_KEY`: required for real LLM review.
- `OPENROUTER_MODEL`: default model, e.g. `openai/gpt-4o-mini` for cost-effective text review or a vision-capable model for future visual review expansion.
- `APP_PASSWORD`: reserved optional simple password gate for deployed MVP.
- `MAX_UPLOAD_MB`: upload limit, default `200`.
- `JOB_DATA_DIR`: job artifact directory, default `data/jobs` locally and `/app/data/jobs` in Docker.

## API

- `POST /api/reviews`: create a job with MP4, ad copy, policy text, notes, optional transcript, model, frame interval, scene toggle.
- `GET /api/reviews/{job_id}`: status and progress.
- `GET /api/reviews/{job_id}/report`: structured report JSON.
- `GET /api/reviews/{job_id}/report.json`: downloadable report.
- `GET /api/reviews/{job_id}/frames/{filename}`: frame thumbnail.

## Job artifacts

Each job is saved under `data/jobs/{job_id}/` with `metadata.json`, `frames/`, `frames.json`, `ocr.json`, `transcript.json`, `report.json`, and `error.json` on failure.

## Deployment notes

- Render/Railway: deploy the Dockerfile, set env vars, attach persistent disk for `/app/data/jobs` if reports must persist.
- Fly.io: use the Dockerfile and mount a Fly volume at `/app/data/jobs`.
- Cloudflare can host DNS and route traffic to the container through Cloudflare Tunnel, while the MP4/OCR/transcription processor still runs in Docker because native ffmpeg/Tesseract dependencies need a container.

### Cloudflare Tunnel for `vibe-check.thatcanadian.dev`

This repository includes `cloudflare-tunnel.yml` and `docker-compose.cloudflare.yml` to expose only the VibeCheck subdomain through Cloudflare Tunnel. The tunnel ingress sends `https://vibe-check.thatcanadian.dev` to the Docker app on `http://app:8000` and returns `404` for every other hostname. The compose override also sets `APP_ALLOWED_HOSTS=vibe-check.thatcanadian.dev`, so the FastAPI app rejects requests whose `Host` header is not the VibeCheck subdomain.

One-time setup on the deployment host:

```bash
mkdir -p cloudflare
docker run --rm -it -v "$PWD/cloudflare:/etc/cloudflared" cloudflare/cloudflared:latest tunnel login
docker run --rm -it -v "$PWD/cloudflare:/etc/cloudflared" cloudflare/cloudflared:latest tunnel create vibe-check
docker run --rm -it -v "$PWD/cloudflare:/etc/cloudflared" cloudflare/cloudflared:latest tunnel route dns vibe-check vibe-check.thatcanadian.dev
cp cloudflare/<TUNNEL_ID>.json cloudflare/vibe-check.json
```

Then deploy the app and tunnel together:

```bash
docker compose -f docker-compose.yml -f docker-compose.cloudflare.yml up -d --build
```

Keep `cloudflare/` out of git because it contains Cloudflare account credentials.

## Cost-saving notes

The backend does not send every full frame to the LLM by default. It sends transcript chunks, deduplicated OCR text, and sampled frame references. Increase frame sampling intervals to reduce OCR and storage cost. Use cheaper text models when you do not need vision review.

## Limitations

- 1 frame/sec can miss quick flashes.
- OCR can miss stylized, animated, obscured, or tiny text.
- Local ASR is not enabled by default; paste a manual transcript for MVP transcript coverage.
- Visual review depends on selected model capability and is conservative in this MVP because full images are not sent by default.
- Automated review is not official platform approval and should be treated as decision support.

## Testing

```bash
cd backend
pytest -q
```
