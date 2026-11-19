import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, parseDocument, isMap, isScalar, isSeq } from 'yaml';
import { TemplateError } from './errors.js';
import { validateJsonSchema } from './schema.js';
import { canOverlap, canonicalDiscriminator, rulesForParameter } from './discriminator.js';

export const SUPPORTED_TYPES = ['mjml'];

/** Fields that can be configured at the top level of `<slug>.yaml`. */
export const CONFIG_FIELDS = {
  name: 'string',
  subject: 'string',
  enabled: 'boolean',
  final: 'boolean',
  group: 'string',
  snippet: 'boolean',
  schema: 'schema',
  type: 'type',
  discriminator: 'discriminator',
  variants: 'variants',
};

/** Fields that can be set per variant (everything else is shared). */
export const VARIANT_FIELDS = {
  name: 'string',
  subject: 'string',
  enabled: 'boolean',
  final: 'boolean',
  schema: 'schema',
  discriminator: 'discriminator',
};

/** Fields that exist in the Shablon API but cannot be set in YAML. */
const UNSUPPORTED_FIELDS = {
  slug: 'The slug is derived from the file name (`<slug>.mjml`) and cannot be set in the YAML file. Rename the file instead.',
  markup: 'The markup is read from the `.mjml` file and cannot be set in the YAML file.',
  html: '`html` is only used by `raw` templates, which this action does not support (only `mjml`).',
  text: '`text` is only used by `raw` templates, which this action does not support (only `mjml`).',
};

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * How a template's slug is derived from where its file sits below `basePath`:
 * `file` uses the bare file name (`partials/header.mjml` → `header`), `path`
 * keeps the folders (`partials/header.mjml` → `partials/header`), which is the
 * slug Shablon resolves `<mj-include path="partials/header.mjml" />` to.
 */
export const SLUG_MODES = ['file', 'path'];

/**
 * @typedef {{ file?: string, line?: number, column?: number, slug?: string }} Location
 *
 * A template without variants: one `<slug>.mjml` (+ optional `<slug>.yaml`).
 * @typedef {object} TemplateDefinition
 * @property {string} slug
 * @property {string} mjmlFile    absolute path of the .mjml file
 * @property {string|null} configFile absolute path of the .yaml/.yml file, if any
 * @property {object} payload     request body for the Shablon API (without slug)
 *
 * One variant of a variant set: `<slug>.<key>.mjml`.
 * @typedef {object} VariantDefinition
 * @property {string} key
 * @property {string} label       `<slug>.<key>`, used in logs and outputs
 * @property {string} mjmlFile
 * @property {object} payload     always contains `discriminator` (`[]` for a catch-all)
 *
 * A slug whose `<slug>.yaml` declares `variants:`.
 * @typedef {object} VariantSetDefinition
 * @property {string} slug
 * @property {string} configFile
 * @property {VariantDefinition[]} variants
 *
 * @typedef {{ mjml: string[], config: string[], variants: Map<string, string[]>, variantConfig: string[] }} FileGroup
 */

/**
 * Recursively find all template files below `basePath` and group them by slug.
 * `welcome.de.mjml` belongs to slug `welcome`, variant `de`. With
 * `slugFrom: 'path'`, `partials/header.mjml` belongs to slug `partials/header`.
 *
 * @param {string} basePath
 * @param {{ slugFrom?: 'file' | 'path' }} [options]
 * @returns {Promise<Map<string, FileGroup>>}
 */
