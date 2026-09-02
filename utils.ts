export function normalizeServerUrl(url: string): string {
  let cleaned = (url || '').trim();
  if (!cleaned) return 'ws://localhost:4444';

  // 1. If it has no protocol, prepend 'ws://'
  if (!/^https?:\/\//i.test(cleaned) && !/^wss?:\/\//i.test(cleaned)) {
    cleaned = 'ws://' + cleaned;
  }

  // 2. Map http:// -> ws:// and https:// -> wss://
  if (/^http:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^http:\/\//i, 'ws://');
  } else if (/^https:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^https:\/\//i, 'wss://');
  }

  // 3. Remove trailing slashes and '/sync' path suffix
  cleaned = cleaned.replace(/\/+$/, '');
  cleaned = cleaned.replace(/\/sync\/?$/i, '');
  cleaned = cleaned.replace(/\/+$/, '');

  return cleaned;
}

export function getApiUrl(serverUrl: string, endpoint: string): string {
  const httpUrl = normalizeServerUrl(serverUrl).replace(/^ws/i, 'http');
  return `${httpUrl}/api${endpoint}`;
}
