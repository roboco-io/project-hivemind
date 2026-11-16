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
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl util-linux bubblewrap socat python3 build-essential cmake ninja-build clang && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.166.0 @anthropic-ai/claude-code@2.1.319 @earendil-works/pi-coding-agent@0.87.1 && npm cache clean --force
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://github.com/Orange-OpenSource/hurl/releases/download/8.0.1/hurl_8.0.1_amd64.deb -o /tmp/hurl.deb \
 && echo "e76e6c0957f83f9b761416452871554d0f068384b6cd004bff82dd8795c62225  /tmp/hurl.deb" | sha256sum -c - \
 && apt-get update && apt-get install -y --no-install-recommends /tmp/hurl.deb \
 && rm /tmp/hurl.deb && rm -rf /var/lib/apt/lists/*
COPY --chown=0:0 backend/benchmark/agent/ /opt/hivemind/backend/benchmark/agent/
COPY --chown=0:0 --chmod=0755 backend/benchmark/pi-shell /opt/hivemind/backend/benchmark/pi-shell

WORKDIR /opt/hivemind
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY backend/src ./backend/src
COPY backend/runtime-build.json ./backend/runtime-build.json
COPY scripts/phase0/auth-envelope.ts scripts/phase0/claude-agent-hook.ts scripts/phase0/claude-receipts.ts scripts/phase0/native-thread-receipts.ts scripts/phase0/rollout-receipts.ts scripts/phase0/mcp-server.ts ./scripts/phase0/
RUN mkdir /runtime /workspace && chown node:node /runtime /workspace
COPY --from=proc-guard-build /build/proc-guard /opt/hivemind/bin/proc-guard
COPY --from=proc-guard-build /build/namespace-probe /opt/hivemind/bin/namespace-probe
COPY --from=proc-guard-build /build/namespace-guard /opt/hivemind/bin/namespace-guard
COPY backend/config/claude-managed-settings.json /etc/claude-code/managed-settings.json
COPY --from=bubblewrap-compat-build --chown=0:0 --chmod=0755 /artifacts/bin/bwrap /opt/hivemind/compat-bin/bwrap
COPY --from=bubblewrap-compat-build --chown=0:0 /artifacts/bubblewrap-source/ /usr/share/hivemind/bubblewrap-source/

USER node
WORKDIR /workspace
EXPOSE 3000
CMD ["setpriv", "--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "node", "/opt/hivemind/backend/src/runtime/bootstrap.ts"]
