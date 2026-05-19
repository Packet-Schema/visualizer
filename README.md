# Packet View

[![tests](https://github.com/HackU-5/packet-view/actions/workflows/test.yml/badge.svg)](https://github.com/HackU-5/packet-view/actions/workflows/test.yml)

Interactive packet diagrams for teaching, learning, and authoring network
protocols.

Packet View renders packet schemas as live, clickable diagrams in the browser.
You can inspect individual fields, explore variable-length layouts, import or
export packet definitions, and switch between wire-level and semantic views
when a schema supports them.

## Project shape

Packet View is a browser application built around **PSML** (Packet Schema
Markup Language). PSML is the canonical schema format used by built-in presets,
imports, exports, and layout resolution.

The repository is organized around a few stable areas:

- `web/` — the Next.js application
- `data/presets/` — built-in PSML presets
- `schemas/` — JSON Schema for PSML documents
- `docs/` — architecture, testing, and PSML authoring references

Useful starting points:

- [Architecture](./docs/architecture.md)
- [PSML specification](./docs/psml-0.4.md)
- [PSML cheatsheet](./docs/psml-cheatsheet.md)
- [Adding a preset](./docs/adding-a-preset.md)
- [Testing](./docs/testing.md)

## Run locally

The source application lives in `web/`.

```sh
cd web
npm install
npm run dev
```

Then open the local URL printed by Next.js in your browser.

For a production-style static build:

```sh
cd web
npm run build
```

The app is exported as static files at build time; it does not require
application server logic at runtime.

## Presets and supported formats

Built-in packet presets live in [`data/presets/`](./data/presets/). The preset
picker in the app is the source of truth for what is currently bundled.

Packet View uses PSML as its format hub and provides import/export bridges for
the formats supported by the current application. See the PSML specification
for the up-to-date format notes and limitations.

### Adding a preset

Preset files are YAML documents under [`data/presets/`](./data/presets/).
They are validated against [`schemas/psml.schema.json`](./schemas/psml.schema.json)
and compiled into the web app during the normal npm workflows.

```sh
cd web
npm run build:presets
```

For the authoring workflow and schema guidance, see
[Adding a preset](./docs/adding-a-preset.md).

## Tests

```sh
cd web
npm test
npm run test:watch
npm run test:coverage
```

CI runs linting, build verification, and coverage checks on pushes and pull
requests.
