import { Container } from "@cloudflare/containers";

// Bump the instance name when a new container image must replace an already-awake instance.
const BACKEND_INSTANCE = "primary-v9";
type OptionalSecrets = Env & {
  ADMIN_PASSWORD?: string;
  APP_PASSWORD?: string;
  APP_PUBLIC_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_MESSAGE_THREAD_ID?: string;
};

type AutomationSchedule = {
  days_of_week: number[];
  last_run_status?: string | null;
  last_scheduled_for?: string | null;
  time_of_day: string;
  timezone: string;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

function dueScheduleKey(automation: AutomationSchedule, now = new Date()): string | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: automation.timezone,
    weekday: "short",
    year: "numeric",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAY_INDEX[value("weekday")];
  if (!automation.days_of_week.includes(weekday)) return null;
  const currentTime = `${value("hour")}:${value("minute")}`;
  if (currentTime < automation.time_of_day) return null;
  return `${value("year")}-${value("month")}-${value("day")}@${automation.time_of_day}`;
}

async function hasDueAutomations(env: Env): Promise<boolean> {
  const now = Date.now();
  const response = await fetch(`${env.CONVEX_URL.replace(/\/$/, "")}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      path: "automations:tickState",
      args: { secret: env.CONVEX_HTTP_SECRET, now },
      format: "json",
    }),
  });
  if (!response.ok) {
    throw new Error(`Automation eligibility check failed with status ${response.status}`);
  }
  const payload = await response.json() as { status?: string; value?: unknown };
  if (payload.status !== "success") {
    throw new Error("Automation eligibility check returned an invalid response");
  }
  const state = payload.value as {
    automations?: AutomationSchedule[];
    needs_maintenance?: boolean;
    needs_notification?: boolean;
    needs_recovery?: boolean;
  } | null;
  if (!state || typeof state !== "object") return false;
  if (state.needs_maintenance || state.needs_recovery || state.needs_notification) return true;
  return (state.automations ?? []).some((automation) => {
    if (automation.last_run_status === "failed" && automation.last_scheduled_for) {
      return true;
    }
    if (["running", "queued"].includes(automation.last_run_status ?? "")) {
      return false;
    }
    const scheduleKey = dueScheduleKey(automation);
    if (!scheduleKey) return false;
    if (automation.last_scheduled_for !== scheduleKey) return true;
    return false;
  });
}

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
  scheduled(_controller, env, ctx): void {
    const optionalSecrets = env as OptionalSecrets;
    const headers = new Headers({
      "content-type": "application/json",
      "x-automation-secret": env.CONVEX_HTTP_SECRET,
    });
    if (optionalSecrets.APP_PASSWORD) {
      headers.set("x-app-password", optionalSecrets.APP_PASSWORD);
    }
    const baseUrl = optionalSecrets.APP_PUBLIC_URL || "https://vibe-check.thatcanadian.dev";
    const request = new Request(new URL("/api/automations/internal/tick", baseUrl), {
      method: "POST",
      headers,
    });
    ctx.waitUntil((async () => {
      if (!await hasDueAutomations(env)) return;
      const backend = env.REVIEW_BACKEND.getByName(BACKEND_INSTANCE);
      const response = await backend.fetch(request);
      if (!response.ok) {
        throw new Error(`Automation tick failed with status ${response.status}`);
      }
    })());
  },
} satisfies ExportedHandler<Env>;
