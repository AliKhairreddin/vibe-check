(() => {
  const candidates = new Map();
  const LIVE_STATUS = /\b(active|delivering|learning|learning limited)\b/i;
  const NOT_LIVE_STATUS = /\b(paused|inactive|archived|deleted|disapproved|ended|completed)\b/i;
  const FIRST_SCAN_DELAY_MS = 12_000;
  const RESCAN_INTERVAL_MS = 5 * 60 * 1000;
  let flushTimer = null;
  let lastAccountId = '';

  function accountId() {
    const url = new URL(window.location.href);
    return url.searchParams.get('act') ?? url.searchParams.get('account_id') ?? '';
  }

  function accountName(id) {
    const selectors = [
      '[data-testid*="account"][aria-label]',
      '[aria-label*="Ad account"]',
      '[role="button"][aria-label*="account"]',
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const label = element?.getAttribute('aria-label')?.trim() || element?.textContent?.trim();
      if (label && label.length <= 300) return label;
    }
    return `Meta ad account ${id}`;
  }

  function localDate() {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function isLiveStatus(status) {
    if (!status || NOT_LIVE_STATUS.test(status)) return false;
    return LIVE_STATUS.test(status);
  }

  function isKnownStatus(status) {
    return Boolean(status && (LIVE_STATUS.test(status) || NOT_LIVE_STATUS.test(status)));
  }

  function mergeCandidate(candidate) {
    if (!candidate?.ad_id || !candidate?.creative_name) return;
    const current = candidates.get(candidate.ad_id) ?? {};
    candidates.set(candidate.ad_id, {
      ...current,
      ...candidate,
      primary_texts: [...new Set([
        ...(current.primary_texts ?? []),
        ...(candidate.primary_texts ?? []),
      ])].slice(0, 25),
      media_url: candidate.media_url || current.media_url || null,
      media_type: candidate.media_type !== 'unknown'
        ? candidate.media_type
        : current.media_type ?? 'unknown',
      delivery_status: candidate.delivery_status || current.delivery_status || '',
      campaign_name: candidate.campaign_name || current.campaign_name || '',
      ad_set_name: candidate.ad_set_name || current.ad_set_name || '',
    });
    scheduleFlush(FIRST_SCAN_DELAY_MS);
  }

  function scheduleFlush(delay) {
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(flush, delay);
  }

  function extractAdId(row) {
    const links = row.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      const match = href.match(
        /(?:selected_ad_ids(?:%5B0%5D|\[0\])?|ad_id|adgroup_id)[^0-9]{0,20}([0-9]{5,})/i
      );
      if (match) return match[1];
    }
    return '';
  }

  function scanVisibleRows() {
    for (const row of document.querySelectorAll('[role="row"]')) {
      const text = row.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      if (!text || !isLiveStatus(text)) continue;
      const adId = extractAdId(row);
      if (!adId) continue;
      const cells = [...row.querySelectorAll('[role="gridcell"], [role="cell"]')]
        .map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .filter((value) => value && value.length <= 300);
      const creativeName = cells.find((value) =>
        !LIVE_STATUS.test(value)
        && !/^(on|off|edit|view results)$/i.test(value)
        && !/^\$?[\d,.%]+$/.test(value)
      );
      if (!creativeName) continue;
      mergeCandidate({
        ad_id: adId,
        creative_name: creativeName,
        primary_texts: [],
        delivery_status: LIVE_STATUS.exec(text)?.[0] ?? 'Active',
        campaign_name: '',
        ad_set_name: '',
        media_url: null,
        media_type: 'unknown',
        media_file_name: '',
      });
    }
  }

  function flush() {
    const id = accountId();
    if (!id) return;
    scanVisibleRows();
    const observedAds = [...candidates.values()]
      .filter((candidate) => isKnownStatus(candidate.delivery_status))
      .map((candidate) => ({
        ...candidate,
        is_live: isLiveStatus(candidate.delivery_status),
      }))
      .slice(0, 500);
    if (!observedAds.length) return;
    chrome.runtime.sendMessage({
      type: 'submit-observation',
      payload: {
        account_id: id,
        account_name: accountName(id),
        observation_date: localDate(),
        observed_at: Date.now(),
        source_url: window.location.href,
        ads: observedAds,
      },
    }).catch(() => {});
  }

  window.addEventListener('message', (event) => {
    if (
      event.source !== window
      || event.origin !== window.location.origin
      || event.data?.source !== 'vibe-check-live-scanner'
      || event.data?.type !== 'ads'
      || !Array.isArray(event.data.ads)
    ) {
      return;
    }
    for (const candidate of event.data.ads) mergeCandidate(candidate);
  });

  const observer = new MutationObserver(() => {
    const id = accountId();
    if (id && id !== lastAccountId) {
      lastAccountId = id;
      candidates.clear();
    }
    scheduleFlush(FIRST_SCAN_DELAY_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('focus', () => scheduleFlush(2_000));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleFlush(2_000);
  });
  window.setInterval(flush, RESCAN_INTERVAL_MS);
  scheduleFlush(FIRST_SCAN_DELAY_MS);
})();
