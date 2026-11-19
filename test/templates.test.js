import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTemplates, extractSubject } from '../src/templates.js';
import { makeDir, mjml } from './helpers.js';

test('extractSubject reads mj-title and decodes entities', () => {
  assert.equal(extractSubject(mjml('Welcome &amp; hello, {{name}}!')), 'Welcome & hello, {{name}}!');
  assert.equal(extractSubject(mjml(null)), null);
  assert.equal(extractSubject('<mjml><!-- <mj-title>x</mj-title> --></mjml>'), null);
});

test('extractSubject accepts closing tags wrapped the way Prettier writes them', () => {
  const markup = '<mjml>\n  <mj-head>\n    <mj-title\n      >Hi {{ name }}\n      there</mj-title\n    >\n  </mj-head\n  >\n</mjml>\n';
  assert.equal(extractSubject(markup), 'Hi {{ name }} there');
});

test('mjml without yaml uses mj-title as subject and name', async () => {
  const dir = await makeDir({ 'welcome.mjml': mjml('Welcome!') });
  const { templates, errors } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].slug, 'welcome');
  assert.equal(templates[0].payload.name, 'Welcome!');
  assert.equal(templates[0].payload.subject, 'Welcome!');
  assert.equal(templates[0].payload.type, 'mjml');
});

test('mjml without yaml and without mj-title fails clearly', async () => {
  const dir = await makeDir({ 'welcome.mjml': mjml(null) });
  const { templates, errors } = await loadTemplates(dir);
  assert.equal(templates.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no subject and no name/);
  assert.match(errors[0].message, /welcome\.yaml/);
  assert.match(errors[0].file, /welcome\.mjml$/);
});

test('yaml fields are applied and schema is serialised', async () => {
  const dir = await makeDir({
    'emails/reset.mjml': mjml('ignored'),
    'emails/reset.yaml': `name: Password reset
subject: Reset your password
enabled: false
final: true
group: grp_123
snippet: false
schema:
  type: object
  properties:
    name: { type: string }
  required: [name]
`,
  });
  const { templates, errors } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  const { payload } = templates[0];
  assert.equal(payload.name, 'Password reset');
  assert.equal(payload.subject, 'Reset your password');
  assert.equal(payload.enabled, false);
  assert.equal(payload.final, true);
  assert.equal(payload.group, 'grp_123');
  assert.equal(payload.snippet, false);
  assert.deepEqual(JSON.parse(payload.schema), {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  });
});

test('schema given as JSON string is accepted', async () => {
  const dir = await makeDir({
    'a.mjml': mjml('A'),
    'a.yml': `schema: '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}'\n`,
  });
  const { templates, errors } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  assert.equal(JSON.parse(templates[0].payload.schema).type, 'object');
});

