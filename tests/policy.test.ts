import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedNavigation, isExternalLink, isMusicUrl, allowedPermission, trustedLocalRequest, sanitizedHost } from '../src/policy';

test('Apple navigation accepts only exact HTTPS origins', () => {
  for (const url of ['https://music.apple.com/ar/new', 'https://accounts.apple.com/auth', 'https://appleid.apple.com/', 'https://idmsa.apple.com/']) {
    assert.equal(isAllowedNavigation(url), true, url);
  }
  for (const url of ['http://music.apple.com/', 'https://music.apple.com.evil.test/', 'https://evil.test/?next=https://music.apple.com',
    'https://music.apple.com:8443/', 'https://user@music.apple.com/', 'file:///C:/secret', 'javascript:alert(1)',
    'https://apple.com/', 'https://amp-api.music.apple.com/', 'https://music.apple.com./', 'https://castlabs.github.io/']) {
    assert.equal(isAllowedNavigation(url), false, url);
  }
  assert.equal(isMusicUrl('https://accounts.apple.com/'), false);
});

test('DRM lab is isolated from production origins', () => {
  assert.equal(isAllowedNavigation('https://castlabs.github.io/drm-test/', true), true);
  assert.equal(isAllowedNavigation('https://music.apple.com/', true), false);
  assert.equal(allowedPermission('mediaKeySystem', 'https://castlabs.github.io', 'https://castlabs.github.io', true), true);
  assert.equal(allowedPermission('mediaKeySystem', 'https://castlabs.github.io', 'https://castlabs.github.io'), false);
});

test('permissions default to deny and verify requester and embedding origin', () => {
  assert.equal(allowedPermission('mediaKeySystem', 'https://music.apple.com', 'https://music.apple.com/ar/new'), true);
  for (const permission of ['media', 'notifications', 'storage-access', 'top-level-storage-access', 'clipboard-read', 'fileSystem', 'geolocation', 'usb', 'hid', 'unknown']) {
    assert.equal(allowedPermission(permission, 'https://music.apple.com', 'https://music.apple.com'), false);
  }
  assert.equal(allowedPermission('mediaKeySystem', 'https://evil.test', 'https://music.apple.com'), false);
  assert.equal(allowedPermission('mediaKeySystem', 'https://music.apple.com', 'https://evil.test'), false);
  assert.equal(allowedPermission('mediaKeySystem', 'https://music.apple.com', ''), false);
});

test('external links cannot invoke local protocols or embedded credentials', () => {
  assert.equal(isExternalLink('https://support.apple.com/'), true);
  assert.equal(isExternalLink('http://example.com/'), true);
  for (const value of ['file:///secret', 'ms-settings:', 'mailto:a@b.test', 'javascript:alert(1)', 'https://user:pass@example.com/', 'invalid']) {
    assert.equal(isExternalLink(value), false);
  }
});

test('local IPC requires the exact trusted main frame and no supplied arguments', () => {
  const expected = 'file:///app/ui/index.html?state=about';
  assert.equal(trustedLocalRequest(2, true, expected, 2, expected, []), true);
  assert.equal(trustedLocalRequest(3, true, expected, 2, expected, []), false);
  assert.equal(trustedLocalRequest(2, false, expected, 2, expected, []), false);
  assert.equal(trustedLocalRequest(2, true, 'https://music.apple.com/', 2, expected, []), false);
  assert.equal(trustedLocalRequest(2, true, `${expected}#spoof`, 2, expected, []), false);
  assert.equal(trustedLocalRequest(2, true, expected, 2, expected, ['C:/secret']), false);
});

test('navigation diagnostics discard query, path and credentials', () => {
  assert.equal(sanitizedHost('https://music.apple.com/login?token=secret'), 'music.apple.com');
  assert.equal(sanitizedHost('https://secret:token@music.apple.com/'), 'invalid-url');
});
