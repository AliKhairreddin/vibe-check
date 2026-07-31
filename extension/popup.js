const statusElement = document.querySelector('#status');
const detailsElement = document.querySelector('#details');
const errorElement = document.querySelector('#error');

chrome.storage.local.get({
  enabled: true,
  lastAccountName: '',
  lastObservedAt: 0,
  lastResult: null,
  lastError: '',
}).then((value) => {
  if (!value.enabled) {
    statusElement.textContent = 'Scanner disabled';
    detailsElement.textContent = 'Enable automatic scanning in Settings.';
  } else if (value.lastObservedAt) {
    statusElement.textContent = value.lastAccountName || 'Meta ad account observed';
    const time = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value.lastObservedAt));
    const result = value.lastResult;
    detailsElement.textContent = result
      ? `${result.liveAds} live ads · ${result.uniqueCreatives} creatives · ${result.copyVariants} primary texts · ${time}`
      : `Last observed ${time}`;
  }
  if (value.lastError) {
    errorElement.hidden = false;
    errorElement.textContent = value.lastError;
  }
});

document.querySelector('#settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
