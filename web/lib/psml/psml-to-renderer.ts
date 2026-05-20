// PSML ↔ renderer adapter (barrel).
//
// The historical single-file module was split into `psml-to-renderer/*`
// for responsibility-specific submodules. This barrel keeps the public
// import path (`@/lib/psml/psml-to-renderer`) intact so consumers don't
// need to change a thing.

export { psmlToRenderer, rendererToPsml } from "./psml-to-renderer/index";
