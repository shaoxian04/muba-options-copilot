# The Fastify backend.
#
# Runs under tsx rather than a compiled build, which is what `npm run dev` already does
# and what the repo is set up for -- there is no build step to reproduce here, and adding
# one under a deployment ticket would be a second way to run the same code.
#
# Node 22 to match .github/workflows/ci.yml, so what CI proves and what runs are the same
# runtime.
FROM node:22-slim

# tini, so SIGTERM actually reaches Node as PID 1. Without it the graceful shutdown in
# server.ts never runs and every deploy kills in-flight requests -- which on this app can
# mean an /fill/settle waiting on a receipt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first, so a dependency install is cached across code changes. The workspace
# packages' own manifests are needed for `npm ci` to resolve the workspace graph at all.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# --ignore-scripts: nothing here needs a postinstall, and running arbitrary ones in an
# image that will hold an RPC key is not a trade worth making.
RUN npm ci --ignore-scripts

COPY packages/shared packages/shared
COPY apps/api apps/api

ENV NODE_ENV=production
# Bind to every interface INSIDE the container -- the container is not the network
# boundary here, the reverse proxy in front of it is. server.ts refuses this unless
# EXTERNAL_AUTH_IN_FRONT is set, which is deliberate: see the compose file, where Caddy is
# what makes that true.
ENV HOST=0.0.0.0
ENV PORT=3001

# Never root. This process holds an RPC key and, in a custodial deployment, could hold a
# signing key.
USER node

EXPOSE 3001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start", "-w", "@copilot/api"]
