#!/usr/bin/env bash
set -euo pipefail

: "${MALIANG_NANOCHAT_IMAGE_REF:?Set this to a registry tag you can push, e.g. ghcr.io/<owner>/maliang-nanochat-gpu:2026-07-25}"

image_dir=$(cd "$(dirname "$0")" && pwd)
docker buildx build --platform linux/amd64 --push --tag "$MALIANG_NANOCHAT_IMAGE_REF" "$image_dir"
digest=$(docker buildx imagetools inspect "$MALIANG_NANOCHAT_IMAGE_REF" --format '{{.Digest}}')
printf 'export MALIANG_MODAL_BASE_IMAGE=%s@%s\n' "${MALIANG_NANOCHAT_IMAGE_REF%@*}" "$digest"
