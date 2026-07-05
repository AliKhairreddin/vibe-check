import { Container } from "@cloudflare/containers";

const BACKEND_INSTANCE = "primary";
type OptionalSecrets = Env & { APP_PASSWORD?: string };

export class ReviewBackend extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "30m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const optionalSecrets = env as OptionalSecrets;
    this.envVars = {
      APP_PASSWORD: optionalSecrets.APP_PASSWORD ?? "",
      APP_ALLOWED_HOSTS: env.APP_ALLOWED_HOSTS,
      CONVEX_HTTP_SECRET: env.CONVEX_HTTP_SECRET,
      CONVEX_URL: env.CONVEX_URL,
      JOB_DATA_DIR: env.JOB_DATA_DIR,
      MAX_UPLOAD_MB: env.MAX_UPLOAD_MB,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      OPENROUTER_MODEL: env.OPENROUTER_MODEL,
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
