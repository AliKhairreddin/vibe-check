/** Exact browser origins only; HTTP is reserved for loopback development. */
export function normalizeAllowedOrigins(values: string[]): string[] {
  if (values.length > 20) throw new Error('Use at most 20 allowed website origins.');
  return [...new Set(values.map(value => {
    const input = value.trim();
    if (!input || input.length > 300 || /[\s\\*@]/.test(input) || !/^https?:\/\/[^/?#]+\/?$/i.test(input)) throw new Error('Invalid website origin.');
    let url: URL;
    try { url = new URL(input); } catch { throw new Error('Enter a full website origin, such as https://example.com.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || /[?#]/.test(input) || url.port === '0') {
      throw new Error('Use HTTPS (or HTTP on localhost), without a path, query, credentials, or wildcard.');
    }
    return url.origin;
  }))].sort();
}
