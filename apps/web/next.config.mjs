import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../");
dotenv.config({ path: resolve(root, ".env") });

/** @type {import('next').NextConfig} */
export default {
  outputFileTracingRoot: root,
  // `@copilot/shared` ships raw TypeScript on purpose -- the frontend consumes the

  // exact same zod schemas the API validates against, so a contract change is a
  // compile error here rather than a runtime surprise.
  transpilePackages: ["@copilot/shared"],
  reactStrictMode: true,
  webpack: (config) => {
    // `@copilot/shared` is a TS source tree with no build step, so its own relative
    // imports carry the `.js` suffix ESM requires -- `export * from "./forecast.js"`
    // in `packages/shared/src/index.ts`. Node and tsx resolve that against the sibling
    // `.ts` file (that's how `apps/api` consumes it, with no bundler leniency to lean
    // on), but webpack does not map it back on its own, even under
    // `transpilePackages`. Without this, the first runtime-value import of the package
    // from `apps/web` -- `CONVERSATION_HISTORY_MAX_TURNS` in `lib/insightsHistory.ts`
    // -- pulls `index.ts` into the module graph and the build dies with
    // "Module not found: Can't resolve './forecast.js'". Fixing it here rather than
    // dropping the extension in `packages/shared` keeps the backend's real ESM
    // resolution working.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};
