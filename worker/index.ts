import { Container } from "@cloudflare/containers";

type OptionalSecrets = Env & {
  ACP_CLIENT_PASSWORD?: string;
  ACP_CLIENT_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  APP_PASSWORD?: string;
  APP_PUBLIC_URL?: string;
  CLIENT_ADMIN_PASSWORD?: string;
  CLIENT_ADMIN_USERNAME?: string;
  KISSTERRA_CLIENT_PASSWORD?: string;
  KISSTERRA_CLIENT_USERNAME?: string;
  LEAD_ECONOMY_CLIENT_PASSWORD?: string;
  LEAD_ECONOMY_CLIENT_USERNAME?: string;
  SMART_FINANCIAL_CLIENT_PASSWORD?: string;
  SMART_FINANCIAL_CLIENT_USERNAME?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_MESSAGE_THREAD_ID?: string;
};

const BACKEND_SLOTS = ["primary-blue", "primary-green", "primary-v25"] as const;
const BACKEND_SHARD_HEADER = "x-vibe-backend-shard";
const MAX_BACKEND_SHARDS = 50;

function backendSlot(env: Env): string {
  return env.BACKEND_SLOT || "primary-v25";
}

function backendShardCount(env: Env): number {
  const configured = Number.parseInt(env.REVIEW_BACKEND_SHARDS || "1", 10);
  if (!Number.isFinite(configured)) return 1;
  return Math.max(1, Math.min(configured, MAX_BACKEND_SHARDS));
}

function stableShardIndex(value: string, shardCount: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % shardCount;
}

function backendName(env: Env, shardKey = "default"): string {
  const slot = backendSlot(env);
  const shardCount = backendShardCount(env);
  if (shardCount === 1) return slot;
  return `${slot}-${stableShardIndex(shardKey, shardCount)}`;
}

function requestShardKey(request: Request): string {
  const supplied = request.headers.get(BACKEND_SHARD_HEADER)?.trim();
  if (supplied) return supplied.slice(0, 200);
  return "default";
}

