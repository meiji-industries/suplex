# The Windows desktop build environment: cross-compiles the NSIS installer for x64 and arm64 from Linux with
# cargo-xwin (clang-cl and the Microsoft SDK), and signs it with jsign through Azure Trusted Signing.
# scripts/build-desktop-windows.sh builds it.
FROM ubuntu:24.04

ARG RUST_VERSION=1.93.1
ARG NODE_VERSION=26.7.0
ARG TAURI_CLI_VERSION=2.12.1
ARG CARGO_XWIN_VERSION=0.23.1
ARG JSIGN_VERSION=7.1

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/node/bin:$PATH

# libayatana-appindicator3-dev: the Tauri CLI panics on a Linux host without it, even for a Windows target.
RUN apt-get update && apt-get install --yes --no-install-recommends \
      build-essential ca-certificates curl file git perl pkg-config xz-utils unzip \
      clang lld llvm nsis libssl-dev libayatana-appindicator3-dev default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy --default-toolchain "$RUST_VERSION" \
    && rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc

RUN case "$(uname -m)" in aarch64) node=arm64 ;; x86_64) node=x64 ;; esac \
    && mkdir -p /usr/local/node \
    && curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$node.tar.xz" | tar -xJ -C /usr/local/node --strip-components=1 \
    && npm install --global "@tauri-apps/cli@$TAURI_CLI_VERSION"

RUN cargo install --locked cargo-xwin --version "$CARGO_XWIN_VERSION"

RUN curl -fsSL -o /tmp/jsign.deb "https://github.com/ebourg/jsign/releases/download/$JSIGN_VERSION/jsign_${JSIGN_VERSION}_all.deb" \
    && dpkg -i /tmp/jsign.deb && rm /tmp/jsign.deb

# ring compiles its C code with plain clang on Windows arm64 (its build.rs does not treat clang-cl as clang),
# while cargo-xwin passes clang-cl flags to it. This clang rewrites /imsvc to -isystem; invoked as clang-cl it
# stays in clang-cl mode, which cargo-xwin and the resource compiler need.
RUN ln -s /usr/bin/clang /opt/clang-cl \
    && printf '%s\n' '#!/bin/sh' \
      'case "$(basename "$0")" in clang-cl) exec /opt/clang-cl "$@" ;; esac' \
      'for a; do shift; [ "$a" = /imsvc ] && a=-isystem; set -- "$@" "$a"; done' \
      'exec /usr/bin/clang "$@"' > /usr/local/bin/clang \
    && chmod +x /usr/local/bin/clang \
    && ln -s /usr/local/bin/clang /usr/local/bin/clang-cl

RUN git config --global --add safe.directory '*'