export async function discoverTemplateFiles(basePath, { slugFrom = 'file' } = {}) {
  let info;
  try {
    info = await stat(basePath);
  } catch {
    throw new TemplateError(`basePath "${basePath}" does not exist.`);
  }
  if (!info.isDirectory()) {
    throw new TemplateError(`basePath "${basePath}" is not a directory.`);
  }

  const entries = await readdir(basePath, { recursive: true, withFileTypes: true });
  /** @type {Map<string, FileGroup>} */
  const bySlug = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!['.mjml', '.yaml', '.yml'].includes(ext)) continue;

    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (full.split(path.sep).includes('node_modules')) continue;

    const base = path.basename(entry.name, path.extname(entry.name));
    const dot = base.indexOf('.');
    const name = dot === -1 ? base : base.slice(0, dot);
    const folder = path.relative(basePath, path.dirname(full)).split(path.sep).filter(Boolean);
    const slug = slugFrom === 'path' ? [...folder, name].join('/') : name;
    const variant = dot === -1 ? null : base.slice(dot + 1);

    const group = bySlug.get(slug) ?? { mjml: [], config: [], variants: new Map(), variantConfig: [] };
    if (variant === null) {
      (ext === '.mjml' ? group.mjml : group.config).push(full);
    } else if (ext === '.mjml') {
      group.variants.set(variant, [...(group.variants.get(variant) ?? []), full]);
    } else {
      group.variantConfig.push(full);
    }
    bySlug.set(slug, group);
  }

  return new Map([...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Discover and fully validate every template under `basePath`.
 * Never throws for per-template problems; those are collected in `errors`.
 *
 * @param {string} basePath
 * @param {{ slugFrom?: 'file' | 'path' }} [options] see {@link discoverTemplateFiles}
 * @returns {Promise<{ templates: (TemplateDefinition | VariantSetDefinition)[], errors: TemplateError[], warnings: TemplateError[] }>}
 */
export async function loadTemplates(basePath, options) {
  const files = await discoverTemplateFiles(basePath, options);
  const templates = [];
  const errors = [];
  const warnings = [];

  for (const [slug, group] of files) {
    try {
      const loaded = await loadTemplate(slug, group);
      templates.push(loaded.definition);
      warnings.push(...loaded.warnings);
    } catch (err) {
      errors.push(toTemplateError(err, { slug, file: group.config[0] ?? group.mjml[0] }));
    }
  }

  return { templates, errors, warnings };
}

/**
 * @param {string} slug
 * @param {FileGroup} group
 */
async function loadTemplate(slug, group) {
  const anyFile = group.config[0] ?? group.mjml[0] ?? [...group.variants.values()][0]?.[0] ?? group.variantConfig[0];
  if (!slug.split('/').every((segment) => SLUG_PATTERN.test(segment))) {
    throw new TemplateError(
      `Invalid template slug "${slug}" (derived from the file name${slug.includes('/') ? ' and its folders' : ''}). Use only letters, digits, "-" and "_", starting with a letter or digit.`,
      { slug, file: anyFile },
    );
  }
  if (group.mjml.length > 1) {
    throw new TemplateError(
      `Duplicate template slug "${slug}": found ${group.mjml.length} MJML files (${group.mjml.join(', ')}). Slugs must be unique across all sub-folders.`,
      { slug, file: group.mjml[1] },
    );
  }
  if (group.config.length > 1) {
    throw new TemplateError(
      `Multiple config files for template "${slug}" (${group.config.join(', ')}). Use exactly one \`${slug}.yaml\`.`,
      { slug, file: group.config[1] },
    );
  }
  if (group.variantConfig.length > 0) {
    const file = group.variantConfig[0];
    const variant = path.basename(file, path.extname(file)).slice(slug.length + 1);
    throw new TemplateError(
      `\`${path.basename(file)}\` is not used: settings for variant "${variant}" go into \`${slug}.yaml\` under \`variants: { ${variant}: ... }\`.`,
      { slug, file, line: 1 },
    );
  }

  const configFile = group.config[0] ?? null;
  const parsed = configFile
    ? parseConfig(await readFile(configFile, 'utf8'), { slug, file: configFile })
    : { config: {}, locs: {} };

  if (parsed.config.variants) {
    return loadVariantSet(slug, group, configFile, parsed);
  }

  if (group.variants.size > 0) {
    const [key, [file]] = [...group.variants.entries()][0];
    throw new TemplateError(
      `\`${path.basename(file)}\` looks like variant "${key}" of "${slug}", but ${configFile ? `\`${path.basename(configFile)}\` declares` : `there is no \`${slug}.yaml\` that declares`} no \`variants:\`. ` +
        `Declare it (\`variants: { ${key}: {} }\`) or rename the file (dots are not allowed in slugs).`,
      { slug, file, line: 1 },
    );
  }

  const [mjmlFile] = group.mjml;
  if (!mjmlFile) {
    throw new TemplateError(
      `Found config file for "${slug}" but no matching \`${slug}.mjml\` next to it.`,
      { slug, file: configFile },
    );
  }
  if (configFile && path.dirname(configFile) !== path.dirname(mjmlFile)) {
    throw new TemplateError(
      `Config file for "${slug}" must be in the same folder as \`${slug}.mjml\` (${path.dirname(mjmlFile)}).`,
      { slug, file: configFile },
    );
  }

  const { config, locs } = parsed;
  const markup = await readMarkup(slug, mjmlFile);
  // A snippet is only ever included into other templates, never sent, so its
  // subject is never shown. Shablon still stores one, so it gets an empty one.
  const subject = config.subject ?? extractSubject(markup) ?? '';
  const name = config.name ?? (subject || slug);

  if (!subject && !config.snippet) {
    const where = configFile
      ? `Add \`subject:\` to ${path.basename(configFile)} or an <mj-title> to ${path.basename(mjmlFile)}.`
      : `Add a \`${slug}.yaml\` with \`name:\` and \`subject:\`, or an <mj-title> inside <mj-head> of ${path.basename(mjmlFile)}.`;
    throw new TemplateError(
      `Template "${slug}" has no subject${config.name ? '' : ' and no name'}: ${where}`,
      { slug, file: configFile ?? mjmlFile, line: 1 },
    );
  }

  const payload = { name, subject, type: config.type ?? 'mjml', markup };
  for (const key of ['enabled', 'final', 'group', 'snippet', 'schema', 'discriminator']) {
    if (config[key] !== undefined) payload[key] = config[key];
  }

  const warnings = schemaWarnings(slug, slug, payload, locs.discriminatorParams);
  return { definition: { slug, mjmlFile, configFile, payload }, warnings };
}

/**
 * @param {string} slug
 * @param {FileGroup} group
 * @param {string} configFile
 * @param {{ config: any, locs: any }} parsed
 * @returns {Promise<{ definition: VariantSetDefinition, warnings: TemplateError[] }>}
 */
async function loadVariantSet(slug, group, configFile, { config, locs }) {
  const yamlName = path.basename(configFile);
  const dir = path.dirname(configFile);
  const declared = config.variants;

  if (group.mjml.length > 0) {
    throw new TemplateError(
      `\`${yamlName}\` declares \`variants:\`, so \`${slug}.mjml\` would not be used. ` +
        `Rename it to \`${slug}.<variant>.mjml\` (e.g. \`${slug}.default.mjml\`) and declare that variant.`,
      { slug, file: group.mjml[0], line: 1 },
    );
  }
  if (locs.discriminator) {
    throw new TemplateError(
      'A top-level `discriminator` cannot be combined with `variants:`. Set `discriminator` on each variant instead.',
      { slug, ...locs.discriminator },
    );
  }
  for (const [key, files] of group.variants) {
    if (!declared.some((v) => v.key === key)) {
      throw new TemplateError(
        `\`${path.basename(files[0])}\` is not declared in \`${yamlName}\`. Add \`${key}: {}\` under \`variants:\` or remove the file.`,
        { slug, file: files[0], line: 1 },
      );
    }
  }

  const variants = [];
  const warnings = [];

  for (const { key, config: own, loc, locs: ownLocs } of declared) {
    const label = `${slug}.${key}`;
    const files = group.variants.get(key) ?? [];
    if (files.length === 0) {
      throw new TemplateError(`Variant "${key}" has no markup file: create \`${label}.mjml\` next to \`${yamlName}\`.`, {
        slug,
        ...loc,
      });
    }
    if (files.length > 1) {
      throw new TemplateError(
        `Duplicate variant file for "${label}": found ${files.length} MJML files (${files.join(', ')}).`,
        { slug, file: files[1] },
      );
    }
    const [mjmlFile] = files;
    if (path.dirname(mjmlFile) !== dir) {
      throw new TemplateError(`\`${label}.mjml\` must be in the same folder as \`${yamlName}\` (${dir}).`, {
        slug,
        file: mjmlFile,
      });
    }

    const markup = await readMarkup(slug, mjmlFile);
    const subject = own.subject ?? config.subject ?? extractSubject(markup);
    if (!subject) {
      throw new TemplateError(
        `Variant "${key}" has no subject: add \`subject:\` to the variant or the top level of \`${yamlName}\`, or an <mj-title> to \`${label}.mjml\`.`,
        { slug, ...loc },
      );
    }

    const payload = {
      name: own.name ?? `${config.name ?? subject} (${key})`,
      subject,
      type: config.type ?? 'mjml',
      markup,
      discriminator: own.discriminator ?? [],
    };
    for (const field of ['enabled', 'final', 'schema']) {
      const value = own[field] ?? config[field];
      if (value !== undefined) payload[field] = value;
    }
    for (const field of ['group', 'snippet']) {
      if (config[field] !== undefined) payload[field] = config[field];
    }

    variants.push({ key, label, mjmlFile, payload, loc });
    warnings.push(...schemaWarnings(slug, label, payload, ownLocs.discriminatorParams));
  }

  // Two variants with the same rules can never be told apart, neither by
  // Shablon when sending nor by this action when syncing.
  const seen = new Map();
  for (const v of variants) {
    const canonical = canonicalDiscriminator(v.payload.discriminator);
    const other = seen.get(canonical);
    if (other) {
      throw new TemplateError(
        `Variants "${other.key}" and "${v.key}" have the same discriminator${canonical === '' ? ' (none, both are catch-alls)' : ''}. Every variant needs different rules.`,
        { slug, ...v.loc },
      );
    }
    seen.set(canonical, v);
  }

  warnings.push(...overlapWarnings(slug, variants));

  return {
    definition: { slug, configFile, variants: variants.map(({ loc, ...v }) => v) },
    warnings,
  };
}

async function readMarkup(slug, file) {
  const markup = await readFile(file, 'utf8');
  if (markup.trim() === '') {
    throw new TemplateError(`MJML file \`${path.basename(file)}\` is empty.`, { slug, file, line: 1 });
  }
  return markup;
}

/** Warn about discriminator parameters that the schema doesn't declare. */
function schemaWarnings(slug, label, payload, paramLocs = {}) {
  if (!payload.schema || !payload.discriminator) return [];
  const properties = JSON.parse(payload.schema).properties;
  if (!properties || typeof properties !== 'object') return [];
  return Object.entries(paramLocs)
    .filter(([param]) => !Object.hasOwn(properties, param))
    .map(
      ([param, loc]) =>
        new TemplateError(
          `Discriminator parameter \`${param}\` of "${label}" is not declared in \`schema.properties\`. Check for a typo.`,
          { slug, ...loc },
        ),
    );
}

/**
 * Shablon picks a random template when several match a send and none of them
 * is `final`. Warn about variant pairs where that can happen.
 */
function overlapWarnings(slug, variants) {
  const warnings = [];
  const active = variants.filter((v) => v.payload.enabled !== false);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const [a, b] = [active[i], active[j]];
      if (!canOverlap(a.payload.discriminator, b.payload.discriminator)) continue;
      const finals = [a, b].filter((v) => v.payload.final);
      if (finals.length === 1) continue;
      const message =
        finals.length === 0
          ? `Variants "${a.key}" and "${b.key}" can both match the same send and neither is \`final\`, so Shablon picks one of them at random. Set \`final: true\` on the one that should win.`
          : `Variants "${a.key}" and "${b.key}" can both match the same send and both are \`final\`, so it is ambiguous which one wins. Set \`final: true\` on only one of them.`;
      warnings.push(new TemplateError(message, { slug, ...b.loc }));
    }
  }
  return warnings;
}

