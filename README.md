# BUSY Bar Anim Preview

A VS Code extension that previews BUSY Bar `.anim` animation in a player.
Open any `.anim` file and it plays automatically.

## Features

- **Custom editor for `*.anim`** (default for the extension), read-only, themed
  with VS Code colors.
- **Plays the animation looped** in its native frame rate. Pauses when the tab is hidden.
- **Both container revisions**: `bicycle1` (masked interframe frames, raw / RLE /
  QOI-like pixels, 3 color formats) and the legacy `bicycle0` (full frames with
  per-frame durations).
- **Sections**: play the whole file or a specific anim section.
- **Controls**: play/pause, frame stepping, speed, zoom.
- **Keyboard**: `Space` play/pause, `←`/`→` step, `Home` restart, `+`/`-` zoom.
- **Live reload**: rebuilding the `.anim` on disk refreshes the open preview.
- **Commands**: *BUSY Bar Anim: Open Animation Preview* (also in the explorer and
  editor title context menus for `.anim` files) and
  *BUSY Bar Anim: Show Animation Info*, which opens a Markdown report of the
  header, sections and warnings.

### Settings

| Setting | Default | Description |
|---|---|---|
| `busybarAnim.autoplay` | `true` | Start playing on open. Ignored when the system asks for reduced motion. |
| `busybarAnim.background` | `checkerboard` | Background behind frames with transparency. |

## Development

```bash
npm install
npm run build      # bundle the extension, webview and decoder into dist/ and media/
```

Then press <kbd>F5</kbd> (*Run Extension*) and open any `.anim` file.

### Scripts

| Script | Purpose |
|---|---|
| `npm run build` | Minified production bundles (`dist/extension.js`, `media/preview.js`, …) |
| `npm run compile` | Fast development bundles with source maps |
| `npm run watch` | Rebuild on change (used by the F5 launch configuration) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Builds, then runs decoder + extension host tests |
| `npm run harness` | Generates `test/harness/preview.html`, a browser page that runs the webview imitating VS Code |
| `npm run render -- <file.anim> <out.png>` | Decodes to PNG for eyeballing; `--frame n` for a single frame, `--scale`, `--columns`, `--file-frames` |

The browser harness is useful for UI work (no Extension Host needed):

```bash
npm run harness
npx http-server . -p 8777
# open http://127.0.0.1:8777/test/harness/preview.html
```
