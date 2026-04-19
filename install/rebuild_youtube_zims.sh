#!/bin/bash

# Rebuilds all YouTube channel ZIMs from existing raw downloaded content.
# Use this after a template update or when channel ZIMs need to be regenerated.
# Raw video data in storage/youtube-raw is NOT affected.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"

RAW_DIR="$INSTALL_DIR/storage/youtube-raw"
ZIM_DIR="$INSTALL_DIR/storage/zim"
IMAGE="ghcr.io/flynnty/project-nomad-youtube-builder:latest"

echo "Install path: $INSTALL_DIR"
echo "Raw content:  $RAW_DIR"
echo "ZIM output:   $ZIM_DIR"
echo ""

if [ ! -d "$RAW_DIR/channels" ]; then
  echo "ERROR: No channels found at $RAW_DIR/channels"
  echo "Have you downloaded any YouTube channels through the admin yet?"
  exit 1
fi

echo "Pulling latest youtube-builder image..."
docker pull "$IMAGE"

echo ""
echo "Deleting existing channel ZIMs..."
rm -f "$ZIM_DIR"/youtube_channel_*.zim

echo "Rebuilding channel ZIMs from raw content..."
docker run --rm \
  -v "$RAW_DIR":/raw \
  -v "$ZIM_DIR":/zim \
  "$IMAGE" \
  --rebuild-only \
  --raw-dir /raw \
  --zim-dir /zim

echo ""
echo "Done. Go to Admin UI -> Settings -> Content Manager -> Rebuild Library"
