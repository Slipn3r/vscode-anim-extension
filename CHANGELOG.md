# Changelog

## 0.1.0

- Custom editor for `.anim` files: decodes and plays the animation, looped, on a
  canvas with nearest-neighbour scaling.
- Supports both container revisions: `bicycle1` (masked interframe frames with
  raw/RLE/QOI-like pixel data) and the legacy `bicycle0` (full frames with
  per-frame durations).
- Toolbar with play/pause, frame stepping, section selection, playback speed,
  zoom (fit or integer steps) and background choice.
- Keyboard shortcuts: `Space`, `←`, `→`, `Home`, `+`, `-`.
- Status line with dimensions, frame rate, frame counts, colour format, container
  revision and file size; recoverable format deviations are surfaced as warnings.
- Live reload when the file changes on disk.
- Commands: **Open Animation Preview** and **Show Animation Info**.
- Settings: `busybarAnim.autoplay`, `busybarAnim.background`.
