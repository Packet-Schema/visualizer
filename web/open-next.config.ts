import {
  defineCloudflareConfig,
  type OpenNextConfig,
} from "@opennextjs/cloudflare";

const config: OpenNextConfig = {
  ...defineCloudflareConfig({}),
  // Workers Builds commonly runs `npm run build` as the build command and then
  // `wrangler deploy`. Since `npm run build` now creates the OpenNext bundle,
  // OpenNext itself must call the raw Next.js build command to avoid recursion.
  buildCommand: "npm run build:next",
};

export default config;
