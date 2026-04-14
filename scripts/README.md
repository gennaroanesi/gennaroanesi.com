# Scripts

## Media optimization

Helpers for preparing photos and videos before uploading to `s3://gennaroanesi.com/public/`. Both write output next to the input file as `<name>.web.<ext>` by default.

### `optimize-photo.mjs` — photo → web JPEG

Uses `sharp` (already installed as a Next.js dep, no extra setup). Resizes to max 2400px long edge, strips EXIF, progressive encoding with mozjpeg.

```bash
node scripts/optimize-photo.mjs <input> [output]
```

Examples:
```bash
node scripts/optimize-photo.mjs ~/Pictures/dolomiti.jpg
# → ~/Pictures/dolomiti.web.jpg (412 KB)

node scripts/optimize-photo.mjs input.jpg output.jpg
```

Settings baked in:

| Setting | Value | Why |
|---|---|---|
| Max size | 2400px long edge | Crisp on 5K displays under `object-cover`; not wasteful |
| Quality | 82 | Sweet spot — 80 is noticeably smaller, 85+ diminishing returns |
| Encoder | mozjpeg | ~10% smaller than stock libjpeg at same quality |
| Progressive | on | Renders blurry→sharp while loading |
| Chroma subsampling | 4:2:0 | Standard for photos |
| EXIF | stripped | Saves 50–200 KB, removes GPS metadata |
| Orientation | auto | Applies EXIF rotation so portraits aren't sideways |

Target file size: ~300–500 KB per photo.

### `optimize-video.sh` — video → web MP4

Uses `ffmpeg` (install with `sudo apt install ffmpeg`). Encodes H.264, strips audio, caps at 1080p / 30fps, fast-start for streaming playback.

```bash
./scripts/optimize-video.sh <input> [output] [crf]
```

Examples:
```bash
./scripts/optimize-video.sh "/path/to/clip.MOV"
# → /path/to/clip.web.mp4

./scripts/optimize-video.sh input.mov out.mp4
./scripts/optimize-video.sh input.mov out.mp4 28   # smaller file, lower quality
```

Settings baked in:

| Setting | Value | Why |
|---|---|---|
| Codec | H.264 (libx264) | Broadest browser autoplay support |
| CRF | 26 (default, arg 3 to override) | Good for hero loops; each +1 ≈ half the bitrate |
| Preset | slow | Better compression at encode time |
| Max size | 1920px wide (no upscale) | Enough for retina under `object-cover` |
| FPS | 30 | Caps source down if higher |
| Pixel format | yuv420p | Required for browser/iOS compatibility |
| Audio | stripped (`-an`) | Hero videos autoplay muted; saves ~10% |
| Fast start | `+faststart` | Playback begins before full download |

Target file size for a 1-minute clip: ~8–15 MB (CRF 26).

## Upload to S3

Both scripts produce files ready to drop into `s3://gennaroanesi.com/public/`. Anything under `public/*` is publicly readable via:

```
https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/<key>
```

(Path-style URL — virtual-hosted form is broken for this bucket due to the dot in the bucket name.)
