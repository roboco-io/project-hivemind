FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY apps ./apps
COPY packages ./packages
RUN npm run build && npm prune --omit=dev

FROM node:24.14.0-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/dashboard/public ./apps/dashboard/public
COPY --chown=node:node package.json ./
COPY --chown=node:node cloudflare/backend/package.json ./cloudflare/backend/
COPY --chown=node:node cloudflare/backend/src/client.ts cloudflare/backend/src/files.ts cloudflare/backend/src/snapshot.ts cloudflare/backend/src/scheduler.ts cloudflare/backend/src/contracts.ts ./cloudflare/backend/src/
COPY --chown=node:node cloudflare/backend/src/runtime/claude-bash-hook.ts ./cloudflare/backend/src/runtime/
RUN mkdir data && chown node:node data
USER node
EXPOSE 4310
CMD ["node", "dist/apps/control-plane/src/main.js"]
