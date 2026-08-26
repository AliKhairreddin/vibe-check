import { Container } from "@cloudflare/containers";
import {
  ADMIN_HOST,
  API_HOST,
  CLIENT_HOST,
  PUBLIC_HOST,
  WWW_HOST,
  apiRequestAllowed,
  authRateLimitKey,
  hostSurface,
  isAdminPagePath,
  isAdminSessionPath,
  isClientPagePath,
  isStaticAssetPath,
  legacyDestination,
  shouldRedirectAdminPathToClient,
  type HostSurface,
} from "./routing";

type OptionalSecrets = Env & {
  ACP_CLIENT_PASSWORD?: string;
  ACP_CLIENT_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  APP_PASSWORD?: string;
  APP_PUBLIC_URL?: string;
  CLIENT_ADMIN_PASSWORD?: string;
  CLIENT_ADMIN_USERNAME?: string;
  EMPLOYEE_ADMIN_PASSWORD?: string;
  EMPLOYEE_ADMIN_USERNAME?: string;
  KISSTERRA_CLIENT_PASSWORD?: string;
  KISSTERRA_CLIENT_USERNAME?: string;
  LEAD_ECONOMY_CLIENT_PASSWORD?: string;
  LEAD_ECONOMY_CLIENT_USERNAME?: string;
  SMART_FINANCIAL_CLIENT_PASSWORD?: string;
  SMART_FINANCIAL_CLIENT_USERNAME?: string;
  SESSION_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_MESSAGE_THREAD_ID?: string;
};

const BACKEND_SLOTS = ["primary-blue", "primary-green", "primary-v25"] as const;
const BACKEND_SHARD_HEADER = "x-vibe-backend-shard";
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const CLIENT_ORIGIN = `https://${CLIENT_HOST}`;
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const MAX_BACKEND_SHARDS = 50;

const DOCUMENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://api.adchecked.com",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

function redirectResponse(destination: URL | string, status = 308): Response {
  return new Response(null, {
    status,
    headers: { location: destination.toString() },
  });
}

function notFoundResponse(): Response {
  return Response.json(
    { error: "Not found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

function unsupportedHostResponse(): Response {
  return Response.json(
    { error: "Misdirected request" },
    { status: 421, headers: { "cache-control": "no-store" } },
  );
}

function rateLimitedResponse(): Response {
  return Response.json(
    { error: "Too many sign-in attempts. Try again in one minute." },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": "60",
      },
    },
  );
}

function secureResponse(response: Response, surface: HostSurface): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("x-frame-options", "DENY");
  secured.headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  secured.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  if (surface !== "public") {
    secured.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  }
  const contentType = secured.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    secured.headers.set("content-security-policy", DOCUMENT_SECURITY_POLICY);
    secured.headers.set("cache-control", "no-cache");
  }
  return secured;
}

function legacyPartnerDocumentationView(pathname: string): "guide" | "reference" | null {
  if (pathname === "/api/v1/docs" || pathname === "/api/v1/docs/") return "guide";
  if (
    pathname === "/api/v1/reference"
    || pathname === "/api/v1/reference/"
    || pathname === "/developers/reference"
    || pathname === "/developers/reference/"
  ) return "reference";
  return null;
}

