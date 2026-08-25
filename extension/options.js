const DEFAULT_CONFIG = {
  enabled: true,
  serverUrl: 'https://admin.adchecked.com',
  appPassword: '',
};
const LEGACY_SERVER_ORIGIN = 'https://vibe-check.thatcanadian.dev';
const form = document.querySelector('#settings-form');
const enabled = document.querySelector('#enabled');
const serverUrl = document.querySelector('#server-url');
const appPassword = document.querySelector('#app-password');
const saved = document.querySelector('#saved');

chrome.storage.local.get(DEFAULT_CONFIG).then((value) => {
  enabled.checked = value.enabled !== false;
  serverUrl.value = value.serverUrl === LEGACY_SERVER_ORIGIN
    ? DEFAULT_CONFIG.serverUrl
    : value.serverUrl;
  appPassword.value = value.appPassword;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const parsed = new URL(serverUrl.value.trim());
  if (
    parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')
  ) {
    saved.textContent = 'Use an HTTPS URL.';
    return;
  }
  await chrome.storage.local.set({
    enabled: enabled.checked,
    serverUrl: parsed.origin,
    appPassword: appPassword.value.trim(),
  });
  saved.textContent = 'Saved';
  window.setTimeout(() => {
    saved.textContent = '';
  }, 2_000);
});
