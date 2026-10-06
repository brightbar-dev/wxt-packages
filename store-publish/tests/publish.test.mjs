// amo-publish.sh and edge-publish.sh are the only code that talks to AMO and Edge Add-ons, and
// nothing runs them before a release is cut. These tests run the real scripts against a stub `curl`
// so every branch (dry run, update, first submission, draft-only, each failure) runs in CI.
// Run: node --test store-publish/tests/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const AMO = resolve(here, '../bin/amo-publish.sh');
const EDGE = resolve(here, '../bin/edge-publish.sh');
const GUID = 'ext@brightbar.dev';
const JWT_SECRET = 'AMO-SECRET-VALUE-XYZ';
const EDGE_KEY = 'EDGE-API-KEY-XYZ';
const PRODUCT = '00000000-1111-2222-3333-444444444444';

// A stand-in for curl. Logs each request; answers from a route table (first route whose method
// matches and whose `match` regex hits the URL), taking responses in order and repeating the last.
// Writes a Location header to the -D file when the response has one.
const STUB = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a));
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
const after = (flag) => args.filter((a, n) => args[n - 1] === flag);
const routes = JSON.parse(fs.readFileSync(process.env.STUB_ROUTES, 'utf8'));
const state = fs.existsSync(process.env.STUB_STATE) ? JSON.parse(fs.readFileSync(process.env.STUB_STATE, 'utf8')) : {};
const i = routes.findIndex((r) => (r.method ?? 'GET') === method && new RegExp(r.match).test(url));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({
  url, method, headers: after('-H'), forms: after('-F'), body: after('-d')[0], file: after('-T')[0],
}) + '\\n');
const r = i < 0 ? { code: 599, body: { message: 'no stub route' } }
  : routes[i].responses[Math.min(state[i] ?? 0, routes[i].responses.length - 1)];
