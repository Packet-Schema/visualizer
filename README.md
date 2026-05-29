# Packet Schema Visualizer

[![tests](https://github.com/HackU-5/packet-view/actions/workflows/test.yml/badge.svg)](https://github.com/HackU-5/packet-view/actions/workflows/test.yml)

Interactive packet diagrams for teaching, learning, and authoring network
protocols.

Packet Schema Visualizer renders packet schemas as live, clickable diagrams in
the browser.
You can inspect individual fields, explore variable-length layouts, import or
export packet definitions, and switch between wire-level and semantic views
when a schema supports them.

## Project shape

Packet Schema Visualizer is a browser application built around **PSDL** (Packet Schema
Definition Language). PSDL is the canonical schema format used by built-in presets,
imports, exports, and layout resolution.

The repository is organized around a few stable areas:

- `web/` — the Next.js application
- `data/presets/` — built-in PSDL presets
- `schemas/` — JSON Schema for PSDL documents
- `docs/` — architecture, testing, and PSDL authoring references

Useful starting points:

- [Architecture](./docs/architecture.md)
- [PSDL specification](./docs/psdl-0.4.md)
- [PSDL cheatsheet](./docs/psdl-cheatsheet.md)
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

For production build verification:

```sh
cd web
npm run build
```

`npm run build` creates the Cloudflare Workers artifact via OpenNext.
If you need to run only the raw Next.js build locally:

```sh
cd web
npm run build:next
```

Deploy to Cloudflare Workers:

```sh
cd web
npm run deploy
```

## Presets and supported formats

Built-in packet presets live in [`data/presets/`](./data/presets/). The preset
picker in the app is the source of truth for what is currently bundled.

Packet Schema Visualizer uses PSDL as its format hub and provides import/export bridges for
the formats supported by the current application. See the PSDL specification
for the up-to-date format notes and limitations.

### Adding a preset

Preset files are YAML documents under [`data/presets/`](./data/presets/).
They are validated against [`schemas/psdl.schema.json`](./schemas/psdl.schema.json)
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
