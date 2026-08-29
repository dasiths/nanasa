FROM mcr.microsoft.com/devcontainers/typescript-node:5-22-bookworm

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ARG COREPACK_NPM_REGISTRY=https://registry.npmjs.org/

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libnspr4 \
        libnss3 \
        libwayland-server0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxi6 \
        libxkbcommon0 \
        libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

ENV NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY}" \
    COREPACK_NPM_REGISTRY="${COREPACK_NPM_REGISTRY}"