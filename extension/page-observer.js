(() => {
  if (window.__vibeCheckLiveObserverInstalled) return;
  window.__vibeCheckLiveObserverInstalled = true;

  const MAX_DEPTH = 8;
  const MAX_OBJECTS = 20_000;
  const MEDIA_HOSTS = ['.fbcdn.net', '.facebook.com', '.cdninstagram.com'];

  function stringValue(...values) {
    return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
  }

  function exactStringValue(...values) {
    return values.find((value) => typeof value === 'string' && value.trim()) ?? '';
  }

  function idValue(...values) {
    const value = values.find((candidate) =>
      (typeof candidate === 'string' || typeof candidate === 'number')
      && String(candidate).trim()
    );
    return value === undefined ? '' : String(value).trim();
  }

  function allowedMediaUrl(value) {
    if (typeof value !== 'string' || value.length > 4_000) return '';
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return '';
      const host = url.hostname.toLowerCase();
      return MEDIA_HOSTS.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
        ? url.href
        : '';
    } catch {
      return '';
    }
  }

  function pushText(target, value) {
    if (typeof value === 'string') {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (normalized && normalized.length <= 5_000 && !target.includes(normalized)) {
        target.push(normalized);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') pushText(target, item);
        else if (item && typeof item === 'object') {
          pushText(target, item.text);
          pushText(target, item.body);
          pushText(target, item.message);
        }
      }
    }
  }

  function primaryTexts(ad, creative) {
    const texts = [];
    pushText(texts, ad.primary_text);
    pushText(texts, ad.primary_texts);
    pushText(texts, ad.body);
    pushText(texts, creative?.body);
    pushText(texts, creative?.message);
    pushText(texts, creative?.object_story_spec?.link_data?.message);
    pushText(texts, creative?.object_story_spec?.video_data?.message);
    pushText(texts, creative?.objectStorySpec?.linkData?.message);
    pushText(texts, creative?.objectStorySpec?.videoData?.message);
    pushText(texts, creative?.asset_feed_spec?.bodies);
    pushText(texts, creative?.assetFeedSpec?.bodies);
    return texts.slice(0, 25);
  }

  function findMedia(root) {
    if (!root || typeof root !== 'object') return null;
    const seen = new Set();
    const queue = [{ value: root, depth: 0 }];
    let image = null;
    while (queue.length && seen.size < 2_000) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      for (const [rawKey, child] of Object.entries(value)) {
        const key = rawKey.toLowerCase();
        if (typeof child === 'string') {
          const url = allowedMediaUrl(child);
          if (!url) continue;
          if (
            key.includes('playable')
            || key.includes('video_url')
            || key === 'source'
            || key.includes('video_source')
          ) {
            return { media_type: 'video', media_url: url };
          }
          if (
            key.includes('image')
            || key.includes('picture')
            || key.includes('thumbnail')
          ) {
            image ??= { media_type: 'image', media_url: url };
          }
        } else if (depth < 5 && child && typeof child === 'object') {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    return image;
  }

  function creativeObject(value) {
    const direct = value.creative ?? value.ad_creative ?? value.adCreative;
    if (direct && typeof direct === 'object') return direct;
    const collection = value.adcreatives?.data ?? value.creatives?.data;
    return Array.isArray(collection) && collection[0] && typeof collection[0] === 'object'
      ? collection[0]
      : {};
  }

  function isVideoCreative(creative) {
    return Boolean(
      creative?.video_id
      || creative?.videoId
      || creative?.object_story_spec?.video_data?.video_id
      || creative?.objectStorySpec?.videoData?.videoId
      || creative?.asset_feed_spec?.videos?.length
      || creative?.assetFeedSpec?.videos?.length
    );
  }

  function candidateFromObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const typename = stringValue(value.__typename, value.type).toLowerCase();
    const creative = creativeObject(value);
    const adId = idValue(value.ad_id, value.adId, value.adgroup_id, value.adGroupId);
    const hasAdShape = Boolean(
      adId
      || typename === 'ad'
      || typename.endsWith('adrow')
      || (
        (value.adset_id || value.adSetId)
        && (value.campaign_id || value.campaignId)
        && Object.keys(creative).length
      )
    );
    if (!hasAdShape) return null;

    const resolvedId = adId || idValue(value.id);
    const name = exactStringValue(value.ad_name, value.adName, value.name);
    if (!resolvedId || !name) return null;
    let media = findMedia(creative) ?? findMedia(value);
    if (isVideoCreative(creative) && media?.media_type !== 'video') {
      media = { media_type: 'video', media_url: null };
    }
    const campaign = value.campaign && typeof value.campaign === 'object' ? value.campaign : {};
    const adSet = value.adset && typeof value.adset === 'object'
      ? value.adset
      : value.ad_set && typeof value.ad_set === 'object' ? value.ad_set : {};
    return {
      ad_id: resolvedId,
      creative_name: name,
      primary_texts: primaryTexts(value, creative),
      delivery_status: stringValue(
        value.effective_status,
        value.effectiveStatus,
        value.delivery_status,
        value.deliveryStatus,
        value.status
      ),
      campaign_name: stringValue(value.campaign_name, value.campaignName, campaign.name),
      ad_set_name: stringValue(value.adset_name, value.adSetName, adSet.name),
      media_url: media?.media_url ?? null,
      media_type: media?.media_type ?? 'unknown',
      media_file_name: stringValue(creative.name),
    };
  }

  function scanPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const candidates = [];
    const seen = new Set();
    const queue = [{ value: payload, depth: 0 }];
    while (queue.length && seen.size < MAX_OBJECTS) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (!Array.isArray(value)) {
        const candidate = candidateFromObject(value);
        if (candidate) candidates.push(candidate);
      }
      if (depth >= MAX_DEPTH) continue;
      const children = Array.isArray(value) ? value : Object.values(value);
      for (const child of children) {
        if (child && typeof child === 'object') {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    if (candidates.length) {
      window.postMessage({
        source: 'vibe-check-live-scanner',
        type: 'ads',
        ads: candidates,
      }, window.location.origin);
    }
  }

  function parseJsonText(value) {
    if (typeof value !== 'string' || value.length > 20_000_000) return null;
    const normalized = value.replace(/^for\s*\(\s*;;\s*\)\s*;?/, '').trim();
    if (!normalized.startsWith('{') && !normalized.startsWith('[')) return null;
    try {
      return JSON.parse(normalized);
    } catch {
      return null;
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function vibeCheckObservedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const clone = response.clone();
      const type = clone.headers.get('content-type') ?? '';
      if (type.includes('json') || type.includes('javascript')) {
        clone.text().then((text) => {
          const parsed = parseJsonText(text);
          if (parsed) scanPayload(parsed);
        }).catch(() => {});
      }
    } catch {
      // Ads Manager must continue normally even when observation fails.
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function vibeCheckObservedOpen(...args) {
    this.addEventListener('load', () => {
      try {
        const parsed = parseJsonText(this.responseText);
        if (parsed) scanPayload(parsed);
      } catch {
        // Ignore non-text and non-JSON responses.
      }
    }, { once: true });
    return originalOpen.apply(this, args);
  };
})();
