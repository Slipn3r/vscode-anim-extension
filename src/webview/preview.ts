import {
  buildTimeline,
  decodeAnimation,
  expandTimeline,
  frameDurationMs,
  formatAnimationInfo,
  type DecodedAnimation,
  type TimelineStep,
} from '../animFile';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
};

interface PersistedState {
  section?: string;
  speed?: number;
  zoom?: number | 'fit';
  background?: string;
}

interface LoadMessage {
  type: 'load';
  fileName: string;
  data: string;
  mtime: number;
  autoplay: boolean;
  background: string;
  settings?: PersistedState;
}

interface ErrorMessage {
  type: 'error';
  fileName: string;
  message: string;
}

type IncomingMessage = LoadMessage | ErrorMessage;

const vscode = acquireVsCodeApi();

const ZOOM_STEPS = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32];
const BACKGROUNDS = ['checkerboard', 'black', 'white'];

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const ui = {
  stage: element<HTMLDivElement>('stage'),
  viewport: element<HTMLDivElement>('viewport'),
  canvas: element<HTMLCanvasElement>('canvas'),
  error: element<HTMLDivElement>('error'),
  errorMessage: element<HTMLParagraphElement>('error-message'),
  retry: element<HTMLButtonElement>('retry'),
  warnings: element<HTMLDivElement>('warnings'),
  play: element<HTMLButtonElement>('play'),
  prev: element<HTMLButtonElement>('prev'),
  next: element<HTMLButtonElement>('next'),
  section: element<HTMLSelectElement>('section'),
  speed: element<HTMLSelectElement>('speed'),
  background: element<HTMLSelectElement>('background'),
  zoomOut: element<HTMLButtonElement>('zoom-out'),
  zoomIn: element<HTMLButtonElement>('zoom-in'),
  zoomFit: element<HTMLButtonElement>('zoom-fit'),
  counter: element<HTMLSpanElement>('counter'),
  clock: element<HTMLSpanElement>('clock'),
  meta: element<HTMLElement>('meta'),
  toolbar: element<HTMLDivElement>('toolbar'),
};

function requireContext(): CanvasRenderingContext2D {
  const found = ui.canvas.getContext('2d', { alpha: true });
  if (!found) throw new Error('Unable to obtain a 2D canvas context');
  return found;
}

const context = requireContext();

let animation: DecodedAnimation | null = null;
let images: ImageData[] = [];
let steps: TimelineStep[] = [];
let sequence: number[] = [];
let position = 0;
let playing = false;
let speed = 1;
let zoom: number | 'fit' = 'fit';
let background = 'checkerboard';
let elapsedInFrame = 0;
let lastTimestamp = 0;
let rafId: number | null = null;
let autoplay = true;

const persisted = vscode.getState() ?? {};

