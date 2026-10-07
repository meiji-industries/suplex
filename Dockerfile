# The hosted service on Fly (see fly.toml): billing, accounts, and suplex.sh.
# It runs `suplex hosted serve`.
FROM rust:1.93.1-bookworm AS build
WORKDIR /suplex
COPY rust rust
COPY migrations migrations
COPY scripts/shared-resource-command.py scripts/
# Compiled into the binary and served at /install.sh and /install.ps1.
COPY src/web/public/install.sh src/web/public/install.ps1 src/web/public/
# The hosted service serves no app UI. A release build only checks that these entry files exist.
RUN mkdir -p dist/web && touch dist/web/suplex-ui.js dist/web/suplex-ui.css
# Use the image's toolchain instead of letting rust-toolchain.toml install clippy and rustfmt on every build.
# Depot keeps the target cache mount, so incremental builds recompile only the changed parts of the suplex crate.
ENV RUSTUP_TOOLCHAIN=1.93.1 CARGO_INCREMENTAL=1
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/suplex/rust/target \
    cd rust && cargo build --release --locked --bin suplex && cp target/release/suplex /usr/local/bin/suplex

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/suplex /usr/local/bin/suplex
CMD ["suplex", "hosted", "serve"]
