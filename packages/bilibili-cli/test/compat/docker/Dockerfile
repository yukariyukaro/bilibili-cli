# syntax=docker/dockerfile:1.7
#
# bilibili-cli Node/npm 兼容矩阵镜像。
#
# 构建期（联网）：用目标 Node 镜像自带的 npm（或 --build-arg NPM_VERSION 指定的版本）
#   对 release-source 执行 npm pack + npm install --global --prefix，证明该版本能装。
# 运行期（--network none）：只跑公开命令契约（version/doctor/schema/skills），
#   断言逻辑复用 compat/lib/combo.mjs，与 native 模式同一份标准。
#
# 构建上下文由 test/compat/run.mjs 生成：release-source/、release-package.json、
# release/lib/（子进程捕获工具）、compat/（本套件代码）。
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ARG NPM_VERSION=

RUN npm config set update-notifier false \
 && npm config set fund false \
 && npm config set audit false \
 && if [ -n "${NPM_VERSION}" ] && [ "${NPM_VERSION}" != "current" ]; then npm install --global "npm@${NPM_VERSION}"; fi

# 版本事实写进镜像，供运行期入口与报告引用；任何一次安装后都必须能读到。
RUN node --version > /opt/node-version.txt \
 && npm --version > /opt/npm-version.txt \
 && cat /opt/node-version.txt /opt/npm-version.txt

WORKDIR /opt/compat
COPY release-source /opt/compat/release-source
COPY release-package.json /opt/compat/release-package.json

# 用镜像内的 npm 真实打包与安装；安装期不执行任何脚本。
RUN mkdir -p /opt/compat/pack \
 && npm pack /opt/compat/release-source --pack-destination /opt/compat/pack --json > /opt/compat/pack/pack.json \
 && TARBALL="$(node -p "require('/opt/compat/pack/pack.json')[0].filename")" \
 && npm install --global --prefix /opt/bilibili --ignore-scripts --no-audit --no-fund "/opt/compat/pack/${TARBALL}" \
 && test -x /opt/bilibili/bin/bilibili \
 && /opt/bilibili/bin/bilibili --version

COPY release/lib /opt/release/lib
COPY compat/lib /opt/compat/lib
COPY compat/docker/entry.mjs /opt/compat/docker/entry.mjs

ENV PATH="/opt/bilibili/bin:${PATH}" \
    HOME=/tmp \
    BILIBILI_COMPAT_ROOT=/opt/compat \
    BILIBILI_COMPAT_PREFIX=/opt/bilibili \
    npm_config_update_notifier=false

USER node

# 运行方提供 --network none / --read-only / tmpfs /tmp；本镜像不自行放宽。
CMD ["node", "/opt/compat/docker/entry.mjs"]