function isPartnerDocumentationHub(pathname: string): boolean {
  return pathname === "/developers/api" || pathname === "/developers/api/";
}

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
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/v1/")) {
    const authorization = request.headers.get("authorization")?.trim();
    if (authorization?.toLowerCase().startsWith("bearer ")) {
      if (url.pathname === "/api/v1/scans/creative") {
        const adId = request.headers.get("x-vibe-ad-id")?.trim();
        if (adId) return `scan:${authorization.slice(7, 207)}:${adId.slice(0, 200)}`;
      }
      // Stable per API key so a resumable upload stays on one container shard.
      return authorization.slice(7, 207);
    }
  }
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
    needs_api_maintenance?: boolean;
    needs_notification?: boolean;
    needs_recovery?: boolean;
    needs_review_recovery?: boolean;
  } | null;
  if (!state || typeof state !== "object") return false;
  if (
    state.needs_maintenance
    || state.needs_api_maintenance
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
      API_PUBLIC_URL: env.API_PUBLIC_URL,
      APP_PASSWORD: optionalSecrets.APP_PASSWORD ?? "",
      APP_ADMIN_HOSTS: env.APP_ADMIN_HOSTS,
      APP_ALLOWED_HOSTS: env.APP_ALLOWED_HOSTS,
      APP_LEGACY_HOSTS: env.APP_LEGACY_HOSTS,
      APP_PUBLIC_URL: optionalSecrets.APP_PUBLIC_URL ?? "",
      CLIENT_ADMIN_PASSWORD: optionalSecrets.CLIENT_ADMIN_PASSWORD ?? "",
      CLIENT_ADMIN_USERNAME: optionalSecrets.CLIENT_ADMIN_USERNAME ?? "admin",
      EMPLOYEE_ADMIN_PASSWORD: optionalSecrets.EMPLOYEE_ADMIN_PASSWORD ?? "",
      EMPLOYEE_ADMIN_USERNAME: optionalSecrets.EMPLOYEE_ADMIN_USERNAME ?? "isham",
      CONVEX_HTTP_SECRET: env.CONVEX_HTTP_SECRET,
      CONVEX_URL: env.CONVEX_URL,
      CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
      GOOGLE_AD_COPY_SHEET_URL: env.GOOGLE_AD_COPY_SHEET_URL,
      GOOGLE_DRIVE_ADDITIONAL_FOLDERS_JSON: env.GOOGLE_DRIVE_ADDITIONAL_FOLDERS_JSON,
      GOOGLE_DRIVE_FOLDER_ID: env.GOOGLE_DRIVE_FOLDER_ID,
      GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON,
      JOB_DATA_DIR: env.JOB_DATA_DIR,
      JOB_MAX_ATTEMPTS: env.JOB_MAX_ATTEMPTS,
      JOB_PROCESSING_TIMEOUT_SECONDS: env.JOB_PROCESSING_TIMEOUT_SECONDS,
      JOB_WORKER_CONCURRENCY: env.JOB_WORKER_CONCURRENCY,
      KISSTERRA_CLIENT_PASSWORD: optionalSecrets.KISSTERRA_CLIENT_PASSWORD ?? "",
      KISSTERRA_CLIENT_USERNAME: optionalSecrets.KISSTERRA_CLIENT_USERNAME ?? "kissterra",
      LEAD_ECONOMY_CLIENT_PASSWORD: optionalSecrets.LEAD_ECONOMY_CLIENT_PASSWORD ?? "",
      LEAD_ECONOMY_CLIENT_USERNAME: optionalSecrets.LEAD_ECONOMY_CLIENT_USERNAME ?? "lead-economy",
      MAX_UPLOAD_MB: env.MAX_UPLOAD_MB,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      OPENROUTER_DATA_COLLECTION: env.OPENROUTER_DATA_COLLECTION,
      OPENROUTER_MAX_ATTEMPTS: env.OPENROUTER_MAX_ATTEMPTS,
      OPENROUTER_MODEL: env.OPENROUTER_MODEL,
      OPENROUTER_PROVIDER_SORT: env.OPENROUTER_PROVIDER_SORT,
      OPENROUTER_RETRY_BASE_SECONDS: env.OPENROUTER_RETRY_BASE_SECONDS,
      OPENROUTER_REQUEST_TIMEOUT_SECONDS: env.OPENROUTER_REQUEST_TIMEOUT_SECONDS,
      OPENROUTER_VISION_ENABLED: env.OPENROUTER_VISION_ENABLED,
      OPENROUTER_VISION_MODEL: env.OPENROUTER_VISION_MODEL,
      OPENROUTER_VISION_MAX_FRAMES: env.OPENROUTER_VISION_MAX_FRAMES,
      OPENROUTER_VISION_MAX_IMAGE_EDGE: env.OPENROUTER_VISION_MAX_IMAGE_EDGE,
      OPENROUTER_VISION_JPEG_QUALITY: env.OPENROUTER_VISION_JPEG_QUALITY,
      OPENROUTER_VISION_MAX_ATTEMPTS: env.OPENROUTER_VISION_MAX_ATTEMPTS,
      OPENROUTER_STT_MODEL: env.OPENROUTER_STT_MODEL,
      OPENROUTER_STT_LANGUAGE: env.OPENROUTER_STT_LANGUAGE,
      OPENROUTER_STT_CHUNK_SECONDS: env.OPENROUTER_STT_CHUNK_SECONDS,
      OPENROUTER_STT_CHUNK_CONCURRENCY: env.OPENROUTER_STT_CHUNK_CONCURRENCY,
      OPENROUTER_STT_MAX_CHUNKS: env.OPENROUTER_STT_MAX_CHUNKS,
      OPENROUTER_STT_WHOLE_AUDIO_MAX_SECONDS: env.OPENROUTER_STT_WHOLE_AUDIO_MAX_SECONDS,
      OPENROUTER_ZDR: env.OPENROUTER_ZDR,
      REVIEW_BACKEND_SHARDS: env.REVIEW_BACKEND_SHARDS,
      SESSION_SECRET: optionalSecrets.SESSION_SECRET ?? "",
      SESSION_TTL_SECONDS: env.SESSION_TTL_SECONDS,
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
    const surface = hostSurface(url.hostname);
    if (surface === "unknown") return secureResponse(unsupportedHostResponse(), surface);

    if (url.hostname === WWW_HOST) {
      return secureResponse(
        redirectResponse(new URL(url.pathname + url.search, PUBLIC_ORIGIN)),
        surface,
      );
    }

    if (surface === "legacy" && !url.pathname.startsWith("/api/")) {
      return secureResponse(redirectResponse(legacyDestination(url)), surface);
    }

    const legacyDocumentationView = legacyPartnerDocumentationView(url.pathname);

    if (legacyDocumentationView) {
      const destination = new URL("/developers/api", ADMIN_ORIGIN);
      destination.searchParams.set("view", legacyDocumentationView);
      return secureResponse(redirectResponse(destination), surface);
    }

    if (isPartnerDocumentationHub(url.pathname) && (surface === "workers" || surface === "api")) {
      return secureResponse(
        redirectResponse(new URL(`${url.pathname}${url.search}`, ADMIN_ORIGIN)),
        surface,
      );
    }

    if (url.pathname.startsWith("/api/")) {
      if (!apiRequestAllowed(surface, url.pathname)) {
        return secureResponse(notFoundResponse(), surface);
      }
      const isClientSignIn = surface === "client" && (
        url.pathname === "/api/client/session" && request.method === "POST"
      );
      const isAdminSignIn = surface === "admin"
        && isAdminSessionPath(url.pathname)
        && request.method === "POST";
      const isLegacyScannerRequest = surface === "legacy" && (
        url.pathname === "/api/live-scans/observe"
        || url.pathname === "/api/live-scans/creative"
      );
      if (isClientSignIn || isAdminSignIn) {
        const limiter = surface === "admin" ? env.ADMIN_AUTH_RATE_LIMITER : env.AUTH_RATE_LIMITER;
        const { success } = await limiter.limit({
          key: authRateLimitKey(request, surface),
        });
        if (!success) return secureResponse(rateLimitedResponse(), surface);
      }
      const backend = env.REVIEW_BACKEND.getByName(
        backendName(env, requestShardKey(request)),
      );
      const response = await backend.fetch(request);
      if (
        (surface === "admin" || isLegacyScannerRequest)
        && response.status === 401
        && !isAdminSessionPath(url.pathname)
      ) {
        const { success } = await env.ADMIN_AUTH_RATE_LIMITER.limit({
          key: authRateLimitKey(request, surface),
        });
        if (!success) return secureResponse(rateLimitedResponse(), surface);
      }
      return secureResponse(response, surface);
    }

    if (surface === "api") {
      return secureResponse(redirectResponse(new URL("/developers/api", ADMIN_ORIGIN)), surface);
    }

    if (surface === "workers") {
      return secureResponse(
        redirectResponse(new URL(url.pathname + url.search, API_ORIGIN)),
        surface,
      );
    }

    if (isStaticAssetPath(url.pathname)) {
      return secureResponse(await env.ASSETS.fetch(request), surface);
    }

    if (surface === "public") {
      if (url.pathname === "/") return secureResponse(await env.ASSETS.fetch(request), surface);
      if (url.pathname === "/login") {
        return secureResponse(redirectResponse(new URL("/login", CLIENT_ORIGIN)), surface);
      }
      if (url.pathname === "/admin") {
        return secureResponse(redirectResponse(new URL("/login", ADMIN_ORIGIN)), surface);
      }
      if (url.pathname === "/developers/api") {
        return secureResponse(redirectResponse(new URL(url.pathname + url.search, ADMIN_ORIGIN)), surface);
      }
      return secureResponse(notFoundResponse(), surface);
    }

    if (surface === "client") {
      if (!isClientPagePath(url.pathname)) return secureResponse(notFoundResponse(), surface);
      return secureResponse(await env.ASSETS.fetch(request), surface);
    }

    if (surface === "admin") {
      if (shouldRedirectAdminPathToClient(url.pathname)) {
        return secureResponse(
          redirectResponse(new URL(url.pathname + url.search, CLIENT_ORIGIN)),
          surface,
        );
      }
      if (!isAdminPagePath(url.pathname)) return secureResponse(notFoundResponse(), surface);
      return secureResponse(await env.ASSETS.fetch(request), surface);
    }

    return secureResponse(notFoundResponse(), surface);
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
    const baseUrl = optionalSecrets.APP_PUBLIC_URL || ADMIN_ORIGIN;
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