function persist(): void {
  vscode.setState({
    section: ui.section.value,
    speed,
    zoom,
    background,
  });
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toImageData(rgba: Uint8ClampedArray, width: number, height: number): ImageData {
  const image = new ImageData(width, height);
  image.data.set(rgba);
  return image;
}

function load(message: LoadMessage): void {
  const settings: PersistedState = { ...message.settings, ...persisted };
  autoplay = message.autoplay;
  speed = normaliseSpeed(settings.speed ?? speed);
  background = BACKGROUNDS.includes(settings.background ?? '') ? settings.background! : message.background;
  zoom = settings.zoom === 'fit' || typeof settings.zoom === 'number' ? settings.zoom : 'fit';

  let decoded: DecodedAnimation;
  try {
    decoded = decodeAnimation(base64ToBytes(message.data));
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    return;
  }

  animation = decoded;
  images = decoded.frames.map(frame => toImageData(frame.rgba, decoded.width, decoded.height));

  ui.canvas.width = decoded.width;
  ui.canvas.height = decoded.height;
  ui.canvas.style.width = `${decoded.width}px`;
  ui.canvas.style.height = `${decoded.height}px`;
  context.imageSmoothingEnabled = false;

  ui.error.hidden = true;
  ui.toolbar.hidden = false;
  ui.stage.hidden = false;

  populateSections(decoded, settings.section);
  applyZoom();
  renderWarnings(decoded.warnings);
  updateMeta(decoded, message.fileName);

  ui.speed.value = String(speed);
  ui.background.value = background;
  ui.stage.dataset.background = background;

  position = 0;
  elapsedInFrame = 0;
  render();

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  setPlaying(autoplay && !reduceMotion && sequence.length > 1);
  persist();
}

function populateSections(decoded: DecodedAnimation, selected?: string): void {
  ui.section.textContent = '';

  const all = document.createElement('option');
  all.value = 'default';
  all.textContent = `Entire animation (${decoded.displayFrameCount} frames)`;
  ui.section.append(all);

  for (const section of decoded.sections) {
    if (section.name === 'default') continue;
    const option = document.createElement('option');
    option.value = section.name;
    option.textContent = `${section.name} (${section.start}..${section.end})`;
    ui.section.append(option);
  }

  let known = false;
  for (let index = 0; index < ui.section.options.length; index++) {
    if (ui.section.options[index].value === selected) known = true;
  }

  ui.section.value = known ? selected! : 'default';
  selectSection(ui.section.value);
}

function selectSection(name: string): void {
  if (!animation) return;
  steps = buildTimeline(animation, name);
  sequence = expandTimeline(steps);
  position = 0;
  elapsedInFrame = 0;

  if (sequence.length < 2) setPlaying(false);
  render();
  updateClock();
  persist();
}

function updateMeta(decoded: DecodedAnimation, fileName: string): void {
  ui.meta.hidden = false;
  ui.meta.textContent = `${fileName} \u2014 ${formatAnimationInfo(decoded)}`;
  ui.meta.title =
    decoded.fileFrameCount === decoded.displayFrameCount
      ? ui.meta.textContent
      : `${ui.meta.textContent}\nThe file stores ${decoded.fileFrameCount} frames, which add up to ` +
        `${decoded.displayFrameCount} display frames because unchanged frames are played for longer.`;
}

function renderWarnings(warnings: readonly string[]): void {
  if (!warnings.length) {
    ui.warnings.hidden = true;
    return;
  }
  ui.warnings.hidden = false;
  ui.warnings.textContent = warnings.length === 1
    ? warnings[0]
    : `${warnings.length} issues: ${warnings.slice(0, 2).join('; ')}…`;
  ui.warnings.title = warnings.join('\n');
}

function showError(message: string): void {
  animation = null;
  images = [];
  sequence = [];
  setPlaying(false);
  ui.toolbar.hidden = true;
  ui.stage.hidden = true;
  ui.meta.hidden = true;
  ui.warnings.hidden = true;
  ui.error.hidden = false;
  ui.errorMessage.textContent = message;
}

function normaliseSpeed(value: number): number {
  return [0.25, 0.5, 1, 2, 4].includes(value) ? value : 1;
}

function setPlaying(value: boolean): void {
  playing = value && sequence.length > 1;
  ui.play.dataset.state = playing ? 'playing' : 'paused';
  ui.play.title = playing ? 'Click to pause' : 'Click to play';
  ui.play.setAttribute('aria-label', ui.play.title);

  if (playing) {
    startLoop();
  } else {
    stopLoop();
    lastTimestamp = 0;
  }
  persist();
}

function startLoop(): void {
  if (rafId !== null) return;
  lastTimestamp = 0;
  rafId = requestAnimationFrame(tick);
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function tick(timestamp: number): void {
  rafId = null;
  const delta = lastTimestamp ? timestamp - lastTimestamp : 0;
  lastTimestamp = timestamp;

  if (playing && delta > 0) {
    advance(delta);
    rafId = requestAnimationFrame(tick);
  } else if (playing) {
    rafId = requestAnimationFrame(tick);
  }
}

function advance(deltaMs: number): void {
  if (!animation || sequence.length < 2) return;

  const frameMs = frameDurationMs(animation, speed);
  elapsedInFrame += deltaMs;

  let advanced = false;
  let guard = 0;
  while (elapsedInFrame >= frameMs && guard++ < 240) {
    elapsedInFrame -= frameMs;
    position = (position + 1) % sequence.length;
    advanced = true;
  }
  if (guard >= 240) elapsedInFrame = 0;

  if (advanced) {
    render();
    updateClock();
  }
}

function stepFrame(delta: number): void {
  if (!animation || sequence.length === 0) return;
  setPlaying(false);
  position = (position + delta + sequence.length) % sequence.length;
  elapsedInFrame = 0;
  render();
  updateClock();
}

function restart(): void {
  if (!animation || sequence.length === 0) return;
  position = 0;
  elapsedInFrame = 0;
  render();
  updateClock();
}

function render(): void {
  const image = images[sequence[position]];
  if (image) context.putImageData(image, 0, 0);
  updateCounter();
}

function updateCounter(): void {
  ui.counter.textContent = sequence.length ? `${position + 1} / ${sequence.length}` : '—';
}

function updateClock(): void {
  if (!animation || !sequence.length) {
    ui.clock.textContent = '';
    return;
  }
  const fps = Math.max(1, animation.fps);
  const elapsed = position / fps;
  const total = sequence.length / fps;
  const digits = total >= 10 ? 1 : 2;
  ui.clock.textContent = `${elapsed.toFixed(digits)}s / ${total.toFixed(digits)}s`;
}

function applyZoom(): void {
  if (!animation) return;

  const scale = zoom === 'fit' ? currentFitScale() : zoom;

  ui.canvas.style.width = `${Math.round(animation.width * scale)}px`;
  ui.canvas.style.height = `${Math.round(animation.height * scale)}px`;
  ui.zoomFit.title = `Fit to window (currently ${formatScale(scale)})`;
  ui.zoomFit.dataset.active = zoom === 'fit' ? 'true' : 'false';
}

function formatScale(scale: number): string {
  return `${Number.isInteger(scale) ? scale : scale.toFixed(2)}x`;
}

function zoomBy(direction: number): void {
  const current = zoom === 'fit' ? currentFitScale() : zoom;

  if (direction > 0) {
    const next = ZOOM_STEPS.find(step => step > current + 1e-6);
    zoom = next ?? Math.min(64, Math.round(current * 2));
  } else {
    const smaller = ZOOM_STEPS.filter(step => step < current - 1e-6);
    zoom = smaller.length ? smaller[smaller.length - 1] : 1;
  }

  applyZoom();
  persist();
}

function currentFitScale(): number {
  if (!animation) return 1;

  const availableWidth = Math.max(1, ui.viewport.clientWidth - 24);
  const availableHeight = Math.max(1, ui.viewport.clientHeight - 24);
  const raw = Math.min(availableWidth / animation.width, availableHeight / animation.height);

  if (raw < 1) return Math.max(0.25, Math.round(raw * 20) / 20);
  return Math.max(1, Math.min(32, Math.floor(raw)));
}

ui.play.addEventListener('click', () => setPlaying(!playing));
ui.prev.addEventListener('click', () => stepFrame(-1));
ui.next.addEventListener('click', () => stepFrame(1));

ui.section.addEventListener('change', () => selectSection(ui.section.value));

ui.speed.addEventListener('change', () => {
  speed = normaliseSpeed(Number(ui.speed.value));
  elapsedInFrame = 0;
  persist();
});

ui.background.addEventListener('change', () => {
  background = ui.background.value;
  ui.stage.dataset.background = background;
  persist();
});

ui.zoomIn.addEventListener('click', () => zoomBy(1));
ui.zoomOut.addEventListener('click', () => zoomBy(-1));
ui.zoomFit.addEventListener('click', () => {
  zoom = 'fit';
  applyZoom();
  persist();
});

ui.retry.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));

ui.canvas.addEventListener('dblclick', () => {
  zoom = zoom === 'fit' ? 1 : 'fit';
  applyZoom();
  persist();
});

document.addEventListener('keydown', event => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

  if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    setPlaying(!playing);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepFrame(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepFrame(1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    restart();
  } else if (event.key === '+' || event.key === '=') {
    zoomBy(1);
  } else if (event.key === '-') {
    zoomBy(-1);
  }
});

ui.viewport.addEventListener(
  'wheel',
  event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1 : -1);
  },
  { passive: false }
);

window.addEventListener('resize', () => {
  if (zoom === 'fit') applyZoom();
});

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (zoom === 'fit') applyZoom();
  }).observe(ui.viewport);
}

document.addEventListener('visibilitychange', () => {
  lastTimestamp = 0;
});

window.addEventListener('message', event => {
  const message = event.data as IncomingMessage;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'load') load(message);
  else if (message.type === 'error') showError(message.message);
});

vscode.postMessage({ type: 'ready' });