const invalid = [
  ['discriminator in API form', 'discriminator:\n  - { parameter: lang, cmp: eq, value: de }\n', /not the API's list of rules/],
  ['discriminator bad operator', 'discriminator:\n  lang: { like: de }\n', /Unknown operator `like`/],
  ['discriminator boolean', 'discriminator:\n  vip: true\n', /cannot compare booleans/],
  ['discriminator number in list', 'discriminator:\n  plan: [1, 2]\n', /only supports strings/],
  ['discriminator empty', 'discriminator: {}\n', /non-empty mapping/],
  ['invalid schema', 'schema:\n  type: banana\n', /not a valid JSON schema/],
  ['schema not JSON', 'schema: "{nope"\n', /not valid JSON/],
  ['unknown field', 'subject: x\nfoo: bar\n', /Unknown field `foo`/],
  ['wrong type', 'enabled: "yes"\n', /`enabled` must be `true` or `false`/],
  ['raw type', 'type: raw\n', /Only "mjml"/],
  ['slug', 'slug: other\n', /derived from the file name/],
  ['broken yaml', 'name: [unclosed\n', /Invalid YAML/],
];

for (const [label, yaml, expected] of invalid) {
  test(`rejects ${label}`, async () => {
    const dir = await makeDir({ 't.mjml': mjml('T'), 't.yaml': yaml });
    const { templates, errors } = await loadTemplates(dir);
    assert.equal(templates.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, expected);
    assert.match(errors[0].file, /t\.yaml$/);
    assert.ok(errors[0].line >= 1);
  });
}

test('reports line of offending key', async () => {
  const dir = await makeDir({ 't.mjml': mjml('T'), 't.yaml': 'name: ok\n\ndiscriminator: []\n' });
  const { errors } = await loadTemplates(dir);
  assert.equal(errors[0].line, 3);
});

test('yaml without mjml and duplicate slugs are errors', async () => {
  const dir = await makeDir({
    'orphan.yaml': 'name: x\n',
    'a/dup.mjml': mjml('A'),
    'b/dup.mjml': mjml('B'),
  });
  const { errors } = await loadTemplates(dir);
  const messages = errors.map((e) => e.message).join('\n');
  assert.match(messages, /no matching `orphan\.mjml`/);
  assert.match(messages, /Duplicate template slug "dup"/);
});

test('missing basePath throws', async () => {
  await assert.rejects(loadTemplates('/does/not/exist'), /does not exist/);
});

test('discriminator on a single template is turned into API rules', async () => {
  const dir = await makeDir({
    'w.mjml': mjml('W'),
    'w.yaml': 'discriminator:\n  lang: de\n  plan: [pro, business]\n  age: { gte: 18, lt: 65 }\n  country: { not_in: [AT] }\n',
  });
  const { templates, errors } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(templates[0].payload.discriminator, [
    { parameter: 'lang', cmp: 'eq', value: 'de' },
    { parameter: 'plan', cmp: 'in', value: ['pro', 'business'] },
    { parameter: 'age', cmp: 'gte', value: 18 },
    { parameter: 'age', cmp: 'lt', value: 65 },
    { parameter: 'country', cmp: 'not_in', value: ['AT'] },
  ]);
});

test('single template without discriminator does not send one', async () => {
  const dir = await makeDir({ 'w.mjml': mjml('W') });
  const { templates } = await loadTemplates(dir);
  assert.ok(!('discriminator' in templates[0].payload));
});

const variantYaml = `name: Welcome
group: grp_1
enabled: true
schema:
  type: object
  properties:
    lang: { type: string }
variants:
  de:
    final: true
    discriminator:
      lang: de
  en:
    name: English welcome
    subject: Welcome!
    enabled: false
    discriminator:
      lang: [en, en-GB]
  default:
`;

test('variant set: one entry per variant, shared fields inherited', async () => {
  const dir = await makeDir({
    'mails/welcome.yaml': variantYaml,
    'mails/welcome.de.mjml': mjml('Willkommen'),
    'mails/welcome.en.mjml': mjml('ignored'),
    'mails/welcome.default.mjml': mjml('Hello'),
  });
  const { templates, errors, warnings } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(templates.length, 1);
  const [set] = templates;
  assert.equal(set.slug, 'welcome');
  assert.match(set.configFile, /welcome\.yaml$/);
  assert.deepEqual(set.variants.map((v) => v.label), ['welcome.de', 'welcome.en', 'welcome.default']);

  const [de, en, def] = set.variants.map((v) => v.payload);
  assert.equal(de.name, 'Welcome (de)');
  assert.equal(de.subject, 'Willkommen');
  assert.equal(de.final, true);
  assert.equal(de.group, 'grp_1');
  assert.equal(de.enabled, true);
  assert.equal(JSON.parse(de.schema).type, 'object');
  assert.deepEqual(de.discriminator, [{ parameter: 'lang', cmp: 'eq', value: 'de' }]);

  assert.equal(en.name, 'English welcome');
  assert.equal(en.subject, 'Welcome!');
  assert.equal(en.enabled, false);
  assert.deepEqual(en.discriminator, [{ parameter: 'lang', cmp: 'in', value: ['en', 'en-GB'] }]);

  assert.equal(def.name, 'Welcome (default)');
  assert.deepEqual(def.discriminator, []);
  assert.equal(def.final, undefined);
});

const variantErrors = [
  [
    'plain mjml next to variants',
    { 'w.yaml': 'variants:\n  a: {}\n', 'w.a.mjml': mjml('A'), 'w.mjml': mjml('W') },
    /would not be used/,
    /w\.mjml$/,
  ],
  ['undeclared variant file', { 'w.yaml': 'variants:\n  a: {}\n', 'w.a.mjml': mjml('A'), 'w.b.mjml': mjml('B') }, /`w\.b\.mjml` is not declared/, /w\.b\.mjml$/],
  ['declared variant without file', { 'w.yaml': 'variants:\n  a: {}\n  b: {}\n', 'w.a.mjml': mjml('A') }, /create `w\.b\.mjml`/, /w\.yaml$/],
  ['variant file without variants', { 'w.de.mjml': mjml('A') }, /looks like variant "de"/, /w\.de\.mjml$/],
  ['variant yaml file', { 'w.yaml': 'variants:\n  a: {}\n', 'w.a.mjml': mjml('A'), 'w.a.yaml': 'name: x\n' }, /go into `w\.yaml`/, /w\.a\.yaml$/],
  [
    'identical discriminators',
    { 'w.yaml': 'variants:\n  a: { discriminator: { lang: de } }\n  b: { discriminator: { lang: de } }\n', 'w.a.mjml': mjml('A'), 'w.b.mjml': mjml('B') },
    /"a" and "b" have the same discriminator/,
    /w\.yaml$/,
  ],
  ['two catch-alls', { 'w.yaml': 'variants:\n  a:\n  b: {}\n', 'w.a.mjml': mjml('A'), 'w.b.mjml': mjml('B') }, /both are catch-alls/, /w\.yaml$/],
  ['shared field on variant', { 'w.yaml': 'variants:\n  a: { group: g }\n', 'w.a.mjml': mjml('A') }, /`group` is shared by all variants/, /w\.yaml$/],
  ['top-level discriminator with variants', { 'w.yaml': 'discriminator: { lang: de }\nvariants:\n  a: {}\n', 'w.a.mjml': mjml('A') }, /cannot be combined with `variants:`/, /w\.yaml$/],
  ['invalid variant name', { 'w.yaml': 'variants:\n  "a b": {}\n' }, /Invalid variant name/, /w\.yaml$/],
  ['variant without subject', { 'w.yaml': 'variants:\n  a: {}\n', 'w.a.mjml': mjml(null) }, /Variant "a" has no subject/, /w\.yaml$/],
  ['empty variants', { 'w.yaml': 'variants: {}\n' }, /`variants` must be a mapping/, /w\.yaml$/],
];

for (const [label, files, message, file] of variantErrors) {
  test(`variant set: rejects ${label}`, async () => {
    const dir = await makeDir(files);
    const { templates, errors } = await loadTemplates(dir);
    assert.equal(templates.length, 0);
    assert.equal(errors.length, 1, errors.map((e) => e.message).join('\n'));
    assert.match(errors[0].message, message);
    assert.match(errors[0].file, file);
    assert.ok(errors[0].line >= 1);
  });
}

test('variant set: error points at the variant key', async () => {
  const dir = await makeDir({ 'w.yaml': 'name: W\nvariants:\n  a: {}\n  b: {}\n', 'w.a.mjml': mjml('A') });
  const { errors } = await loadTemplates(dir);
  assert.equal(errors[0].line, 4);
});

async function warningsFor(variants) {
  const files = { 'w.yaml': `subject: S\nvariants:\n${variants}` };
  for (const [, key] of variants.matchAll(/^ {2}([\w-]+):/gm)) files[`w.${key}.mjml`] = mjml('S');
  const { errors, warnings } = await loadTemplates(await makeDir(files));
  assert.deepEqual(errors, []);
  return warnings.map((w) => w.message);
}

test('warns when overlapping variants have no final', async () => {
  const warnings = await warningsFor('  de: { discriminator: { lang: de } }\n  default: {}\n');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"de" and "default" can both match.*at random/);
});

