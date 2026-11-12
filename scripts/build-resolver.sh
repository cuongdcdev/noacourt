#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

cargo_registry_root="${CARGO_HOME:-$HOME/.cargo}"
cargo_registry_root="$(cd "$cargo_registry_root" && pwd -P)"
rust_sysroot="$(rustc +1.96.0 --print sysroot)"
export RUSTFLAGS="--remap-path-prefix=$repo_root=/src --remap-path-prefix=$cargo_registry_root=/cargo --remap-path-prefix=$rust_sysroot=/rustup"

cargo +1.96.0 build -p resolver --target wasm32-wasip2 --release --locked
artifact="target/wasm32-wasip2/release/resolver.wasm"
sha="$(sha256sum "$artifact" | awk '{print $1}')"
printf '%s\n' "$sha" > resolver/WASM_SHA256
printf 'WASM: %s\nSHA256: %s\n' "$artifact" "$sha"
