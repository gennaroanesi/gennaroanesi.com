#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <input> [output] [crf]"
  echo "  crf default: 26 (lower = higher quality, larger file; try 24-30)"
  exit 1
fi

in="$1"
out="${2:-${in%.*}.web.mp4}"
crf="${3:-26}"

ffmpeg -hide_banner -loglevel error -stats -y \
  -i "$in" \
  -c:v libx264 -preset slow -crf "$crf" \
  -vf "scale='min(1920,iw)':-2,fps=30" \
  -pix_fmt yuv420p -an -movflags +faststart \
  "$out"

size=$(du -h "$out" | cut -f1)
echo "$out ($size)"
