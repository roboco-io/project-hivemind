FROM node:24.14.0-bookworm-slim AS proc-guard-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev
COPY backend/native/proc-guard.c /build/proc-guard.c
COPY backend/native/namespace-probe.c /build/namespace-probe.c
COPY backend/native/namespace-guard.c /build/namespace-guard.c
RUN gcc -std=c11 -O2 -Wall -Wextra -Werror /build/proc-guard.c -o /build/proc-guard && gcc -std=c11 -O2 -Wall -Wextra -Werror /build/namespace-probe.c -o /build/namespace-probe && gcc -std=c11 -O2 -Wall -Wextra -Werror /build/namespace-guard.c -o /build/namespace-guard

FROM node:24.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl util-linux bubblewrap socat && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.166.0 @anthropic-ai/claude-code@2.1.319 && npm cache clean --force
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/hivemind
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY backend/src ./backend/src
COPY scripts/phase0/auth-envelope.ts scripts/phase0/claude-agent-hook.ts scripts/phase0/claude-receipts.ts scripts/phase0/native-thread-receipts.ts scripts/phase0/rollout-receipts.ts scripts/phase0/mcp-server.ts ./scripts/phase0/
RUN mkdir /runtime /workspace && chown node:node /runtime /workspace
COPY --from=proc-guard-build /build/proc-guard /opt/hivemind/bin/proc-guard
COPY --from=proc-guard-build /build/namespace-probe /opt/hivemind/bin/namespace-probe
COPY --from=proc-guard-build /build/namespace-guard /opt/hivemind/bin/namespace-guard
COPY backend/config/claude-managed-settings.json /etc/claude-code/managed-settings.json

USER node
WORKDIR /workspace
EXPOSE 3000
CMD ["setpriv", "--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "node", "/opt/hivemind/backend/src/runtime/bootstrap.ts"]
