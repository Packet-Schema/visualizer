# Packet Schema Visualizer

[![tests](https://github.com/Packet-Schema/visualizer/actions/workflows/test.yml/badge.svg)](https://github.com/Packet-Schema/visualizer/actions/workflows/test.yml)

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
- `schemas/` — JSON Schema for PSDL documents
- `docs/` — architecture, the renderer contract, testing, and preset authoring

Useful starting points:

- [Architecture](./docs/architecture.md)
- [PSDL specification](https://github.com/Packet-Schema/core/blob/main/spec/psdl-0.5.md) (in `@packet-schema/core`)
- [Renderer contract](./docs/renderer-contract.md)
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

The 184 built-in packet presets ship as
[`@packet-schema/presets`](https://github.com/Packet-Schema/presets); the preset
picker in the app is the source of truth for what is currently bundled.

Packet Schema Visualizer uses PSDL as its format hub and provides import/export bridges for
the formats supported by the current application. See the PSDL specification
for the up-to-date format notes and limitations.

### Adding a preset

The YAML itself lives in the
[`presets`](https://github.com/Packet-Schema/presets) repository, where it is
validated against the PSDL 0.5 JSON Schema shipped by `@packet-schema/core`.
On this side, adding a preset means registering its key. See
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
