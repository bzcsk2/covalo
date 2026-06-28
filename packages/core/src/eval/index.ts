export * from "./types.js";
export * from "./registry.js";
export * from "./loader.js";
export * from "./workspace.js";
export * from "./verifier.js";
export * from "./runner.js";
export * from "./report.js";
export { registerBuiltinManifests } from "./loader.js";
export { ALL_MANIFESTS } from "./fixtures/index.js";
export { getRealManifests } from "./generated/manifests.js";
export { getRealCategories } from "./generated/registry.js";

import { registerBuiltinManifests } from "./loader.js";
import { ALL_MANIFESTS } from "./fixtures/index.js";
import { getRealManifests } from "./generated/manifests.js";
import { refreshRegistry } from "./registry.js";

registerBuiltinManifests(ALL_MANIFESTS);

const realManifests = getRealManifests();
if (realManifests.length > 0) {
  registerBuiltinManifests(realManifests);
  refreshRegistry();
}
