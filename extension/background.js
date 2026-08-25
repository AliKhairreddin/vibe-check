const DEFAULT_CONFIG = {
  enabled: true,
  serverUrl: 'https://admin.adchecked.com',
  appPassword: '',
};
const LEGACY_SERVER_ORIGIN = 'https://vibe-check.thatcanadian.dev';
const activeUploads = new Set();
let cachedScannerSession = null;
const META_MEDIA_HOSTS = ['.fbcdn.net', '.facebook.com', '.cdninstagram.com'];
const MAX_MEDIA_BYTES = 95 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 3;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  await chrome.storage.local.set({
    enabled: stored.enabled,
    serverUrl: normalizedServerUrl(stored.serverUrl),
    appPassword: stored.appPassword,
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'submit-observation') return false;
  submitObservation(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

async function config() {
  const value = await chrome.storage.local.get(DEFAULT_CONFIG);
  return {
    enabled: value.enabled !== false,
    serverUrl: normalizedServerUrl(value.serverUrl),
    appPassword: String(value.appPassword ?? '').trim(),
  };
}

function normalizedServerUrl(value) {
  const url = new URL(String(value || DEFAULT_CONFIG.serverUrl));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) {
    throw new Error('AdChecked URL must use HTTPS.');
  }
  return url.origin === LEGACY_SERVER_ORIGIN ? DEFAULT_CONFIG.serverUrl : url.origin;
}

async function headers(settings, values = {}) {
  const result = new Headers(values);
  result.set('authorization', `Bearer ${await scannerToken(settings)}`);
  return result;
}

async function scannerToken(settings) {
  if (!settings.appPassword) throw new Error('Add the scanner access password in extension settings.');
  const cacheKey = `${settings.serverUrl}\0${settings.appPassword}`;
  if (
    cachedScannerSession?.cacheKey === cacheKey
    && cachedScannerSession.expiresAt > Math.floor(Date.now() / 1000) + 60
  ) return cachedScannerSession.token;
  const response = await fetch(`${settings.serverUrl}/api/scanner/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: settings.appPassword }),
  });
  const session = await responseJson(response);
  if (!session.token || !session.expires_at) throw new Error('AdChecked returned an invalid scanner session.');
  cachedScannerSession = {
    cacheKey,
    expiresAt: Number(session.expires_at),
    token: String(session.token),
  };
  return cachedScannerSession.token;
}

async function submitObservation(payload) {
  const settings = await config();
  if (!settings.enabled) return { disabled: true };
  const response = await fetch(`${settings.serverUrl}/api/live-scans/observe`, {
    method: 'POST',
    headers: await headers(settings, { 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const result = await responseJson(response);
  await chrome.storage.local.set({
    lastAccountId: payload.account_id,
    lastAccountName: payload.account_name,
    lastError: '',
    lastObservedAt: Date.now(),
    lastResult: {
      liveAds: result.live_ads,
      uniqueCreatives: result.unique_creatives,
      copyVariants: result.unique_primary_texts,
    },
  });

  const byCreativeName = new Map();
  for (const ad of payload.ads) {
    const current = byCreativeName.get(ad.creative_name) ?? {};
    byCreativeName.set(ad.creative_name, {
      ...current,
      ...ad,
      media_url: ad.media_url || current.media_url || null,
    });
  }
  await forEachWithConcurrency(result.media_requests ?? [], MAX_CONCURRENT_UPLOADS, async (request) => {
    const candidate = byCreativeName.get(request.creative_name);
    const mediaUrl = request.media_url || candidate?.media_url;
    if (!mediaUrl || activeUploads.has(request.job_id)) return;
    activeUploads.add(request.job_id);
    try {
      await uploadMedia(settings, payload, request, mediaUrl);
    } catch (error) {
      await chrome.storage.local.set({ lastError: errorMessage(error) });
    } finally {
      activeUploads.delete(request.job_id);
    }
  });
  return result;
}

async function forEachWithConcurrency(values, concurrency, operation) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        await operation(values[index]);
      }
    },
  );
  await Promise.all(workers);
}

async function uploadMedia(settings, payload, request, mediaUrl) {
  if (!isAllowedMetaMediaUrl(mediaUrl)) {
    throw new Error('Meta returned a media URL outside the allowed Facebook CDN hosts.');
  }
  const mediaResponse = await fetch(mediaUrl, { redirect: 'follow' });
  if (!mediaResponse.ok) {
    throw new Error(`Meta media download failed (${mediaResponse.status}).`);
  }
  if (!isAllowedMetaMediaUrl(mediaResponse.url)) {
    throw new Error('Meta redirected the media download outside the allowed CDN hosts.');
  }
  const contentLength = Number(mediaResponse.headers.get('content-length') || 0);
  if (contentLength > MAX_MEDIA_BYTES) {
    throw new Error('Meta media is larger than the 95 MB browser-scanner upload limit.');
  }
  const blob = await mediaResponse.blob();
  if (!blob.size) throw new Error('Meta returned an empty media file.');
  if (blob.size > MAX_MEDIA_BYTES) {
    throw new Error('Meta media is larger than the 95 MB browser-scanner upload limit.');
  }
  if (
    blob.type
    && !blob.type.startsWith('image/')
    && !blob.type.startsWith('video/')
    && blob.type !== 'application/octet-stream'
  ) {
    throw new Error(`Meta returned an unexpected media type (${blob.type}).`);
  }
  const fileName = mediaFileName(request.creative_name, blob.type, request.media_type);
  const form = new FormData();
  form.append('creative', blob, fileName);
  form.append('creative_name', request.creative_name);
  form.append('account_id', payload.account_id);
  form.append('account_name', payload.account_name);
  form.append('observation_date', payload.observation_date);
  form.append('source_url', payload.source_url);
  const response = await fetch(`${settings.serverUrl}/api/live-scans/creative`, {
    method: 'POST',
    headers: await headers(settings),
    body: form,
  });
  await responseJson(response);
}

function isAllowedMetaMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return META_MEDIA_HOSTS.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
  } catch {
    return false;
  }
}

function mediaFileName(creativeName, mimeType, mediaType) {
  const safeName = String(creativeName || 'meta-creative')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .trim()
    .slice(0, 180) || 'meta-creative';
  const extension = {
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  }[mimeType] ?? (mediaType === 'image' ? '.jpg' : '.mp4');
  return safeName.toLowerCase().endsWith(extension) ? safeName : `${safeName}${extension}`;
}

async function responseJson(response) {
  const text = await response.text();
  let value = {};
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = {};
  }
  if (!response.ok) {
    throw new Error(value.detail || value.message || `AdChecked request failed (${response.status}).`);
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

self.addEventListener('unhandledrejection', (event) => {
  chrome.storage.local.set({ lastError: errorMessage(event.reason) }).catch(() => {});
});
