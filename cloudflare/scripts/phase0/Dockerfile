FROM node:24.14.0-bookworm-slim AS bubblewrap-compat-build
RUN sed -i 's/Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends build-essential meson ninja-build pkg-config libcap-dev libselinux1-dev dpkg-dev patch xz-utils
COPY backend/native/build-bubblewrap-compat.sh backend/native/bubblewrap-nested-proc.patch backend/native/BUBBLEWRAP-NOTICE.md /build-input/
COPY docs/bubblewrap-compatibility.md /build-input/bubblewrap-compatibility.md
COPY backend/Dockerfile /build-input/Dockerfile.backend
COPY scripts/phase0/Dockerfile /build-input/Dockerfile.phase0
RUN sh /build-input/build-bubblewrap-compat.sh

FROM node:24.14.0-bookworm-slim AS proc-guard-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev
COPY backend/native/proc-guard.c /build/proc-guard.c
COPY backend/native/namespace-probe.c /build/namespace-probe.c
COPY backend/native/namespace-guard.c /build/namespace-guard.c
RUN gcc -std=c11 -O2 -Wall -Wextra -Werror /build/proc-guard.c -o /build/proc-guard && gcc -std=c11 -O2 -Wall -Wextra -Werror /build/namespace-probe.c -o /build/namespace-probe && gcc -std=c11 -O2 -Wall -Wextra -Werror /build/namespace-guard.c -o /build/namespace-guard

FROM node:24.14.0-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git curl util-linux bubblewrap socat \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global \
      @openai/codex@0.166.0 @anthropic-ai/claude-code@2.1.319 @anthropic-ai/sandbox-runtime@0.0.81 \
    && npm cache clean --force \
    && mkdir /workspace \
    && chown node:node /workspace

RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/* && mkdir /runtime && chown node:node /runtime

WORKDIR /opt/hivemind
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node scripts/phase0/mcp-server.ts scripts/phase0/mcp-server.ts
COPY --chown=node:node scripts/phase0/auth-envelope.ts scripts/phase0/auth-envelope.ts
COPY --chown=node:node scripts/phase0/codex-probe.ts scripts/phase0/codex-probe.ts
COPY --chown=node:node scripts/phase0/rollout-receipts.ts scripts/phase0/rollout-receipts.ts
COPY --chown=node:node scripts/phase0/native-thread-receipts.ts scripts/phase0/native-thread-receipts.ts
COPY --chown=node:node scripts/phase0/claude-probe.ts scripts/phase0/claude-probe.ts
COPY --chown=node:node scripts/phase0/claude-agent-hook.ts scripts/phase0/claude-agent-hook.ts
COPY --chown=node:node scripts/phase0/claude-receipts.ts scripts/phase0/claude-receipts.ts
COPY --chown=node:node scripts/phase0/check-claude-boundary.ts scripts/phase0/check-claude-boundary.ts
COPY --chown=node:node scripts/phase0/claude-boundary-probe.ts scripts/phase0/claude-boundary-probe.ts
COPY --chown=node:node scripts/phase0/codex-boundary-probe.ts scripts/phase0/codex-boundary-probe.ts
COPY --chown=node:node scripts/phase0/landlock-probe.ts scripts/phase0/landlock-probe.ts
COPY --chown=node:node scripts/phase0/claude-codex-layer-probe.ts scripts/phase0/claude-codex-layer-probe.ts
COPY --chown=node:node scripts/phase0/compute-stdio-probe.ts scripts/phase0/compute-stdio-probe.ts
COPY --chown=node:node scripts/phase0/claude-command-concurrency-probe.ts scripts/phase0/claude-command-concurrency-probe.ts
COPY backend/src/contracts.ts backend/src/snapshot.ts ./backend/src/
COPY backend/runtime-build.json ./backend/runtime-build.json
COPY backend/src/runtime/providers.ts backend/src/runtime/claude-bash-hook.ts backend/src/runtime/process.ts backend/src/runtime/compute-sandbox.ts backend/src/runtime/claude-command-guard.ts backend/src/runtime/claude-guard-policy.ts ./backend/src/runtime/
COPY --chown=node:node scripts/phase0/run-bounded.ts scripts/phase0/run-bounded.ts
COPY --chown=node:node tests/phase0-mcp.test.ts tests/phase0-mcp.test.ts

COPY --from=proc-guard-build /build/proc-guard /opt/hivemind/bin/proc-guard
COPY --from=proc-guard-build /build/namespace-probe /opt/hivemind/bin/namespace-probe
COPY --from=proc-guard-build /build/namespace-guard /opt/hivemind/bin/namespace-guard
COPY backend/config/claude-managed-settings.json /etc/claude-code/managed-settings.json
COPY --from=bubblewrap-compat-build --chown=0:0 --chmod=0755 /artifacts/bin/bwrap /opt/hivemind/compat-bin/bwrap
COPY --from=bubblewrap-compat-build --chown=0:0 /artifacts/bubblewrap-source/ /usr/share/hivemind/bubblewrap-source/

USER node
WORKDIR /workspace

# No credentials or source checkout are included in this feasibility image.
CMD ["sh", "-ec", "id -u; node --version; codex --version; claude --version; node --test /opt/hivemind/tests/phase0-mcp.test.ts"]