/**
 * Extract the subject from `<mj-title>` (MJML's equivalent of `<title>`).
 *
 * @param {string} markup
 * @returns {string|null}
 */
export function extractSubject(markup) {
  const withoutComments = markup.replace(/<!--[\s\S]*?-->/g, '');
  const head = withoutComments.match(/<mj-head\b[^>]*>([\s\S]*?)<\/mj-head\s*>/i);
  const source = head ? head[1] : withoutComments;
  const title = source.match(/<mj-title\b[^>]*>([\s\S]*?)<\/mj-title\s*>/i);
  if (!title) return null;
  const text = decodeEntities(title[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Parse and validate a `<slug>.yaml` config file.
 *
 * Returns the validated fields and the source location of each key (used for
 * annotations). `config.variants`, if present, is a list of
 * `{ key, config, loc, locs }`.
 *
 * @param {string} source
 * @param {{ slug: string, file: string }} ctx
 */
export function parseConfig(source, ctx) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, prettyErrors: false });

  if (doc.errors.length > 0) {
    const [first] = doc.errors;
    const pos = first.linePos?.[0] ?? (first.pos ? lineCounter.linePos(first.pos[0]) : undefined);
    throw new TemplateError(`Invalid YAML: ${first.message.split('\n')[0]}`, {
      ...ctx,
      line: pos?.line,
      column: pos?.col,
    });
  }

  if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) {
    return { config: {}, locs: {} };
  }
  if (!isMap(doc.contents)) {
    throw new TemplateError('The YAML file must contain a mapping (key: value pairs) at the top level.', {
      ...ctx,
      line: 1,
    });
  }

  return parseFields(doc.contents, CONFIG_FIELDS, { doc, lineCounter, ctx });
}

