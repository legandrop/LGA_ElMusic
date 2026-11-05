const appleHosts = new Set(['music.apple.com', 'accounts.apple.com', 'appleid.apple.com', 'idmsa.apple.com']);

export function safeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.username || url.password ? undefined : url;
  } catch { return undefined; }
}

export function isMusicUrl(value: string): boolean {
  const url = safeUrl(value);
  return !!url && url.protocol === 'https:' && !url.port && url.hostname === 'music.apple.com';
}

export function isAllowedNavigation(value: string, lab = false): boolean {
  const url = safeUrl(value);
  return !!url && url.protocol === 'https:' && !url.port &&
    (lab ? url.hostname === 'castlabs.github.io' : appleHosts.has(url.hostname));
}

export function isExternalLink(value: string): boolean {
  const url = safeUrl(value);
  return !!url && ['http:', 'https:'].includes(url.protocol);
}

export function allowedPermission(permission: string, requestingOrigin: string, embeddingOrigin: string, lab = false): boolean {
  if (permission !== 'mediaKeySystem') return false;
  const permitted = (value: string): boolean => lab
    ? isAllowedNavigation(value, true)
    : isMusicUrl(value);
  return permitted(requestingOrigin) && permitted(embeddingOrigin);
}

export function trustedLocalRequest(senderId: number, frameIsMain: boolean, frameUrl: string,
  expectedSenderId: number, expectedUrl: string, args: unknown[]): boolean {
  return senderId === expectedSenderId && frameIsMain && frameUrl === expectedUrl && args.length === 0;
}

export function trustedRecommendationSettingsRequest(senderId: number, frameIsMain: boolean, frameUrl: string,
  expectedSenderId: number, expectedUrl: string, args: unknown[], action: 'set-key' | 'set-artist-color' | 'open-setup' | 'close'): boolean {
  if (!trustedLocalRequest(senderId, frameIsMain, frameUrl, expectedSenderId, expectedUrl, [])) return false;
  try {
    const url = new URL(expectedUrl);
    if (url.protocol !== 'file:' || url.hash || url.searchParams.size !== 1 || url.searchParams.get('state') !== 'recommendation-settings') return false;
  } catch { return false; }
  if (action === 'set-artist-color') return args.length === 1 && typeof args[0] === 'string' && /^#[0-9a-f]{6}$/i.test(args[0]);
  return action !== 'set-key' ? args.length === 0 : args.length === 1 && typeof args[0] === 'string' && (args[0] === '' || /^[a-f\d]{32}$/i.test(args[0]));
}

export function sanitizedHost(value: string): string {
  return safeUrl(value)?.hostname ?? 'invalid-url';
}
