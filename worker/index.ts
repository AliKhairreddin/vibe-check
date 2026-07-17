import { Container } from "@cloudflare/containers";

// Bump the instance name when a new container image must replace an already-awake instance.
const BACKEND_INSTANCE = "primary-v7";
type OptionalSecrets = Env & {
  ADMIN_PASSWORD?: string;
  APP_PASSWORD?: string;
  APP_PUBLIC_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_MESSAGE_THREAD_ID?: string;
};

export class ReviewBackend extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "30m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const optionalSecrets = env as OptionalSecrets;
    this.envVars = {
      ADMIN_PASSWORD: optionalSecrets.ADMIN_PASSWORD ?? "",
      APP_PASSWORD: optionalSecrets.APP_PASSWORD ?? "",
      APP_ALLOWED_HOSTS: env.APP_ALLOWED_HOSTS,
      APP_PUBLIC_URL: optionalSecrets.APP_PUBLIC_URL ?? "",
      CONVEX_HTTP_SECRET: env.CONVEX_HTTP_SECRET,
      CONVEX_URL: env.CONVEX_URL,
      GOOGLE_AD_COPY_SHEET_URL: env.GOOGLE_AD_COPY_SHEET_URL,
      GOOGLE_DRIVE_FOLDER_ID: env.GOOGLE_DRIVE_FOLDER_ID,
      GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON,
      JOB_DATA_DIR: env.JOB_DATA_DIR,
      JOB_WORKER_CONCURRENCY: env.JOB_WORKER_CONCURRENCY,
      MAX_UPLOAD_MB: env.MAX_UPLOAD_MB,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      OPENROUTER_MODEL: env.OPENROUTER_MODEL,
      OPENROUTER_VISION_ENABLED: env.OPENROUTER_VISION_ENABLED,
      OPENROUTER_VISION_MODEL: env.OPENROUTER_VISION_MODEL,
      OPENROUTER_VISION_MAX_FRAMES: env.OPENROUTER_VISION_MAX_FRAMES,
      OPENROUTER_VISION_MAX_IMAGE_EDGE: env.OPENROUTER_VISION_MAX_IMAGE_EDGE,
      OPENROUTER_VISION_JPEG_QUALITY: env.OPENROUTER_VISION_JPEG_QUALITY,
      OPENROUTER_STT_MODEL: env.OPENROUTER_STT_MODEL,
      OPENROUTER_STT_LANGUAGE: env.OPENROUTER_STT_LANGUAGE,
      OPENROUTER_STT_CHUNK_SECONDS: env.OPENROUTER_STT_CHUNK_SECONDS,
      OPENROUTER_STT_MAX_CHUNKS: env.OPENROUTER_STT_MAX_CHUNKS,
      TELEGRAM_BOT_TOKEN: optionalSecrets.TELEGRAM_BOT_TOKEN ?? "",
      TELEGRAM_CHAT_ID: optionalSecrets.TELEGRAM_CHAT_ID ?? "",
      TELEGRAM_MESSAGE_THREAD_ID: optionalSecrets.TELEGRAM_MESSAGE_THREAD_ID ?? "",
    };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const backend = env.REVIEW_BACKEND.getByName(BACKEND_INSTANCE);
      return backend.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
