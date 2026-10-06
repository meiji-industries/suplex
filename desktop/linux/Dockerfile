# The Linux desktop build environment: Ubuntu 22.04 (glibc 2.35, WebKitGTK 4.1), Rust, and the Tauri CLI.
# The packages run on Ubuntu 22.04, Debian 12, Fedora 36, and newer. scripts/build-desktop-linux.sh builds it.
# Python runs the shell tests' fixture host (--check).
FROM ubuntu:22.04

ARG RUST_VERSION=1.93.1
ARG NODE_VERSION=26.7.0
ARG TAURI_CLI_VERSION=2.12.1

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/node/bin:$PATH

RUN apt-get update && apt-get install --yes --no-install-recommends \
      build-essential ca-certificates curl file git perl pkg-config python3 rpm xz-utils \
      libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy --component rustfmt --default-toolchain "$RUST_VERSION" \
    && rustup target add "$(uname -m)-unknown-linux-gnu"

RUN case "$(uname -m)" in aarch64) node=arm64 ;; x86_64) node=x64 ;; esac \
    && mkdir -p /usr/local/node \
    && curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$node.tar.xz" | tar -xJ -C /usr/local/node --strip-components=1 \
    && npm install --global "@tauri-apps/cli@$TAURI_CLI_VERSION"

RUN git config --global --add safe.directory '*'
