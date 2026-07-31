const DEFAULT_CONFIG = {
  enabled: true,
  serverUrl: 'https://vibe-check.thatcanadian.dev',
  appPassword: '',
};
const activeUploads = new Set();
const META_MEDIA_HOSTS = ['.fbcdn.net', '.facebook.com', '.cdninstagram.com'];
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  await chrome.storage.local.set({
    enabled: stored.enabled,
    serverUrl: stored.serverUrl,
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
    throw new Error('Vibe Check URL must use HTTPS.');
  }
  return url.origin;
}

function headers(settings, values = {}) {
  const result = new Headers(values);
  if (settings.appPassword) result.set('x-app-password', settings.appPassword);
  return result;
}

async function submitObservation(payload) {
  const settings = await config();
  if (!settings.enabled) return { disabled: true };
  const response = await fetch(`${settings.serverUrl}/api/live-scans/observe`, {
    method: 'POST',
    headers: headers(settings, { 'content-type': 'application/json' }),
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
  const uploads = [];
  for (const request of result.media_requests ?? []) {
    const candidate = byCreativeName.get(request.creative_name);
    const mediaUrl = request.media_url || candidate?.media_url;
    if (!mediaUrl || activeUploads.has(request.job_id)) continue;
    activeUploads.add(request.job_id);
    uploads.push(uploadMedia(settings, payload, request, mediaUrl)
      .catch(async (error) => {
        await chrome.storage.local.set({ lastError: errorMessage(error) });
      })
      .finally(() => activeUploads.delete(request.job_id)));
  }
  await Promise.allSettled(uploads);
  return result;
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
    throw new Error('Meta media is larger than the 200 MB upload limit.');
  }
  const blob = await mediaResponse.blob();
  if (!blob.size) throw new Error('Meta returned an empty media file.');
  if (blob.size > MAX_MEDIA_BYTES) {
    throw new Error('Meta media is larger than the 200 MB upload limit.');
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
    headers: headers(settings),
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
    throw new Error(value.detail || value.message || `Vibe Check request failed (${response.status}).`);
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

self.addEventListener('unhandledrejection', (event) => {
  chrome.storage.local.set({ lastError: errorMessage(event.reason) }).catch(() => {});
});
