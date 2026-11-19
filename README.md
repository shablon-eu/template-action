# Shablon Template Sync

A GitHub Action that creates or updates [Shablon](https://shablon.eu) email templates from MJML files in your repository.

```
templates/
├── welcome.mjml              → slug "welcome" (subject + name from <mj-title>)
├── password-reset.mjml       → slug "password-reset"
├── password-reset.yaml       → settings for "password-reset"
├── invoice.yaml              → slug "invoice" with variants (discriminators)
├── invoice.de.mjml           → variant "de"
└── invoice.default.mjml      → variant "default"
```

## Usage

```yaml
name: Deploy email templates

on:
  push:
    branches: [main]
    paths: ['templates/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: shablon-eu/template-action@v1
        with:
          apiKey: ${{ secrets.SHABLON_API_KEY }}
          basePath: templates
```

To check templates in pull requests without changing anything, set `dryRun: true`.

### Inputs

| Input      | Required | Default                  | Description                                                                 |
| ---------- | -------- | ------------------------ | --------------------------------------------------------------------------- |
| `apiKey`   | yes      |                          | Shablon API key (`sk.****`). Store it as a secret.                          |
| `basePath` | yes      |                          | Folder with the templates, relative to the repository root. Searched recursively. |
| `apiUrl`   | no       | `https://api.shablon.eu` | Base URL of the Shablon API.                                                |
| `dryRun`   | no       | `false`                  | Validate and report what would change, without creating or updating anything. |
| `slugFrom` | no       | `file`                   | How the slug is derived: `file` uses the file name, `path` keeps the folders below `basePath`. See [Slug modes](#slug-modes). |
| `prune`    | no       | `disable`                | What to do with a Shablon template that has the slug of a `variants:` file but matches none of its variants: `disable` sets `enabled: false`, `delete` deletes it, `warn` leaves it as it is and adds a warning annotation. See [Removed variants](#removed-variants). |

### Outputs

| Output      | Description                                   |
| ----------- | --------------------------------------------- |
| `created`   | JSON array of templates that were created.    |
| `updated`   | JSON array of templates that were updated.    |
| `unchanged` | JSON array of templates that were already up to date. |
| `disabled`  | JSON array of templates disabled by `prune: disable`. |
| `deleted`   | JSON array of templates deleted by `prune: delete`. |

Templates are listed as `<slug>`, variants as `<slug>.<variant>` and pruned templates as `<slug>#<id>`.

## Template files

Every `<slug>.mjml` below `basePath` is one template. By default the **file name is the slug** (see [Slug modes](#slug-modes) for the alternative), and it may only contain letters, digits, `-` and `_`. A file name with a dot, such as `<slug>.<variant>.mjml`, is a [variant](#variants-discriminators).

### Slug modes

The `slugFrom` input decides how a file's slug is derived from where it sits below `basePath`:

| File below `basePath`         | `slugFrom: file` (default) | `slugFrom: path`          |
| ----------------------------- | -------------------------- | ------------------------- |
| `welcome.mjml`                | `welcome`                  | `welcome`                 |
| `auth/password-reset.mjml`    | `password-reset`           | `auth/password-reset`     |
| `partials/header.mjml`        | `header`                   | `partials/header`         |
| `billing/invoice.de.mjml`     | `invoice`, variant `de`    | `billing/invoice`, variant `de` |

- **`file`** ignores folders. They are there only to organise the repository, so a file name must be unique across all sub-folders: `a/header.mjml` and `b/header.mjml` are a "duplicate slug" error.
- **`path`** keeps the folders, joined with `/`. Every folder name has to follow the same rules as a slug, so `my partials/header.mjml` is an error. The same file name may appear in different folders, because the slugs differ. Use this mode when templates include snippets from a sub-folder (see [Snippets and `<mj-include>`](#snippets-and-mj-include)), and when you send with slugs like `auth/password-reset`.
- In both modes, a `<slug>.yaml` and its variant files must be in the same folder as the template, and the slug is what you pass when sending.

**Switching modes** changes the slug of every template in a sub-folder. The action matches templates by slug, so the next sync creates a template under each new slug. The template under the old slug is left in Shablon as it is (it is neither updated nor pruned), and sends that still use the old slug keep getting it. Change the sending code to the new slugs, then delete or disable the old templates in the Shablon UI. Templates directly in `basePath` have the same slug in both modes and are not affected.

### Snippets and `<mj-include>`

Shablon resolves `<mj-include path="partials/header.mjml" />` to the snippet with the slug `partials/header`. To keep shared partials in a sub-folder and include them by their path, set `slugFrom: path` and mark each partial as a snippet:

```
emails/
├── welcome.mjml              → "welcome", includes partials/header.mjml
└── partials/
    ├── header.mjml           → snippet "partials/header"
    └── header.yaml           → snippet: true
```

A snippet is never sent, so it needs no subject: without `subject:` or an `<mj-title>` it is stored with an empty subject, and it is named after its slug unless `name:` is set.

### `<slug>.yaml` (optional)

Put a `<slug>.yaml` (or `.yml`) next to the MJML file to configure the template. Every field is optional:

```yaml
name: Password reset            # human-readable name (default: the subject)
subject: Reset your password    # email subject (default: the <mj-title> of the MJML file)
enabled: true                   # can the template be used to send?
final: false                    # prefer this template when several match
snippet: false                  # is this a reusable snippet?
group: grp_123                  # id of the group the template belongs to
type: mjml                      # only "mjml" is supported
discriminator:                  # when Shablon picks this template, see below
  lang: de
schema:                         # JSON schema for the template parameters
  type: object
  properties:
    name: { type: string }
  required: [name]
```

- **`schema`** can be written as a YAML mapping (as above) or as a string containing JSON. It is validated as a JSON schema before anything is sent. Supported drafts are draft-07 (default), 2019-09 and 2020-12, picked by `$schema`.
- `enabled`, `final`, `snippet`, `group` and `discriminator` are not touched if you leave them out when an existing template is updated. For example, if you toggle `enabled` in the Shablon UI and don't set it in the YAML file, the action leaves it as it is. `name` always has a value (it falls back to the subject), so it is always synced.
- `schema` is different: it belongs to the template content, like `subject` and the markup. If you remove it from the YAML file, the next sync publishes a new version without a schema.
- Unknown fields cause an error, so typos don't go unnoticed.

### Without a YAML file

If there is no YAML file, or it sets no `subject`, the subject comes from `<mj-title>` in `<mj-head>`. That subject is also used as the name unless `name` is set:

```xml
<mjml>
  <mj-head>
    <mj-title>Welcome, {{name}}!</mj-title>
  </mj-head>
  ...
</mjml>
```

If there is no subject in either place, the action fails and tells you which file to fix.

## Variants (discriminators)

Several Shablon templates can share a slug. When you send with that slug, Shablon uses each template's **discriminator** to choose one, based on the send parameters. To manage variants, add `variants:` to `<slug>.yaml`. Each variant `<key>` uses the markup in `<slug>.<key>.mjml` next to it:

```
templates/
├── invoice.yaml
├── invoice.de.mjml
├── invoice.fr.mjml
└── invoice.default.mjml
```

```yaml
# invoice.yaml
name: Invoice                   # top-level fields are shared by all variants
enabled: true
schema:
  type: object
  properties:
    lang: { type: string }
    amount: { type: number }

variants:
  de:
    final: true                 # wins over "default" when both match
    discriminator:
      lang: [de, de-AT, de-CH]
  fr:
    final: true
    discriminator:
      lang: { in: [fr, fr-CH] }
  default: {}                   # no discriminator → catch-all
```

- A variant can set `name`, `subject`, `enabled`, `final`, `schema` and `discriminator`. `group`, `snippet` and `type` can only be set at the top level. Fields a variant leaves out come from the top level.
- `name` defaults to `<top-level name or subject> (<key>)`, for example `Invoice (de)`. `subject` falls back to the `<mj-title>` of the variant's own MJML file.
- A plain `<slug>.mjml` next to a `variants:` file is an error, and so is a `<slug>.<key>.mjml` whose variant isn't declared. Variant names follow the same rules as slugs.
- Two variants with the same discriminator are an error, because Shablon couldn't tell them apart.
- In a variant set, `discriminator` is always synced: leaving it out of a variant makes that variant a catch-all.

### Discriminator syntax

`discriminator` maps a send parameter to a condition. A template matches a send only if **every** condition matches. You can also use it in a plain `<slug>.yaml` without `variants:`.

| YAML                          | Matches when the parameter…          |
| ----------------------------- | ------------------------------------ |
| `lang: de`                    | equals `de` (`eq`)                   |
| `lang: [de, at]`              | is one of the values (`in`)          |
| `lang: { not: de }`           | is not `de`                          |
| `lang: { in: [de, at] }`      | is one of the values                 |
| `lang: { not_in: [de, at] }`  | is none of the values                |
| `age: { gt: 17 }`             | is greater than (also `gte`, `lt`, `lte`) |
| `age: { gte: 18, lt: 65 }`    | satisfies both                       |

- Values are strings or numbers. `in` and `not_in` take a non-empty list of strings. Booleans are not supported by Shablon, so quote them (`"true"`) if the parameter is a string.
- The API's list form (`- { parameter: lang, cmp: eq, value: de }`) is not accepted. Use the mapping above.
- If the template has a `schema` with `properties`, the action warns about discriminator parameters that aren't declared there. That catches typos.

### Which variant wins

Disabled templates never match. If several enabled templates match a send, Shablon uses the one with `final: true`. **If none of them is `final`, it picks one at random.** A catch-all matches every send, so the variant that should win over it needs `final: true`.

The action warns about pairs of variants that can match the same send when neither is `final` or both are. It recognises conflicting rules on the same parameter, such as `lang: de` vs `lang: en`, `in` lists with no common value, and number ranges such as `age: { lt: 18 }` vs `age: { gte: 18 }`. Any other pair is treated as possibly overlapping.

### How variants are matched to Shablon templates

Shablon doesn't store the variant key, so each variant is matched to an existing template with its slug in this order:

1. a template with the same discriminator (the order of the rules doesn't matter),
2. otherwise, a template with the same `name`. This means you can change a variant's discriminator and keep its version history,
3. otherwise, a new template is created.

If you change a variant's discriminator **and** its name in the same commit, a new template is created and the old one is pruned.

To move an existing single template to variants, give the catch-all variant no discriminator: it then takes over the existing template.

### Removed variants

A Shablon template with the slug that matches no variant (for example, because you removed the variant from the YAML file) is handled by the `prune` input:

- `disable` (default) sets `enabled: false`, so it is no longer used for sends. You can re-enable it in the Shablon UI.
- `delete` deletes it.
- `warn` leaves it as it is and adds a warning annotation.

With `dryRun: true`, nothing is disabled or deleted; the summary shows what would happen.

Pruning only applies to slugs with `variants:`. For a template without `variants:`, the action fails if more than one Shablon template uses the slug, instead of guessing which one to update. Declare them as variants instead.

### Not supported (yet)

- Only `mjml` templates are supported. `raw` and `@react-email` are not.
- `slug` and `markup` cannot be set in YAML: they come from the file name and the `.mjml` file.

## Behaviour

1. **Validate everything first.** All templates are parsed and checked (YAML syntax, field types, JSON schema, discriminators, subject present, unique slugs, variant files). If any template is invalid, the action fails **before** it calls the API, so nothing is partially deployed.
2. **Create or update.** For each template, the action looks up the slug in Shablon (snippets included). Variants are matched as described in [How variants are matched](#how-variants-are-matched-to-shablon-templates). Otherwise:
   - not found: the template is **created** with that slug;
   - found: the template is **updated**, but only if something changed. Changes to `name`/`enabled`/`final`/`group`/`snippet`/`discriminator` are sent on their own. Changes to `subject`/`markup`/`schema` create a new template version. Unchanged templates are skipped, so re-running the workflow doesn't create a new version each time.
3. **Prune.** Templates of a variant slug that match no variant are disabled, deleted or reported, depending on `prune`.
4. **Report.** Errors and warnings show up as annotations on the offending file and line in the workflow run and in the PR "Files changed" view. A summary table is written to the job summary.

## Development

```sh
npm install
npm test        # unit + end-to-end tests (against a local fake API)
npm run build   # bundles src/ into dist/index.js – commit the result
```

`dist/` is committed because GitHub runs the action straight from the repository. CI fails if `dist/` is out of date.

### Releasing

Releases use [semantic versioning](https://semver.org). Commit (including a rebuilt `dist/`) and push a tag:

```sh
git tag -a v1.0.0 -m v1.0.0
git push origin v1.0.0
```

The [release workflow](.github/workflows/release.yml) then:

1. checks that `dist/` is up to date and the tests pass,
2. creates a **draft** GitHub release `v1.0.0` with generated release notes,
3. moves the floating tags **`v1.0`** and **`v1`** to the new release.

So users can pin `@v1` (all 1.x updates), `@v1.0` (patch updates only) or `@v1.0.0` (exact version).

Then publish the draft yourself. GitHub has no API for listing a release on the Marketplace, so this step is manual: go to **Releases**, edit the `v1.0.0` draft, make sure **Publish this Action to the GitHub Marketplace** is ticked, and click **Publish release**. The workflow run summary links to the Releases page.

A floating tag only moves if the new release is the newest in its line. A `v1.0.2` hotfix released after `v1.1.0` updates `v1.0`, but `v1` stays on `v1.1.0`. Pre-release tags such as `v1.1.0-rc.1` don't trigger the workflow.

You can also release without pushing a tag yourself: use **Actions → Release → Run workflow**, pick the branch and enter the tag (e.g. `v1.0.0`). If the tag doesn't exist yet, the workflow creates it at the head of that branch once the checks pass. Running it again with an existing tag re-runs the release for that tag (for example, after a failed run).
