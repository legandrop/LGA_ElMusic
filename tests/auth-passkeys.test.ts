import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { WebContents } from 'electron';
import { conditionalUiScript, installWindowsAuthCompatibility } from '../src/auth-passkeys';

test('public hints alone are changed on exact Apple origins; manual authentication and other capabilities survive', async () => {
  for (const host of ['music.apple.com', 'idmsa.apple.com', 'accounts.apple.com', 'appleid.apple.com', 'evil.test', 'music.apple.com.evil.test']) {
    const conditional = async () => true;
    const create = () => {};
    const get = () => {};
    const Credential = { isConditionalMediationAvailable: conditional,
      getClientCapabilities: async () => ({ conditionalGet: true, hybridTransport: true, passkeyPlatformAuthenticator: false }) };
    const context = { URL, location: { href: `https://${host}/` }, PublicKeyCredential: Credential,
      navigator: { credentials: { get, create } } };
    runInNewContext(conditionalUiScript, context);
    runInNewContext(conditionalUiScript, context);
    const expected = ['music.apple.com', 'idmsa.apple.com', 'accounts.apple.com', 'appleid.apple.com'].includes(host) ? false : true;
    assert.equal(await Credential.isConditionalMediationAvailable(), expected);
    assert.deepEqual({ ...await Credential.getClientCapabilities() }, { conditionalGet: expected, hybridTransport: true, passkeyPlatformAuthenticator: false });
    assert.equal(context.navigator.credentials.get, get); assert.equal(context.navigator.credentials.create, create);
  }
});

test('insecure origins, credentials, ports, suffixes and absent WebAuthn remain untouched', async () => {
  for (const url of ['http://idmsa.apple.com/', 'https://user@idmsa.apple.com/', 'https://idmsa.apple.com:444/',
    'https://idmsa.apple.com./', 'about:blank', 'file:///C:/fixture']) {
    const original = async () => true;
    const Credential = { isConditionalMediationAvailable: original };
    runInNewContext(conditionalUiScript, { URL, location: { href: url }, PublicKeyCredential: Credential });
    assert.equal(Credential.isConditionalMediationAvailable, original);
  }
  runInNewContext(conditionalUiScript, { URL, location: { href: 'https://idmsa.apple.com/' } });
});

function debuggerFixture(failing?: string) {
  const calls: { method: string; parameters: Record<string, unknown>; session?: string }[] = [];
  let attached = false; let destroyed = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: () => { attached = true; }, detach: () => { attached = false; debuggerApi.emit('detach'); }, isAttached: () => attached,
    sendCommand: async (method: string, parameters: Record<string, unknown>, session?: string) => {
      calls.push({ method, parameters, session }); if (method === failing) throw new Error('fixture');
    },
  });
  const events = Object.assign(new EventEmitter(), { debugger: debuggerApi, isDestroyed: () => destroyed });
  return { calls, debuggerApi, contents: events as unknown as WebContents,
    destroy: () => { destroyed = true; events.emit('destroyed'); } };
}

test('document-start root and iframe setup resumes child; destruction releases listeners without a failure', async () => {
  if (process.platform !== 'win32') return;
  const fixture = debuggerFixture(); let failures = 0;
  await installWindowsAuthCompatibility(fixture.contents, () => failures++);
  assert.deepEqual(fixture.calls.map(c => c.method), ['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Target.setAutoAttach']);
  assert.deepEqual(fixture.calls[2].parameters.filter, [{ type: 'page', exclude: true }, { type: 'tab', exclude: true }, { type: 'browser', exclude: true }, { exclude: false }]);
  fixture.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'fixture-child', targetInfo: { type: 'iframe' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.at(-1)?.method, 'Runtime.runIfWaitingForDebugger');
  assert.equal(fixture.calls.at(-1)?.session, 'fixture-child');
  fixture.destroy();
  assert.equal(failures, 0); assert.equal(fixture.debuggerApi.isAttached(), false);
  assert.equal(fixture.debuggerApi.listenerCount('message'), 0);
});

test('root failure rejects and detaches; child failure resumes and reports once; unexpected detach reports once', async () => {
  if (process.platform !== 'win32') return;
  const broken = debuggerFixture('Page.enable');
  await assert.rejects(installWindowsAuthCompatibility(broken.contents, () => {}));
  assert.equal(broken.debuggerApi.isAttached(), false);
  const fixture = debuggerFixture(); let failures = 0;
  await installWindowsAuthCompatibility(fixture.contents, () => failures++);
  fixture.debuggerApi.sendCommand = async (method, parameters, session) => {
    fixture.calls.push({ method, parameters, session });
    if (session && method === 'Page.enable') throw new Error('fixture');
  };
  fixture.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'broken-child', targetInfo: { type: 'iframe' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures, 1); assert.equal(fixture.calls.at(-1)?.method, 'Runtime.runIfWaitingForDebugger');
  fixture.debuggerApi.emit('detach'); assert.equal(failures, 1);
  fixture.destroy();
});

test('workers recurse and resume without Page or script injection; unknown child contexts resume immediately', async () => {
  if (process.platform !== 'win32') return;
  for (const type of ['worker', 'shared_worker', 'service_worker', 'worklet', 'other']) {
    const fixture = debuggerFixture(); let failures = 0;
    await installWindowsAuthCompatibility(fixture.contents, () => failures++);
    const start = fixture.calls.length;
    fixture.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type } });
    await new Promise(resolve => setImmediate(resolve));
    const childCalls = fixture.calls.slice(start).map(call => call.method);
    assert.deepEqual(childCalls, ['worker', 'shared_worker', 'service_worker'].includes(type)
      ? ['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'] : ['Runtime.runIfWaitingForDebugger']);
    assert.equal(failures, 0); fixture.destroy();
  }
});

test('detached child does not report failure or try to resume a vanished session', async () => {
  if (process.platform !== 'win32') return;
  const fixture = debuggerFixture(); let failures = 0;
  await installWindowsAuthCompatibility(fixture.contents, () => failures++);
  let rejectCommand: (reason: Error) => void = () => {};
  fixture.debuggerApi.sendCommand = () => new Promise((_resolve, reject) => { rejectCommand = reject; });
  fixture.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'gone', targetInfo: { type: 'iframe' } });
  fixture.debuggerApi.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'gone' });
  rejectCommand(new Error('closed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures, 0); fixture.destroy();
});