/**
 * @param {import('yaml').YAMLMap} map
 * @param {Record<string, string>} fields
 * @param {{ doc: import('yaml').Document, lineCounter: LineCounter, ctx: Location }} env
 */
function parseFields(map, fields, env) {
  const config = {};
  const locs = {};
  for (const pair of map.items) {
    const key = keyOf(pair);
    const loc = locOf(pair.key, env);

    if (key in UNSUPPORTED_FIELDS) {
      throw new TemplateError(UNSUPPORTED_FIELDS[key], loc);
    }
    const kind = fields[key];
    if (!kind) {
      const hint =
        fields === VARIANT_FIELDS && key in CONFIG_FIELDS
          ? `\`${key}\` is shared by all variants and can only be set at the top level.`
          : `Supported fields: ${Object.keys(fields).join(', ')}.`;
      throw new TemplateError(`Unknown field \`${key}\`${fields === VARIANT_FIELDS ? ' in variant' : ''}. ${hint}`, loc);
    }
    locs[key] = loc;

    if (kind === 'discriminator') {
      const { rules, paramLocs } = parseDiscriminator(pair.value, loc, env);
      config[key] = rules;
      locs.discriminatorParams = paramLocs;
    } else if (kind === 'variants') {
      config[key] = parseVariants(pair.value, loc, env);
    } else {
      config[key] = validateField(key, kind, toJS(pair.value, env), loc);
    }
  }
  return { config, locs };
}

