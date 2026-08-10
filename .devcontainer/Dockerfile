FROM mcr.microsoft.com/devcontainers/typescript-node:5-22-bookworm

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ARG COREPACK_NPM_REGISTRY=https://registry.npmjs.org/
ARG TARGETARCH
ARG TTYD_VERSION=1.7.7

RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) ttyd_arch="x86_64" ;; \
        arm64) ttyd_arch="aarch64" ;; \
        *) echo "Unsupported ttyd architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    release_url="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}"; \
    curl --fail --location --silent --show-error \
        --output "/tmp/ttyd.${ttyd_arch}" "${release_url}/ttyd.${ttyd_arch}"; \
    curl --fail --location --silent --show-error \
        --output /tmp/ttyd-SHA256SUMS "${release_url}/SHA256SUMS"; \
    cd /tmp; \
    awk -v file="ttyd.${ttyd_arch}" '$2 == file { print $1, $2 }' \
        ttyd-SHA256SUMS > ttyd.sha256; \
    test -s ttyd.sha256; \
    sha256sum --check ttyd.sha256; \
    install --mode 0755 "ttyd.${ttyd_arch}" /usr/local/bin/ttyd; \
    rm -f "ttyd.${ttyd_arch}" ttyd-SHA256SUMS ttyd.sha256

ENV NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY}" \
    COREPACK_NPM_REGISTRY="${COREPACK_NPM_REGISTRY}"