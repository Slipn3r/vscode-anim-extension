export interface PreviewHtmlOptions {
  scriptUri: string;
  styleUri: string;
  cspSource?: string;
  nonce?: string;
  beforeScript?: string;
}

const ICONS: Record<string, string> = {
  play: '<path d="M4.5 2.5 13 8l-8.5 5.5z"/>',
  pause: '<path d="M4.6 2.5h2.8v11H4.6zM8.9 2.5h2.8v11H8.9z"/>',
  prev: '<path d="M3 2.5h1.6v11H3z"/><path d="M12.4 2.5v11L4.8 8z"/>',
  next: '<path d="M11.4 2.5H13v11h-1.6z"/><path d="M3.6 2.5v11L11.2 8z"/>',
};

function iconButton(id: string, title: string, icons: readonly string[]): string {
  const svg = icons
    .map(name => `<svg class="icon-${name}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`)
    .join('');
  return `<button id="${id}" class="icon" data-state="paused" title="${title}" aria-label="${title}">${svg}</button>`;
}

export function renderPreviewHtml(options: PreviewHtmlOptions): string {
  const { scriptUri, styleUri, cspSource, nonce, beforeScript = '' } = options;

  const csp = cspSource
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`
    : '';
  const nonceAttribute = cspSource ? ` nonce="${nonce}"` : '';

  const speeds = [0.25, 0.5, 1, 2, 4]
    .map(value => `<option value="${value}"${value === 1 ? ' selected' : ''}>${value}\u00d7</option>`)
    .join('');

  const backgrounds = [
    ['checkerboard', 'Checkerboard'],
    ['black', 'Black'],
    ['white', 'White'],
  ]
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  ${csp}
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Animation Preview</title>
  <script${nonceAttribute}>
    window.addEventListener('error', function (event) {
      var box = document.getElementById('error');
      var message = document.getElementById('error-message');
      if (box && message) {
        message.textContent = 'Preview failed to start: ' + (event.message || String(event.error));
        box.hidden = false;
      }
    });
  </script>
</head>
<body>
  <div id="toolbar" class="toolbar" hidden>
    <div class="group">
      ${iconButton('play', 'Click to play', ['play', 'pause'])}
      ${iconButton('prev', 'Previous frame (Left arrow)', ['prev'])}
      ${iconButton('next', 'Next frame (Right arrow)', ['next'])}
    </div>
    <div class="group">
      <label for="section">Section</label>
      <select id="section"></select>
    </div>
    <div class="group">
      <label for="speed">Speed</label>
      <select id="speed">${speeds}</select>
    </div>
    <div class="group">
      <label>Zoom</label>
      <button id="zoom-out" title="Zoom out (-)">\u2212</button>
      <button id="zoom-fit" title="Fit to window">Fit</button>
      <button id="zoom-in" title="Zoom in (+)">+</button>
    </div>
    <div class="group">
      <label for="background">Background</label>
      <select id="background">${backgrounds}</select>
    </div>
    <div class="spacer"></div>
    <div class="group readout">
      <span id="counter">\u2014</span>
      <span id="clock"></span>
    </div>
  </div>
  <div id="warnings" class="warnings" hidden></div>
  <div id="viewport">
    <div id="stage" data-background="checkerboard" hidden>
      <canvas id="canvas" width="1" height="1"></canvas>
    </div>
  </div>
  <div id="meta" class="meta" hidden></div>
  <div id="error" class="error" hidden>
    <h2>Cannot preview this file</h2>
    <p id="error-message"></p>
    <button id="retry">Try again</button>
  </div>
  ${beforeScript}
  <script${nonceAttribute} src="${scriptUri}"></script>
</body>
</html>`;
}