test('no overlap warning when exactly one of the pair is final', async () => {
  assert.deepEqual(await warningsFor('  de: { final: true, discriminator: { lang: de } }\n  default: {}\n'), []);
});

test('warns when overlapping variants are both final', async () => {
  const warnings = await warningsFor('  de: { final: true, discriminator: { lang: de } }\n  default: { final: true }\n');
  assert.match(warnings[0], /both are `final`/);
});

test('no overlap warning for disjoint or disabled variants', async () => {
  assert.deepEqual(
    await warningsFor(
      '  de: { discriminator: { lang: de } }\n' +
        '  en: { discriminator: { lang: [en, en-GB] } }\n' +
        '  minor: { discriminator: { lang: fr, age: { lt: 18 } } }\n' +
        '  adult: { discriminator: { lang: fr, age: { gte: 18 } } }\n' +
        '  old: { enabled: false }\n',
    ),
    [],
  );
});

test('warns about discriminator parameters missing from the schema', async () => {
  const dir = await makeDir({
    'w.mjml': mjml('W'),
    'w.yaml': 'schema:\n  type: object\n  properties:\n    lang: { type: string }\ndiscriminator:\n  lang: de\n  lnag: de\n',
  });
  const { errors, warnings } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /`lnag`.*not declared in `schema.properties`/);
  assert.equal(warnings[0].line, 7);
});

