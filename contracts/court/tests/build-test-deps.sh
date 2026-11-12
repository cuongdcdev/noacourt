#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for package_dir in "$project_dir" "$project_dir/test-stubs/mock-noa" "$project_dir/test-stubs/mock-outlayer"; do
    (cd "$package_dir" && cargo near build non-reproducible-wasm)
done
