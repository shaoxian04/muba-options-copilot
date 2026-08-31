/** @type {import('next').NextConfig} */
export default {
  // `@copilot/shared` ships raw TypeScript on purpose -- the frontend consumes the
  // exact same zod schemas the API validates against, so a contract change is a
  // compile error here rather than a runtime surprise.
  transpilePackages: ["@copilot/shared"],
  reactStrictMode: true,
};
