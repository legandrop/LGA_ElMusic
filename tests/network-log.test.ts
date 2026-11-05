import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from 'electron';
import { describeFailure, firewallNoticeScript, installNetworkFailureLog } from '../src/network-log';

test('una conexión bloqueada a Apple registra servidor, recurso y código, sin la dirección', () => {
  const fields = describeFailure('https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquire?token=secreto', 'net::ERR_NETWORK_ACCESS_DENIED', 'xhr');
  assert.deepEqual(fields, { servidor: 'play.itunes.apple.com', recurso: 'xhr', código: 'ERR_NETWORK_ACCESS_DENIED' });
  assert.ok(!JSON.stringify(fields).includes('secreto'));
});

test('un servidor ajeno a Apple y Google queda como «otro»', () => {
  assert.equal(describeFailure('https://tracker.example.net/x', 'net::ERR_CONNECTION_RESET', 'script')?.servidor, 'otro');
  assert.equal(describeFailure('https://apple.com.example.net/x', 'net::ERR_CONNECTION_RESET', 'script')?.servidor, 'otro');
});

test('cancelaciones, códigos raros y direcciones que no son https no se registran', () => {
  assert.equal(describeFailure('https://music.apple.com/ar/new', 'net::ERR_ABORTED', 'xhr'), undefined);
  assert.equal(describeFailure('https://music.apple.com/ar/new', 'algo raro', 'xhr'), undefined);
  assert.equal(describeFailure('http://music.apple.com/ar/new', 'net::ERR_CONNECTION_RESET', 'xhr'), undefined);
  assert.equal(describeFailure('no es una dirección', 'net::ERR_CONNECTION_RESET', 'xhr'), undefined);
});

test('la misma falla se registra una vez cada 10 s y como mucho 60 por hora', () => {
  let listener: ((details: { url: string; error: string; resourceType: string }) => void) | undefined;
  const session = { webRequest: { onErrorOccurred: (callback: typeof listener) => { listener = callback; } } } as unknown as Session;
  const logged: Array<Record<string, string>> = []; let time = 0;
  installNetworkFailureLog(session, (_event, fields) => logged.push(fields), { now: () => time });
  const fail = (host: string): void => listener!({ url: `https://${host}/a`, error: 'net::ERR_NETWORK_ACCESS_DENIED', resourceType: 'media' });
  fail('aod.itunes.apple.com'); fail('aod.itunes.apple.com');
  assert.equal(logged.length, 1);
  time = 10_001; fail('aod.itunes.apple.com');
  assert.equal(logged.length, 2);
  for (let index = 0; index < 100; index++) fail(`s${index}.mzstatic.com`);
  assert.equal(logged.length, 60);
  time = 3_700_000; fail('aod.itunes.apple.com');
  assert.equal(logged.length, 61);
});

test('un bloqueo de firewall hacia Apple avisa al usuario, como mucho una vez por minuto; otros errores y servidores no', () => {
  let listener: ((details: { url: string; error: string; resourceType: string }) => void) | undefined;
  const session = { webRequest: { onErrorOccurred: (callback: typeof listener) => { listener = callback; } } } as unknown as Session;
  let notices = 0; let time = 0;
  installNetworkFailureLog(session, () => {}, { onFirewallBlock: () => { notices++; }, now: () => time });
  const fail = (host: string, error: string): void => listener!({ url: `https://${host}/a`, error, resourceType: 'xhr' });
  fail('play.itunes.apple.com', 'net::ERR_CONNECTION_RESET');
  fail('tracker.example.net', 'net::ERR_NETWORK_ACCESS_DENIED');
  assert.equal(notices, 0);
  fail('play.itunes.apple.com', 'net::ERR_NETWORK_ACCESS_DENIED');
  time = 30_000; fail('aod.itunes.apple.com', 'net::ERR_NETWORK_ACCESS_DENIED');
  assert.equal(notices, 1);
  time = 60_000; fail('aod.itunes.apple.com', 'net::ERR_NETWORK_ACCESS_DENIED');
  assert.equal(notices, 2);
});

test('el aviso de firewall sólo corre en la página musical y escribe texto, no HTML', () => {
  const script = firewallNoticeScript();
  assert.match(script, /location\.hostname !== 'music\.apple\.com'/);
  assert.match(script, /Your firewall blocked El Music/);
  assert.match(script, /El Music › Retry loading/);
  assert.doesNotMatch(script, /innerHTML/);
});