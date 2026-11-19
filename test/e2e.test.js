import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDir, mjml } from './helpers.js';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

// In-memory fake of the Shablon templates API.
const store = new Map();
const requests = [];
let server;
let apiUrl;

before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== 'Bearer sk.test') return send(403, { delivery: 'failed', reason: 'invalid api key' });

    if (req.method === 'GET' && url.pathname === '/v1/templates') {
      const snippet = url.searchParams.get('snippet') === 'true';
      const data = [...store.values()].filter(
        (t) => t.slug === url.searchParams.get('slug') && Boolean(t.snippet) === snippet,
      );
      return send(200, { data, nextCursor: null, isDone: true });
    }
    if (req.method === 'POST' && url.pathname === '/v1/templates') {
      const id = `id_${store.size + 1}`;
      store.set(id, { id, ...body });
      return send(200, { id, slug: body.slug });
    }
    const m = url.pathname.match(/^\/v1\/templates\/(.+)$/);
    if (m && store.has(m[1])) {
      if (req.method === 'GET') return send(200, store.get(m[1]));
      if (req.method === 'DELETE') {
        store.delete(m[1]);
        return send(200, { id: m[1] });
      }
      if (req.method === 'PATCH') {
        Object.assign(store.get(m[1]), body);
        return send(200, { id: m[1] });
      }
    }
    send(404, { error: 'template not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function runAction(files, inputs = {}) {
  const workspace = await makeDir(files);
  const summaryFile = path.join(workspace, 'summary.md');
  await writeFile(summaryFile, ''); // GitHub pre-creates this file
  const child = spawn(process.execPath, [dist], {
    env: {
      PATH: process.env.PATH,
      GITHUB_WORKSPACE: workspace,
      GITHUB_STEP_SUMMARY: summaryFile,
      INPUT_APIKEY: 'sk.test',
      INPUT_BASEPATH: 'templates',
      INPUT_APIURL: apiUrl,
      INPUT_DRYRUN: 'false',
      ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const status = await new Promise((r) => child.on('close', r));
  const proc = { status, stdout, stderr };
  const summary = await readFile(summaryFile, 'utf8').catch(() => '');
  return { ...proc, summary };
}

test('creates, then leaves unchanged, then updates', async () => {
  const files = {
    'templates/welcome.mjml': mjml('Welcome!'),
    'templates/reset.mjml': mjml(null),
    'templates/reset.yaml': 'name: Reset\nsubject: Reset password\nschema:\n  type: object\n',
  };

  let r = await runAction(files);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /welcome: created/);
  assert.match(r.stdout, /reset: created/);
  assert.match(r.summary, /created/);
  assert.equal(store.size, 2);

  r = await runAction(files);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /welcome: unchanged/);
  assert.match(r.stdout, /reset: unchanged/);

  r = await runAction({ ...files, 'templates/welcome.mjml': mjml('Welcome back!') });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /welcome: updated \(name, subject, markup\)/);
  const patch = requests.filter((q) => q.method === 'PATCH').at(-1);
  assert.deepEqual(Object.keys(patch.body).sort(), ['markup', 'name', 'subject', 'type']);
});

test('slugFrom: path syncs partials as snippets under their include path', async () => {
  const files = {
    'templates/notice.mjml': '<mjml><mj-head><mj-title>Notice</mj-title></mj-head><mj-body><mj-include path="partials/header.mjml" /></mj-body></mjml>\n',
    'templates/partials/header.mjml': '<mj-section><mj-column><mj-text>Header</mj-text></mj-column></mj-section>\n',
    'templates/partials/header.yaml': 'snippet: true\n',
  };

  let r = await runAction(files, { slugFrom: 'path' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /partials\/header: created/);
  const header = [...store.values()].find((t) => t.slug === 'partials/header');
  assert.equal(header.snippet, true);
  assert.equal(header.subject, '');
  assert.equal(header.name, 'partials/header');

  r = await runAction(files, { slugFrom: 'path' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /partials\/header: unchanged/);
});

test('an unknown slugFrom fails before anything is read', async () => {
  const r = await runAction({ 'templates/a.mjml': mjml('A') }, { slugFrom: 'folder' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Invalid `slugFrom` input "folder"/);
});

test('validation errors fail with file annotations and nothing is synced', async () => {
  const before = requests.length;
  const r = await runAction({
    'templates/ok.mjml': mjml('OK'),
    'templates/nosubject.mjml': mjml(null),
    'templates/variant.mjml': mjml('V'),
    'templates/variant.yaml': 'name: V\ndiscriminator: []\n', // API list form is rejected
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error title=Shablon template "nosubject",file=templates\/nosubject\.mjml,line=1::/);
  assert.match(r.stdout, /::error title=Shablon template "variant",file=templates\/variant\.yaml,line=2,col=1::`discriminator` must be a mapping/);
  assert.match(r.stdout, /2 templates are invalid, nothing was synced/);
  assert.match(r.summary, /2 errors/);
  assert.equal(requests.length, before, 'no API requests on validation failure');
});

test('variants: create, edit rules in place, prune removed variant', async () => {
  const files = {
    'templates/promo.yaml': 'subject: Promo\nvariants:\n  de:\n    final: true\n    discriminator: { lang: de }\n  en:\n    discriminator: { lang: en }\n  default: {}\n',
    'templates/promo.de.mjml': mjml('Aktion'),
    'templates/promo.en.mjml': mjml('Promo'),
    'templates/promo.default.mjml': mjml('Promo'),
  };
  const promos = () => [...store.values()].filter((t) => t.slug === 'promo');

  let r = await runAction(files);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /promo\.de: created/);
  assert.match(r.stdout, /promo\.default: created/);
  assert.match(r.stdout, /::warning title=Shablon template "promo",file=templates\/promo\.yaml,line=8,col=3::Variants "en" and "default" can both match/);
  assert.equal(promos().length, 3);
  const deId = promos().find((t) => t.name === 'Promo (de)').id;

  r = await runAction(files);
  assert.equal(r.status, 0, r.stdout);
  assert.equal((r.stdout.match(/: unchanged/g) ?? []).length >= 3, true, r.stdout);

  // Change the rules of "de" (keeps the template, matched by name) and drop "en".
  const edited = {
    ...files,
    'templates/promo.yaml': 'subject: Promo\nvariants:\n  de:\n    final: true\n    discriminator: { lang: [de, at] }\n  default: {}\n',
  };
  delete edited['templates/promo.en.mjml'];
  r = await runAction(edited);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /promo\.de: updated \(discriminator\)/);
  assert.match(r.stdout, /promo#id_\d+: disabled/);
  assert.deepEqual(store.get(deId).discriminator, [{ parameter: 'lang', cmp: 'in', value: ['de', 'at'] }]);
  assert.equal(promos().find((t) => t.name === 'Promo (en)').enabled, false);

  r = await runAction(edited, { prune: 'delete' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /promo#id_\d+: deleted/);
  assert.equal(promos().length, 2);
});

test('invalid prune input fails', async () => {
  const r = await runAction({ 'templates/x.mjml': mjml('X') }, { prune: 'nuke' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Invalid `prune` input "nuke"/);
});

test('invalid api key fails clearly', async () => {
  const r = await runAction({ 'templates/x.mjml': mjml('X') }, { apiKey: 'sk.wrong' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /invalid API key/);
});