function parseVariants(node, loc, env) {
  if (!isMap(node) || node.items.length === 0) {
    throw new TemplateError(
      '`variants` must be a mapping from variant name to its settings, e.g. `variants: { de: { discriminator: { lang: de } }, default: {} }`.',
      loc,
    );
  }
  return node.items.map((pair) => {
    const key = keyOf(pair);
    const variantLoc = locOf(pair.key, env);
    if (!SLUG_PATTERN.test(key)) {
      throw new TemplateError(
        `Invalid variant name "${key}". Use only letters, digits, "-" and "_", starting with a letter or digit.`,
        variantLoc,
      );
    }
    const value = pair.value;
    if (value === null || (isScalar(value) && value.value === null)) {
      return { key, config: {}, loc: variantLoc, locs: {} };
    }
    if (!isMap(value)) {
      throw new TemplateError(`Variant "${key}" must be a mapping of settings (use \`${key}: {}\` for none).`, variantLoc);
    }
    const { config, locs } = parseFields(value, VARIANT_FIELDS, env);
    return { key, config, loc: variantLoc, locs };
  });
}

function parseDiscriminator(node, loc, env) {
  if (isSeq(node)) {
    throw new TemplateError(
      '`discriminator` must be a mapping from parameter to condition, not the API\'s list of rules. ' +
        'For example: `discriminator: { lang: de, plan: [pro, business], age: { gte: 18 } }`.',
      loc,
    );
  }
  if (!isMap(node) || node.items.length === 0) {
    throw new TemplateError(
      '`discriminator` must be a non-empty mapping from parameter to condition, e.g. `discriminator: { lang: de }`. ' +
        'Leave it out for a catch-all.',
      loc,
    );
  }
  const rules = [];
  const paramLocs = {};
  for (const pair of node.items) {
    const parameter = keyOf(pair);
    const paramLoc = locOf(pair.key, env);
    if (parameter.trim() === '') {
      throw new TemplateError('Discriminator parameter names must not be empty.', paramLoc);
    }
    try {
      rules.push(...rulesForParameter(parameter, toJS(pair.value, env)));
    } catch (err) {
      throw new TemplateError(err.message, paramLoc);
    }
    paramLocs[parameter] = paramLoc;
  }
  return { rules, paramLocs };
}

function keyOf(pair) {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

function locOf(node, { lineCounter, ctx }) {
  const pos = node?.range ? lineCounter.linePos(node.range[0]) : undefined;
  return { ...ctx, line: pos?.line, column: pos?.col };
}

function toJS(node, { doc }) {
  if (node === null || node === undefined) return null;
  return typeof node.toJS === 'function' ? node.toJS(doc) : node;
}

function validateField(key, kind, value, loc) {
  switch (kind) {
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TemplateError(`\`${key}\` must be a non-empty string, got ${describe(value)}.`, loc);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new TemplateError(`\`${key}\` must be \`true\` or \`false\`, got ${describe(value)}.`, loc);
      }
      return value;
    case 'type':
      if (!SUPPORTED_TYPES.includes(value)) {
        throw new TemplateError(
          `\`type\` ${describe(value)} is not supported. Only ${SUPPORTED_TYPES.map((t) => `"${t}"`).join(', ')} is supported right now.`,
          loc,
        );
      }
      return value;
    case 'schema':
      return validateJsonSchema(value, loc);
    default:
      throw new Error(`unhandled field kind ${kind}`);
  }
}

function describe(value) {
  if (value === null || value === undefined) return 'an empty value';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * @param {unknown} err
 * @param {{ slug?: string, file?: string }} fallback
 * @returns {TemplateError}
 */
export function toTemplateError(err, fallback = {}) {
  if (err instanceof TemplateError) {
    err.slug ??= fallback.slug;
    err.file ??= fallback.file;
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new TemplateError(message, fallback);
}