async function stopInactiveBackends(env: Env): Promise<void> {
  const activeSlot = backendSlot(env);
  await Promise.allSettled(
    BACKEND_SLOTS
      .filter((slot) => slot !== activeSlot)
      .map((slot) => env.REVIEW_BACKEND.getByName(slot).destroy()),
  );
}

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
    needs_review_recovery?: boolean;
  } | null;
  if (!state || typeof state !== "object") return false;
  if (
    state.needs_maintenance
    || state.needs_recovery
    || state.needs_review_recovery
    || state.needs_notification
  ) return true;
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
      ACP_CLIENT_PASSWORD: optionalSecrets.ACP_CLIENT_PASSWORD ?? "",
      ACP_CLIENT_USERNAME: optionalSecrets.ACP_CLIENT_USERNAME ?? "acp",
      ADMIN_PASSWORD: optionalSecrets.ADMIN_PASSWORD ?? "",
      APP_PASSWORD: optionalSecrets.APP_PASSWORD ?? "",
      APP_ALLOWED_HOSTS: env.APP_ALLOWED_HOSTS,
      APP_PUBLIC_URL: optionalSecrets.APP_PUBLIC_URL ?? "",
      CLIENT_ADMIN_PASSWORD: optionalSecrets.CLIENT_ADMIN_PASSWORD ?? "",
      CLIENT_ADMIN_USERNAME: optionalSecrets.CLIENT_ADMIN_USERNAME ?? "admin",
      CONVEX_HTTP_SECRET: env.CONVEX_HTTP_SECRET,
      CONVEX_URL: env.CONVEX_URL,
      GOOGLE_AD_COPY_SHEET_URL: env.GOOGLE_AD_COPY_SHEET_URL,
      GOOGLE_DRIVE_FOLDER_ID: env.GOOGLE_DRIVE_FOLDER_ID,
      GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON,
      JOB_DATA_DIR: env.JOB_DATA_DIR,
      JOB_PROCESSING_TIMEOUT_SECONDS: env.JOB_PROCESSING_TIMEOUT_SECONDS,
      JOB_WORKER_CONCURRENCY: env.JOB_WORKER_CONCURRENCY,
      KISSTERRA_CLIENT_PASSWORD: optionalSecrets.KISSTERRA_CLIENT_PASSWORD ?? "",
      KISSTERRA_CLIENT_USERNAME: optionalSecrets.KISSTERRA_CLIENT_USERNAME ?? "kissterra",
      LEAD_ECONOMY_CLIENT_PASSWORD: optionalSecrets.LEAD_ECONOMY_CLIENT_PASSWORD ?? "",
      LEAD_ECONOMY_CLIENT_USERNAME: optionalSecrets.LEAD_ECONOMY_CLIENT_USERNAME ?? "lead-economy",
      MAX_UPLOAD_MB: env.MAX_UPLOAD_MB,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      OPENROUTER_DATA_COLLECTION: env.OPENROUTER_DATA_COLLECTION,
      OPENROUTER_MODEL: env.OPENROUTER_MODEL,
      OPENROUTER_PROVIDER_SORT: env.OPENROUTER_PROVIDER_SORT,
      OPENROUTER_REQUEST_TIMEOUT_SECONDS: env.OPENROUTER_REQUEST_TIMEOUT_SECONDS,
      OPENROUTER_VISION_ENABLED: env.OPENROUTER_VISION_ENABLED,
      OPENROUTER_VISION_MODEL: env.OPENROUTER_VISION_MODEL,
      OPENROUTER_VISION_MAX_FRAMES: env.OPENROUTER_VISION_MAX_FRAMES,
      OPENROUTER_VISION_MAX_IMAGE_EDGE: env.OPENROUTER_VISION_MAX_IMAGE_EDGE,
      OPENROUTER_VISION_JPEG_QUALITY: env.OPENROUTER_VISION_JPEG_QUALITY,
      OPENROUTER_STT_MODEL: env.OPENROUTER_STT_MODEL,
      OPENROUTER_STT_LANGUAGE: env.OPENROUTER_STT_LANGUAGE,
      OPENROUTER_STT_CHUNK_SECONDS: env.OPENROUTER_STT_CHUNK_SECONDS,
      OPENROUTER_STT_CHUNK_CONCURRENCY: env.OPENROUTER_STT_CHUNK_CONCURRENCY,
      OPENROUTER_STT_MAX_CHUNKS: env.OPENROUTER_STT_MAX_CHUNKS,
      OPENROUTER_STT_WHOLE_AUDIO_MAX_SECONDS: env.OPENROUTER_STT_WHOLE_AUDIO_MAX_SECONDS,
      OPENROUTER_ZDR: env.OPENROUTER_ZDR,
      REVIEW_BACKEND_SHARDS: env.REVIEW_BACKEND_SHARDS,
      SMART_FINANCIAL_CLIENT_PASSWORD: optionalSecrets.SMART_FINANCIAL_CLIENT_PASSWORD ?? "",
      SMART_FINANCIAL_CLIENT_USERNAME: optionalSecrets.SMART_FINANCIAL_CLIENT_USERNAME ?? "smart-financial",
      TELEGRAM_BOT_TOKEN: optionalSecrets.TELEGRAM_BOT_TOKEN ?? "",
      TELEGRAM_CHAT_ID: optionalSecrets.TELEGRAM_CHAT_ID ?? "",
      TELEGRAM_MESSAGE_THREAD_ID: optionalSecrets.TELEGRAM_MESSAGE_THREAD_ID ?? "",
    };
  }

  override onStart(): void {
    console.log(JSON.stringify({ event: "review_backend_started" }));
  }

  override onStop(
    { exitCode, reason }: Parameters<Container<Env>["onStop"]>[0],
  ): void {
    console.log(JSON.stringify({
      event: "review_backend_stopped",
      exitCode,
      reason,
    }));
  }

  override onError(error: unknown): never {
    console.error(JSON.stringify({
      event: "review_backend_error",
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : "",
      errorType: error instanceof Error ? error.name : typeof error,
    }));
    throw error;
  }

  override async onActivityExpired(): Promise<void> {
    const optionalSecrets = this.env as OptionalSecrets;
    const headers = new Headers({
      "x-automation-secret": this.env.CONVEX_HTTP_SECRET,
    });
    if (optionalSecrets.APP_PASSWORD) {
      headers.set("x-app-password", optionalSecrets.APP_PASSWORD);
    }
    try {
      if (await hasDueAutomations(this.env)) {
        this.renewActivityTimeout();
        console.log(JSON.stringify({
          event: "review_backend_kept_awake_for_durable_work",
        }));
        return;
      }
      const response = await this.containerFetch(
        "http://localhost/api/internal/queue-state",
        { headers },
      );
      if (!response.ok) {
        throw new Error(`Queue state returned ${response.status}`);
      }
      const state = await response.json() as { active?: number; pending?: number };
      if ((state.active ?? 0) > 0 || (state.pending ?? 0) > 0) {
        this.renewActivityTimeout();
        console.log(JSON.stringify({
          event: "review_backend_kept_awake",
          active: state.active ?? 0,
          pending: state.pending ?? 0,
        }));
        return;
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "review_backend_idle_check_failed",
        errorType: error instanceof Error ? error.name : typeof error,
      }));
      this.renewActivityTimeout();
      return;
    }
    await this.stop();
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const backend = env.REVIEW_BACKEND.getByName(
        backendName(env, requestShardKey(request)),
      );
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
      await stopInactiveBackends(env);
      const backend = env.REVIEW_BACKEND.getByName(backendName(env));
      const recoveryResponse = await backend.fetch(new Request(
        new URL("/api/internal/review-recovery", baseUrl),
        { method: "POST", headers },
      ));
      if (!recoveryResponse.ok) {
        throw new Error(
          `Review recovery failed with status ${recoveryResponse.status}`,
        );
      }
      const recoveryResult = await recoveryResponse.clone().json() as {
        already_draining?: boolean;
        drained?: boolean;
        queue?: { active?: number; pending?: number };
        recovered?: { failed?: number; requeued?: number };
      };
      console.log(JSON.stringify({
        event: "review_recovery_tick",
        alreadyDraining: recoveryResult.already_draining ?? false,
        drained: recoveryResult.drained ?? false,
        active: recoveryResult.queue?.active ?? 0,
        pending: recoveryResult.queue?.pending ?? 0,
        failed: recoveryResult.recovered?.failed ?? 0,
        requeued: recoveryResult.recovered?.requeued ?? 0,
      }));
      if (!await hasDueAutomations(env)) return;
      const response = await backend.fetch(request);
      if (!response.ok) {
        throw new Error(`Automation tick failed with status ${response.status}`);
      }
    })());
  },
} satisfies ExportedHandler<Env>;
