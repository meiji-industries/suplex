# The hosted service on Fly (see fly.toml): billing, accounts, and suplex.sh.
# It runs `suplex hosted serve`.
FROM rust:1.93.1-bookworm AS build
WORKDIR /suplex
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
# Cargo loads every workspace member's manifest and declared targets; only suplex is built.
COPY apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/
COPY apps/mobile/src-tauri/Cargo.toml apps/mobile/src-tauri/
COPY apps/bootstrap/Cargo.toml apps/bootstrap/
RUN mkdir -p apps/desktop/src-tauri/src apps/mobile/src-tauri/src apps/bootstrap/src \
    && touch apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/main.rs apps/mobile/src-tauri/src/lib.rs apps/mobile/src-tauri/src/main.rs apps/bootstrap/src/main.rs
COPY apps/server apps/server
COPY packages/exception-report packages/exception-report
COPY scripts/shared-resource-command.py scripts/
# The suplex.sh/start pages reuse the app login view's wordmark, art, and font.
COPY apps/web/assets/suplex-wordmark.svg apps/web/assets/account-background.png apps/web/assets/
COPY apps/web/fonts/InterTight-Variable.woff2 apps/web/fonts/
# The hosted service serves no app UI. A release build only checks that these entry files exist.
RUN mkdir -p apps/web/dist && touch apps/web/dist/suplex-ui.js apps/web/dist/suplex-ui.css
# Use the image's toolchain instead of letting rust-toolchain.toml install clippy and rustfmt on every build.
# Depot keeps the target cache mount, so incremental builds recompile only the changed parts of the suplex crate.
ENV RUSTUP_TOOLCHAIN=1.93.1 CARGO_INCREMENTAL=1
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/suplex/target \
    cargo build --release --locked -p suplex --bin suplex && cp target/release/suplex /usr/local/bin/suplex

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/suplex /usr/local/bin/suplex
CMD ["suplex", "hosted", "serve"]