if (i >= 0) { state[i] = (state[i] ?? 0) + 1; fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state)); }
const d = after('-D')[0];
if (d) fs.writeFileSync(d, 'HTTP/1.1 ' + r.code + '\\r\\n' + (r.location ? 'Location: ' + r.location + '\\r\\n' : '') + '\\r\\n');
process.stdout.write(JSON.stringify(r.body) + '\\n' + r.code);
`;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-publish-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/curl'), STUB);
  chmodSync(join(dir, 'bin/curl'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A real zip with the given manifest, built with the system zip.
function pack(name, manifest) {
  const src = join(dir, 'pkg-' + name);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'manifest.json'), JSON.stringify(manifest));
  mkdirSync(join(dir, 'work/.output'), { recursive: true });
  const out = join(dir, 'work/.output', name);
  const r = spawnSync('zip', ['-qj', out, join(src, 'manifest.json')]);
  assert.equal(r.status, 0, 'zip is needed to run these tests');
}

const FIREFOX = {
  manifest_version: 2, version: '1.2.3',
  browser_specific_settings: { gecko: { id: GUID, data_collection_permissions: { required: ['none'] } } },
};
const CHROME = { manifest_version: 3, version: '1.2.3' };

function run(script, routes, env = {}) {
  writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes));
  rmSync(join(dir, 'state.json'), { force: true });
  rmSync(join(dir, 'calls.log'), { force: true });
  const r = spawnSync('bash', [script], {
    cwd: join(dir, 'work'),
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      HOME: dir,
      STUB_ROUTES: join(dir, 'routes.json'),
      STUB_STATE: join(dir, 'state.json'),
      STUB_LOG: join(dir, 'calls.log'),
      AMO_JWT_ISSUER: 'user:123:45', AMO_JWT_SECRET: JWT_SECRET, AMO_POLL_SECONDS: '0',
      EDGE_CLIENT_ID: 'client-id', EDGE_API_KEY: EDGE_KEY, EDGE_PRODUCT_ID: PRODUCT, EDGE_POLL_SECONDS: '0',
      ...env,
    },
  });
  const calls = existsSync(join(dir, 'calls.log'))
    ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { ...r, calls, out: r.stdout + r.stderr };
}

// ---------- AMO ----------

const amoPackages = (manifest = FIREFOX) => {
  pack('ext-1.2.3-firefox.zip', manifest);
  pack('ext-1.2.3-sources.zip', { sources: true });
};
const uploaded = { method: 'POST', match: '/addons/upload/$', responses: [{ code: 201, body: { uuid: 'u1', processed: false } }] };
const validated = { match: '/addons/upload/u1/$', responses: [{ code: 200, body: { uuid: 'u1', processed: true, valid: true, validation: { warnings: 2 } } }] };
const exists = { match: `/addons/addon/${GUID}/$`, responses: [{ code: 200, body: { id: 9 } }] };
const versioned = { method: 'POST', match: `/addons/addon/${GUID}/versions/$`, responses: [{ code: 201, body: { id: 77, file: { status: 'unreviewed' } } }] };

test('AMO dry run checks the packages and touches no network or credential', () => {
  amoPackages();
  const r = run(AMO, [], { AMO_BUILD_ONLY: 'true', AMO_JWT_ISSUER: '', AMO_JWT_SECRET: '' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /AMO_BUILD_ONLY=true/);
  assert.equal(r.calls.length, 0);
});

test('AMO refuses a package with no gecko id, even in a dry run', () => {
  amoPackages({ manifest_version: 2, version: '1.2.3' });
  const r = run(AMO, [], { AMO_BUILD_ONLY: 'true' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /gecko\.id/);
});

test('AMO refuses a package without data_collection_permissions', () => {
  amoPackages({ manifest_version: 2, version: '1.2.3', browser_specific_settings: { gecko: { id: GUID } } });
  const r = run(AMO, [], { AMO_BUILD_ONLY: 'true' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /data_collection_permissions/);
});

test('AMO refuses a name over 50 characters in any locale, even in a dry run', () => {
  pack('ext-1.2.3-firefox.zip', { ...FIREFOX, name: '__MSG_appName__', description: 'Short.' });
  pack('ext-1.2.3-sources.zip', { sources: true });
  for (const [loc, name] of [['en', 'Fine name'], ['de', 'D'.repeat(51)]]) {
    mkdirSync(join(dir, `loc/_locales/${loc}`), { recursive: true });
    writeFileSync(join(dir, `loc/_locales/${loc}/messages.json`), JSON.stringify({ AppName: { message: name } }));
    spawnSync('zip', ['-q', join(dir, 'work/.output/ext-1.2.3-firefox.zip'), `_locales/${loc}/messages.json`], { cwd: join(dir, 'loc') });
  }
  const r = run(AMO, [], { AMO_BUILD_ONLY: 'true' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /name \(_locales\/de\/messages\.json, 51 > 50\)/);
  assert.ok(!r.stderr.includes('_locales/en/'), 'a locale within the limit is not reported');
});

test('AMO refuses a literal description over 250 characters', () => {
  amoPackages({ ...FIREFOX, name: 'Ok', description: 'x'.repeat(251) });
  const r = run(AMO, [], { AMO_BUILD_ONLY: 'true' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /description \(251 > 250\)/);
});

test('AMO update: upload, wait for validation, create a version with the sources attached', () => {
  amoPackages();
  const r = run(AMO, [uploaded, validated, exists, versioned]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.calls.map((c) => c.method + ' ' + new URL(c.url).pathname), [
    'POST /api/v5/addons/upload/',
    'GET /api/v5/addons/upload/u1/',
    `GET /api/v5/addons/addon/${GUID}/`,
    `POST /api/v5/addons/addon/${GUID}/versions/`,
  ]);
  assert.deepEqual(r.calls[0].forms, ['upload=@.output/ext-1.2.3-firefox.zip', 'channel=listed']);
  assert.deepEqual(r.calls[3].forms, ['upload=u1', 'source=@.output/ext-1.2.3-sources.zip']);
  assert.match(r.stdout, /Submitted: ext@brightbar.dev 1.2.3 as version 77 \(listed\), file status unreviewed/);
  assert.ok(!r.out.includes(JWT_SECRET), 'the secret is never printed');
});

test('AMO signs every request with a fresh, valid HS256 JWT', () => {
  amoPackages();
  const r = run(AMO, [uploaded, validated, exists, versioned]);
  assert.equal(r.status, 0, r.out);
  const jtis = new Set();
  for (const c of r.calls) {
    const h = c.headers.find((x) => x.startsWith('Authorization: JWT '));
    assert.ok(h, 'every call is authenticated');
    assert.ok(!c.headers.join(' ').includes(JWT_SECRET));
    const [head, body, sig] = h.slice('Authorization: JWT '.length).split('.');
    assert.equal(sig, createHmac('sha256', JWT_SECRET).update(head + '.' + body).digest('base64url'));
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    assert.equal(claims.iss, 'user:123:45');
    assert.ok(claims.exp - claims.iat <= 300, 'AMO allows at most five minutes');
    jtis.add(claims.jti);
  }
  assert.equal(jtis.size, r.calls.length, 'a jti is never reused');
});

test('AMO fails loudly when validation fails, and prints the errors', () => {
  amoPackages();
  const invalid = { ...validated, responses: [{ code: 200, body: { processed: true, valid: false, validation: { errors: 1, messages: [{ type: 'error', message: 'Bad thing', file: 'a.js' }] } } }] };
  const r = run(AMO, [uploaded, invalid]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /error: Bad thing a\.js/);
  assert.match(r.stderr, /validation failed/);
});

test('AMO first submission creates the add-on from store/amo.json, then attaches the sources', () => {
  amoPackages();
  mkdirSync(join(dir, 'work/store'), { recursive: true });
  writeFileSync(join(dir, 'work/store/amo.json'), JSON.stringify({
    categories: { firefox: ['developer-tools'] }, summary: { 'en-US': 'Short.' }, version: { license: 'MIT' },
  }));
  const r = run(AMO, [
    uploaded, validated,
    { match: `/addons/addon/${GUID}/$`, responses: [{ code: 404, body: { detail: 'Not found.' } }] },
    { method: 'POST', match: '/addons/addon/$', responses: [{ code: 201, body: { id: 9, current_version: { id: 55 } } }] },
    { method: 'PATCH', match: `/addons/addon/${GUID}/versions/55/$`, responses: [{ code: 200, body: { id: 55, file: { status: 'unreviewed' } } }] },
  ]);
  assert.equal(r.status, 0, r.out);
  const create = r.calls.find((c) => c.method === 'POST' && c.url.endsWith('/addons/addon/'));
  assert.deepEqual(JSON.parse(create.body), {
    categories: { firefox: ['developer-tools'] }, summary: { 'en-US': 'Short.' }, version: { license: 'MIT', upload: 'u1' },
  });
  assert.deepEqual(r.calls.at(-1).forms, ['source=@.output/ext-1.2.3-sources.zip']);
  assert.match(r.stdout, /as version 55/);
});

test('AMO first submission without store/amo.json fails before creating anything', () => {
  amoPackages();
  const r = run(AMO, [uploaded, validated, { match: `/addons/addon/${GUID}/$`, responses: [{ code: 404, body: {} }] }]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no store\/amo\.json/);
  assert.ok(!r.calls.some((c) => c.method === 'POST' && c.url.endsWith('/addons/addon/')));
});

test('AMO surfaces the API message when the version is refused', () => {
  amoPackages();
  const r = run(AMO, [uploaded, validated, exists, { ...versioned, responses: [{ code: 400, body: { version: ['Version 1.2.3 already exists.'] } }] }]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HTTP 400.*already exists/);
});

// ---------- Edge ----------

const up = { method: 'POST', match: '/submissions/draft/package$', responses: [{ code: 202, body: {}, location: 'op-up' }] };
const upDone = { match: '/draft/package/operations/op-up$', responses: [
  { code: 200, body: { status: 'InProgress' } },
  { code: 200, body: { status: 'Succeeded', message: 'Successfully updated package to ext.zip' } },
] };
const pub = { method: 'POST', match: '/submissions$', responses: [{ code: 202, body: {}, location: 'op-pub' }] };
const pubDone = { match: '/submissions/operations/op-pub$', responses: [{ code: 200, body: { status: 'Succeeded', message: 'Successfully created submission with ID s1' } }] };

test('Edge dry run checks the package and touches no network or credential', () => {
  pack('ext-1.2.3-chrome.zip', CHROME);
  const r = run(EDGE, [], { EDGE_BUILD_ONLY: 'true', EDGE_API_KEY: '', EDGE_CLIENT_ID: '', EDGE_PRODUCT_ID: '' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /EDGE_BUILD_ONLY=true/);
  assert.equal(r.calls.length, 0);
});

test('Edge refuses an MV2 package', () => {
  pack('ext-1.2.3-chrome.zip', { manifest_version: 2, version: '1.2.3' });
  const r = run(EDGE, [], { EDGE_BUILD_ONLY: 'true' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MV3/);
});

test('Edge uploads, waits for the upload, submits, waits for the submission', () => {
  pack('ext-1.2.3-chrome.zip', CHROME);
  const r = run(EDGE, [up, upDone, pub, pubDone], { GITHUB_REPOSITORY: 'brightbar-dev/ext' });
  assert.equal(r.status, 0, r.out);
  const base = `/v1/products/${PRODUCT}/submissions`;
  assert.deepEqual(r.calls.map((c) => c.method + ' ' + new URL(c.url).pathname), [
    `POST ${base}/draft/package`,
    `GET ${base}/draft/package/operations/op-up`,
    `GET ${base}/draft/package/operations/op-up`,
    `POST ${base}`,
    `GET ${base}/operations/op-pub`,
  ]);
  assert.equal(r.calls[0].file, '.output/ext-1.2.3-chrome.zip');
  for (const c of r.calls) {
    assert.ok(c.headers.includes(`Authorization: ApiKey ${EDGE_KEY}`));
    assert.ok(c.headers.includes('X-ClientID: client-id'));
  }
  assert.ok(r.calls[0].headers.includes('Content-Type: application/zip'));
  assert.match(JSON.parse(r.calls[3].body).notes, /Version 1\.2\.3, built from https:\/\/github\.com\/brightbar-dev\/ext/);
  assert.match(r.stdout, /Publish: Succeeded \(1\.2\.3\)/);
  assert.ok(!r.stdout.includes(EDGE_KEY), 'the key is never printed');
});

test('Edge with EDGE_AUTO_PUBLISH=false uploads to the draft and stops', () => {
  pack('ext-1.2.3-chrome.zip', CHROME);
  const r = run(EDGE, [up, upDone, pub, pubDone], { EDGE_AUTO_PUBLISH: 'false' });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.calls.some((c) => c.method === 'POST' && c.url.endsWith('/submissions')));
  assert.match(r.stdout, /NOT submitted/);
});

test('Edge fails with the store reason when a previous submission is still in review', () => {
  pack('ext-1.2.3-chrome.zip', CHROME);
  const busy = { ...pubDone, responses: [{ code: 200, body: { status: 'Failed', errorCode: 'InProgressSubmission', message: "Can't publish extension as your extension submission is in progress." } }] };
  const r = run(EDGE, [up, upDone, pub, busy]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /publish Failed: .*in progress.*InProgressSubmission/);
});

test('Edge fails when the upload fails, and never submits', () => {
  pack('ext-1.2.3-chrome.zip', CHROME);
  const bad = { ...upDone, responses: [{ code: 200, body: { status: 'Failed', errorCode: 'InvalidPackage', message: 'Bad zip', errors: ['manifest.json missing'] } }] };
  const r = run(EDGE, [up, bad, pub, pubDone]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /upload Failed: Bad zip \| InvalidPackage \| manifest\.json missing/);
  assert.ok(!r.calls.some((c) => c.method === 'POST' && c.url.endsWith('/submissions')));
});

test('Edge reports a refused API key', () => {
  pack('ext-1.2.3-chrome.zip', CHROME);
  const r = run(EDGE, [{ ...up, responses: [{ code: 401, body: { message: 'Unauthorized' } }] }]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /upload rejected \(HTTP 401\): Unauthorized/);
});