test('slugFrom: file ignores folders, so the same name in two folders clashes', async () => {
  const dir = await makeDir({ 'a/header.mjml': mjml('A'), 'b/header.mjml': mjml('B') });
  const { errors } = await loadTemplates(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Duplicate template slug "header"/);
});

test('slugFrom: path keeps the folders in the slug', async () => {
  const dir = await makeDir({
    'welcome.mjml': mjml('Welcome!'),
    'partials/header.mjml': mjml('Header'),
    'partials/nested/footer.mjml': mjml('Footer'),
    'a/header.mjml': mjml('A'),
  });
  const { templates, errors } = await loadTemplates(dir, { slugFrom: 'path' });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    templates.map((t) => t.slug),
    ['a/header', 'partials/header', 'partials/nested/footer', 'welcome'],
  );
});

test('slugFrom: path keeps variants in their folder', async () => {
  const dir = await makeDir({
    'billing/invoice.yaml': 'subject: Invoice\nvariants:\n  de:\n    final: true\n    discriminator: { lang: de }\n  default: {}\n',
    'billing/invoice.de.mjml': mjml('Rechnung'),
    'billing/invoice.default.mjml': mjml('Invoice'),
  });
  const { templates, errors } = await loadTemplates(dir, { slugFrom: 'path' });
  assert.deepEqual(errors, []);
  assert.equal(templates[0].slug, 'billing/invoice');
  assert.deepEqual(
    templates[0].variants.map((v) => v.label),
    ['billing/invoice.de', 'billing/invoice.default'],
  );
});

test('slugFrom: path rejects a folder that is not a valid slug segment', async () => {
  const dir = await makeDir({ 'my partials/header.mjml': mjml('Header') });
  const { errors } = await loadTemplates(dir, { slugFrom: 'path' });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Invalid template slug "my partials\/header" \(derived from the file name and its folders\)/);
});

test('a snippet needs no subject and is named after its slug', async () => {
  const dir = await makeDir({
    'partials/theme.mjml': '<mj-attributes><mj-all font-family="Inter" /></mj-attributes>\n',
    'partials/theme.yaml': 'snippet: true\n',
  });
  const { templates, errors } = await loadTemplates(dir, { slugFrom: 'path' });
  assert.deepEqual(errors, []);
  assert.equal(templates[0].payload.subject, '');
  assert.equal(templates[0].payload.name, 'partials/theme');
  assert.equal(templates[0].payload.snippet, true);
});

test('a snippet keeps an explicit name and subject', async () => {
  const dir = await makeDir({
    'header.mjml': mjml('From title'),
    'header.yaml': 'name: Header\nsnippet: true\n',
  });
  const { templates, errors } = await loadTemplates(dir);
  assert.deepEqual(errors, []);
  assert.equal(templates[0].payload.name, 'Header');
  assert.equal(templates[0].payload.subject, 'From title');
});

test('a template that is not a snippet still needs a subject', async () => {
  const dir = await makeDir({ 'header.mjml': mjml(null), 'header.yaml': 'snippet: false\n' });
  const { errors } = await loadTemplates(dir);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no subject and no name/);
});
