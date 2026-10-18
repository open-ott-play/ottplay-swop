#!/usr/bin/env bash
# Project existing screenshots without redrawing application content.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v magick >/dev/null 2>&1 || { printf '%s\n' 'ImageMagick 7 (magick) is required.' >&2; exit 1; }
render_dir="$(mktemp -d "${TMPDIR:-/tmp}/ottplay-hero.XXXXXX")"
trap 'rm -rf -- "$render_dir"' EXIT
source_image="$repo_root/docs/images/swop-entry.jpg"
output_image="$repo_root/docs/images/hero.png"
[[ "$(magick identify -format '%wx%h' "$source_image")" == '432x768' ]] || { printf '%s\n' 'Review the projection: screenshot dimensions changed.' >&2; exit 1; }
magick "$source_image" -alpha on \
  \( -size 432x768 xc:none -fill white -draw 'roundrectangle 0,0 431,767 20,20' \) \
  -compose DstIn -composite -compose Over \
  -virtual-pixel transparent -filter Robidoux -define distort:viewport=950x1050+0+0 \
  -distort Perspective '0,0 185,145 431,0 685,75 431,767 745,885 0,767 245,975' \
  -strip "$render_dir/panel.png"
magick "$render_dir/panel.png" -fill '#111827' -colorize 100 \
  -channel A -evaluate multiply 0.26 +channel -blur 0x20 -strip "$render_dir/shadow.png"
magick -size 950x1050 xc:'#edf1f3' \
  "$render_dir/shadow.png" -geometry +0+24 -compose Over -composite \
  "$render_dir/panel.png" -geometry +0+0 -compose Over -composite \
  -strip -define png:exclude-chunk=date,time "PNG24:$render_dir/hero.png"
mv -- "$render_dir/hero.png" "$output_image"
printf 'Rendered %s\n' "$output_image"
