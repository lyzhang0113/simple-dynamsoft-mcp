#!/usr/bin/env bash
# Seed a RAG cache directory with the vectors from the latest published
# release, so the next build embeds only chunks whose text changed.
#
#   scripts/seed-rag-cache.sh <cache-dir>
#
# Needs `gh` with GH_TOKEN. Skips (exit 0) when the directory already holds a
# vector file or no release asset exists; a seed is an optimization only.
set -euo pipefail

cache_dir="${1:?usage: seed-rag-cache.sh <cache-dir>}"
repo="${GITHUB_REPOSITORY:-yushulx/simple-dynamsoft-mcp}"
mkdir -p "$cache_dir"

if compgen -G "$cache_dir/rag-gemini-*.f32" > /dev/null; then
  echo "[seed] $cache_dir already has vectors; not seeding"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if ! gh release download --repo "$repo" --pattern 'prebuilt-rag-index-gemini-*.tar.gz' --dir "$work" 2>"$work/err.log"; then
  echo "[seed] no previous release index available: $(tr '\n' ' ' < "$work/err.log")"
  exit 0
fi

archive="$(find "$work" -maxdepth 1 -name 'prebuilt-rag-index-gemini-*.tar.gz' | head -n 1)"
mkdir -p "$work/extract"
tar -xzf "$archive" -C "$work/extract"
copied=0
while IFS= read -r file; do
  cp "$file" "$cache_dir/"
  copied=$((copied + 1))
done < <(find "$work/extract" -type f -name 'rag-gemini-*' ! -name '*.checkpoint.*')
echo "[seed] copied $copied file(s) from $(basename "$archive") into $cache_dir"
