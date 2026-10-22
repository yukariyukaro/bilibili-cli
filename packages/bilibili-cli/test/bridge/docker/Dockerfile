# syntax=docker/dockerfile:1.7
#
# bilibili-cli TS × bridge Docker E2E (optional Linux isolation).
#
# Curated context: src/**/*.mts + tsconfig + compile/build/closure + cli shim +
# package*.json + docs/CHANGELOG + test/bridge. No repo root, sibling API repos,
# node_modules, .git, credentials, HOME, state or artifacts.
#
# Builder may use network for npm ci (including TypeScript). Runtime is
# --network none, --read-only, tmpfs /tmp, non-root and no host mounts.
# It runs the same test/bridge/offline.mjs build suite from an outside-repo cwd.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
# procps provides ps, used by lifecycle.mjs for POSIX process-tree checks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

FROM base AS cli-builder

WORKDIR /build/cli
COPY packages/bilibili-cli/package.json skills/bilibili-cli/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY packages/bilibili-cli/tsconfig.json ./
COPY packages/bilibili-cli/src ./src
COPY packages/bilibili-cli/cli ./cli
COPY packages/bilibili-cli/scripts ./scripts
COPY packages/bilibili-cli/CHANGELOG.md ./
COPY packages/bilibili-cli/SKILL.md skills/bilibili-cli/README.md skills/bilibili-cli/LICENSE ./
COPY packages/bilibili-cli/references ./references
COPY context-manifest.json /build/context-manifest.json

RUN node scripts/compile.mjs \
 && test -f dist/cli/bili.mjs \
 && test -f dist/lib/bridge/main.mjs \
 && mkdir -p /build/out \
 && npm pack --pack-destination /build/out --json > /build/pack.json \
 && node -e "const p=require('/build/pack.json')[0]; const paths=new Set(p.files.map(f=>f.path)); for (const f of ['dist/cli/bili.mjs','dist/lib/bridge/main.mjs','cli/bili.mjs','CHANGELOG.md']) if(!paths.has(f)){console.error('packed CLI missing '+f);process.exit(1)} if([...paths].some(x=>x.startsWith('src/')||x.startsWith('test/')||x.startsWith('scripts/')||x.startsWith('node_modules/')||x==='tsconfig.json')){console.error('packed CLI contains source/tooling');process.exit(1)}" \
 && npm install --global --prefix /opt/bilibili --ignore-scripts --no-audit --no-fund --prefer-offline /build/out/*.tgz \
 && test -x /opt/bilibili/bin/bilibili \
 && /opt/bilibili/bin/bilibili --version

FROM base AS runtime

ENV PATH="/opt/bilibili/bin:${PATH}" \
    HOME=/tmp \
    BILIBILI_E2E_MODE=docker \
    BILIBILI_E2E_CONTAINER=1 \
    BILIBILI_E2E_CLI_ROOT=/workspace/packages/bilibili-cli \
    BILIBILI_E2E_INSTALLED_PREFIX=/opt/bilibili \
    BILIBILI_E2E_MANIFEST=/workspace/context-manifest.json

WORKDIR /workspace

RUN ps -eo pid=,ppid= >/dev/null

COPY --from=cli-builder /opt/bilibili /opt/bilibili
COPY packages/bilibili-cli/test ./packages/bilibili-cli/test
COPY context-manifest.json /workspace/context-manifest.json

USER node

# The runner supplies --network none, --read-only, a tmpfs at /tmp and no mounts.
# Local WebSocket control-plane traffic uses 127.0.0.1 inside this namespace.
CMD ["node", "./packages/bilibili-cli/test/bridge/docker/container/entry.mjs"]
