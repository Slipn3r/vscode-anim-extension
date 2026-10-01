export const SIGNATURE_V1 = 'bicycle1';
export const SIGNATURE_V0 = 'bicycle0';

export type AnimFormat = 'bicycle1' | 'bicycle0';

export type ColorFormat = 'bgr888' | 'gray4' | 'bgra8888';

export const COLOR_FORMATS: readonly ColorFormat[] = ['bgr888', 'gray4', 'bgra8888'];

const HEADER_V1 = 34;
const HEADER_V0 = 36;
const SECTION_V1 = 12;
const SECTION_V0 = 13;
const FRAME_HEADER_V1 = 5;
const FRAME_HEADER_V0 = 4;

const enum MaskEncoding {
  FullyBlack = 0,
  FullyWhite = 1,
  RleFirstBlack = 2,
  RleFirstWhite = 3,
  Bitmap = 4,
}

const enum PixelEncoding {
  Raw = 0,
  Rle = 1,
  QoiLike = 2,
}

const SHORT_RUN_BITS = 3;
const LONG_RUN_BITS = 8;
const LONG_RUN_MARKER = (1 << SHORT_RUN_BITS) - 1;

const QOI_OP_RGB = 0xfe;
const QOI_OP_RGBA = 0xff;

export interface DecodedFrame {
  rgba: Uint8ClampedArray;
  holdFrames: number;
}

export interface DecodedSection {
  name: string;
  start: number;
  end: number;
  frameOffset: number;
}

export interface FrameEntry {
  offset: number;
  maskOffset: number;
  maskBits: number;
  pixelOffset: number;
  pixelLength: number;
  maskEncoding: number;
  pixelEncoding: number;
  holdFrames: number;
}

export interface AnimationInfo {
  format: AnimFormat;
  width: number;
  height: number;
  fps: number;
  colorFormat: ColorFormat;
  flags: number;
  sections: DecodedSection[];
  fileFrameCount: number;
  displayFrameCount: number;
  bytes: number;
  sectionsChunkLength: number;
  framesChunkLength: number;
  frameTable?: FrameEntry[];
  warnings: string[];
}

export interface DecodedAnimation extends Omit<AnimationInfo, 'frameTable'> {
  frames: DecodedFrame[];
}

export class AnimFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnimFileError';
  }
}

export interface TimelineStep {
  frame: number;
  holds: number;
}

const BLOCK_SIZE: Record<ColorFormat, number> = { bgr888: 3, gray4: 1, bgra8888: 4 };

function packedBytes(colorFormat: ColorFormat, pixels: number): number {
  return colorFormat === 'gray4' ? Math.ceil(pixels / 2) : pixels * BLOCK_SIZE[colorFormat];
}

function colorFormatFromCode(code: number): ColorFormat {
  const format = COLOR_FORMATS[code];
  if (!format) {
    throw new AnimFileError(`Unsupported color format ${code} (expected 0 = bgr888, 1 = gray4, 2 = bgra8888)`);
  }
  return format;
}

function readSignature(bytes: Uint8Array): AnimFormat {
  if (bytes.length < 8) {
    throw new AnimFileError('File is too short to be an animation');
  }
  let signature = '';
  for (let i = 0; i < 8; i++) signature += String.fromCharCode(bytes[i]);
  if (signature === SIGNATURE_V1) return 'bicycle1';
  if (signature === SIGNATURE_V0) return 'bicycle0';
  throw new AnimFileError(
    `Not an animation file: expected signature "${SIGNATURE_V1}" or "${SIGNATURE_V0}", found "${printable(signature)}"`
  );
}

function printable(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    out += code >= 32 && code < 127 ? character : '?';
  }
  return out;
}

class BitReader {
  private position = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly bitLength: number
  ) {}

  get done(): boolean {
    return this.position >= this.bitLength;
  }

  read(width: number): number {
    let value = 0;
    for (let i = 0; i < width; i++) {
      if (this.position < this.bitLength) {
        value = (value << 1) | ((this.data[this.position >> 3] >> (7 - (this.position & 7))) & 1);
      }
      this.position++;
    }
    return value;
  }
}

function decodeMaskRuns(
  data: Uint8Array,
  bitLength: number,
  encoding: number,
  pixelCount: number,
  starts: number[],
  counts: number[]
): number {
  if (encoding === MaskEncoding.FullyBlack) return 0;

  if (encoding === MaskEncoding.FullyWhite) {
    starts.push(0);
    counts.push(pixelCount);
    return pixelCount;
  }

  const reader = new BitReader(data, bitLength);
  let index = 0;
  let selected = 0;

  const push = (start: number, count: number) => {
    const clipped = Math.min(count, pixelCount - start);
    if (clipped > 0) {
      starts.push(start);
      counts.push(clipped);
      selected += clipped;
    }
  };

  if (encoding === MaskEncoding.Bitmap) {
    let runStart = -1;
    while (!reader.done) {
      if (reader.read(1)) {
        if (runStart < 0) runStart = index;
      } else if (runStart >= 0) {
        push(runStart, index - runStart);
        runStart = -1;
      }
      index++;
    }
    if (runStart >= 0) push(runStart, index - runStart);
    return selected;
  }

  if (encoding !== MaskEncoding.RleFirstBlack && encoding !== MaskEncoding.RleFirstWhite) {
    throw new AnimFileError(`Unsupported mask encoding ${encoding}`);
  }

  let selected_nibble = encoding === MaskEncoding.RleFirstWhite;
  while (!reader.done) {
    let runLength = reader.read(SHORT_RUN_BITS);
    if (runLength === LONG_RUN_MARKER) {
      runLength = reader.read(LONG_RUN_BITS);
    }

    if (selected_nibble) push(index, runLength);
    index += runLength;
    selected_nibble = !selected_nibble;
  }

  return selected;
}

function decompressRle(source: Uint8Array, blockSize: number, maxLength: number): Uint8Array {
  const output = new Uint8Array(maxLength);
  let sourceIndex = 0;
  let outputIndex = 0;

  while (sourceIndex < source.length && outputIndex < maxLength) {
    const opcode = source[sourceIndex++];
    const count = opcode & 0x7f;

    if (opcode & 0x80) {
      const length = Math.min(count * blockSize, maxLength - outputIndex, source.length - sourceIndex);
      output.set(source.subarray(sourceIndex, sourceIndex + length), outputIndex);
      sourceIndex += length;
      outputIndex += length;
      continue;
    }

    if (sourceIndex + blockSize > source.length) break;

    for (let repeat = 0; repeat < count && outputIndex < maxLength; repeat++) {
      for (let byte = 0; byte < blockSize && outputIndex < maxLength; byte++) {
        output[outputIndex++] = source[sourceIndex + byte];
      }
    }
    sourceIndex += blockSize;
  }

  return output.subarray(0, outputIndex);
}

function unpackPixels(packed: Uint8Array, colorFormat: ColorFormat, pixelLimit: number): Uint8ClampedArray {
  if (colorFormat === 'gray4') {
    const count = Math.min(packed.length * 2, pixelLimit);
    const output = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
      const byte = packed[i >> 1];
      const level = i & 1 ? (byte & 0x0f) << 4 : byte & 0xf0;
      const offset = i * 4;
      output[offset] = level;
      output[offset + 1] = level;
      output[offset + 2] = level;
      output[offset + 3] = 255;
    }
    return output;
  }

  const blockSize = BLOCK_SIZE[colorFormat];
  const count = Math.min(Math.floor(packed.length / blockSize), pixelLimit);
  const output = new Uint8ClampedArray(count * 4);
  for (let pixel = 0; pixel < count; pixel++) {
    const source = pixel * blockSize;
    const offset = pixel * 4;
    output[offset] = packed[source + 2];
    output[offset + 1] = packed[source + 1];
    output[offset + 2] = packed[source];
    output[offset + 3] = blockSize === 4 ? packed[source + 3] : 255;
  }
  return output;
}

function decompressQoi(source: Uint8Array, pixelLimit: number): { rgba: Uint8ClampedArray; count: number } {
  const output = new Uint8ClampedArray(pixelLimit * 4);
  const index = new Uint32Array(64);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 255;
  let written = 0;

  const emit = () => {
    index[(r * 3 + g * 5 + b * 7 + a * 11) % 64] = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    if (written < pixelLimit) {
      const offset = written * 4;
      output[offset] = r;
      output[offset + 1] = g;
      output[offset + 2] = b;
      output[offset + 3] = a;
    }
    written++;
  };

  for (let i = 0; i < source.length; i++) {
    const tag = source[i];
    const payload = tag & 0x3f;

    if (tag === QOI_OP_RGB) {
      if (i + 3 >= source.length) break;
      r = source[i + 1];
      g = source[i + 2];
      b = source[i + 3];
      i += 3;
      emit();
    } else if (tag === QOI_OP_RGBA) {
      if (i + 4 >= source.length) break;
      r = source[i + 1];
      g = source[i + 2];
      b = source[i + 3];
      a = source[i + 4];
      i += 4;
      emit();
    } else if ((tag & 0xc0) === 0x00) {
      const key = index[payload];
      r = (key >>> 24) & 0xff;
      g = (key >>> 16) & 0xff;
      b = (key >>> 8) & 0xff;
      a = key & 0xff;
      emit();
    } else if ((tag & 0xc0) === 0x40) {
      r = (r + ((payload >> 4) & 0x03) - 2) & 0xff;
      g = (g + ((payload >> 2) & 0x03) - 2) & 0xff;
      b = (b + (payload & 0x03) - 2) & 0xff;
      emit();
    } else if ((tag & 0xc0) === 0x80) {
      if (i + 1 >= source.length) break;
      const dg = payload - 32;
      const next = source[++i];
      r = (r + dg + ((next >> 4) & 0x0f) - 8) & 0xff;
      g = (g + dg) & 0xff;
      b = (b + dg + (next & 0x0f) - 8) & 0xff;
      emit();
    } else {
      for (let run = 0; run <= payload; run++) emit();
    }
  }

  return { rgba: output, count: Math.min(written, pixelLimit) };
}

function decodePixels(
  data: Uint8Array,
  encoding: number,
  colorFormat: ColorFormat,
  selected: number,
  area: number
): { rgba: Uint8ClampedArray; count: number } {
  if (encoding === PixelEncoding.Raw) {
    const rgba = unpackPixels(data, colorFormat, selected);
    return { rgba, count: rgba.length / 4 };
  }

  if (encoding === PixelEncoding.Rle) {
    const blockSize = BLOCK_SIZE[colorFormat];
    const packed = decompressRle(data, blockSize, packedBytes(colorFormat, area) + blockSize);
    const rgba = unpackPixels(packed, colorFormat, selected);
    return { rgba, count: rgba.length / 4 };
  }

  if (encoding === PixelEncoding.QoiLike) {
    return decompressQoi(data, selected);
  }

  throw new AnimFileError(`Unsupported pixel encoding ${encoding}`);
}

function parseV1(bytes: Uint8Array, view: DataView): AnimationInfo & { frameTable: FrameEntry[] } {
  if (bytes.length < HEADER_V1) throw new AnimFileError('File is too short to hold an animation header');

  const warnings: string[] = [];
  const flags = view.getUint8(8);
  const width = view.getUint8(9);
  const height = view.getUint8(10);
  const colorFormat = colorFormatFromCode(view.getUint8(11));
  const fps = view.getUint8(16);
  const sectionsChunkLength = view.getUint32(18, true);
  const framesChunkLength = view.getUint32(22, true);
  const sectionCount = view.getUint32(26, true);
  const frameCount = view.getUint32(30, true);

  if (flags !== 0) warnings.push(`Unknown header flags 0x${flags.toString(16)}`);
  if (!sectionCount) throw new AnimFileError('Invalid header: section count is zero');
  if (!frameCount) throw new AnimFileError('Invalid header: frame count is zero');
  if (!width || !height) throw new AnimFileError(`Invalid header: empty frame size ${width}x${height}`);
  if (fps === 0) warnings.push('Header declares 0 fps; playback will use 1 fps');

  const expected = HEADER_V1 + sectionsChunkLength + framesChunkLength;
  if (expected > bytes.length) {
    throw new AnimFileError(
      `File is truncated: header describes ${expected} bytes but the file is ${bytes.length} bytes`
    );
  }
  if (expected < bytes.length) {
    warnings.push(`${bytes.length - expected} trailing byte(s) after the last frame`);
  }

  const framesStart = HEADER_V1 + sectionsChunkLength;
  const framesEnd = framesStart + framesChunkLength;

  const sections: DecodedSection[] = [];
  let position = HEADER_V1;
  while (position < framesStart) {
    if (framesStart - position < SECTION_V1 + 1) {
      warnings.push('Section chunk ends with a partial descriptor');
      break;
    }
    const nameStart = position + SECTION_V1;
    let nameEnd = nameStart;
    while (nameEnd < framesStart && bytes[nameEnd] !== 0) nameEnd++;
    if (nameEnd >= framesStart) throw new AnimFileError('Section name is not NUL-terminated');

    sections.push({
      name: utf8(bytes.subarray(nameStart, nameEnd)),
      start: view.getUint32(position, true),
      end: view.getUint32(position + 4, true),
      frameOffset: view.getUint32(position + 8, true),
    });
    position = nameEnd + 1;
  }

  if (sections.length !== sectionCount) {
    warnings.push(`Header declares ${sectionCount} section(s) but ${sections.length} were found`);
  }

  const first = sections[0];
  if (!first || first.name !== 'default') {
    warnings.push('Section 0 is not the reserved "default" section');
  } else {
    if (first.start !== 0 || first.end !== frameCount - 1) {
      warnings.push(
        `Section "default" covers frames ${first.start}..${first.end}, expected 0..${frameCount - 1}`
      );
    }
    if (first.frameOffset !== framesStart) {
      warnings.push(`Section "default" points at offset ${first.frameOffset}, expected ${framesStart}`);
    }
  }

  const frameTable: FrameEntry[] = [];
  position = framesStart;
  for (let index = 0; index < frameCount; index++) {
    if (position + FRAME_HEADER_V1 > framesEnd) {
      throw new AnimFileError(`Frame ${index} header lies outside of the frame chunk`);
    }
    const joint = view.getUint8(position);
    const maskBits = view.getUint16(position + 1, true);
    const pixelLength = view.getUint16(position + 3, true);
    const maskEncoding = joint >> 4;
    const pixelEncoding = joint & 0x0f;

    if (maskEncoding > MaskEncoding.Bitmap) {
      throw new AnimFileError(`Frame ${index} uses unknown mask encoding ${maskEncoding}`);
    }
    if (pixelEncoding > PixelEncoding.QoiLike) {
      throw new AnimFileError(`Frame ${index} uses unknown pixel encoding ${pixelEncoding}`);
    }
    if (maskEncoding < MaskEncoding.RleFirstBlack && maskBits !== 0) {
      warnings.push(`Frame ${index} has mask data but a uniformly filled mask`);
    }

    const maskLength = Math.ceil(maskBits / 8);
    const maskOffset = position + FRAME_HEADER_V1;
    const pixelOffset = maskOffset + maskLength;
    const end = pixelOffset + pixelLength;
    if (end > framesEnd) {
      throw new AnimFileError(`Frame ${index} data lies outside of the frame chunk`);
    }

    frameTable.push({
      offset: position,
      maskOffset,
      maskBits,
      pixelOffset,
      pixelLength,
      maskEncoding,
      pixelEncoding,
      holdFrames: 1,
    });
    position = end;
  }

  if (position !== framesEnd) {
    warnings.push(`${framesEnd - position} unread byte(s) at the end of the frame chunk`);
  }

  const displayFrameCount = frameTable.length;

  return {
    format: 'bicycle1',
    width,
    height,
    fps,
    colorFormat,
    flags,
    sections,
    fileFrameCount: frameCount,
    displayFrameCount,
    bytes: bytes.length,
    sectionsChunkLength,
    framesChunkLength,
    frameTable,
    warnings,
  };
}

function parseV0(bytes: Uint8Array, view: DataView): AnimationInfo & { frameTable: FrameEntry[] } {
  if (bytes.length < HEADER_V0) throw new AnimFileError('File is too short to hold an animation header');

  const warnings: string[] = [];
  const flags = view.getUint8(8);
  const width = view.getUint8(9);
  const height = view.getUint8(10);
  const colorFormat = colorFormatFromCode(view.getUint8(11));
  const fps = view.getUint8(12);
  const sectionsChunkLength = view.getUint32(16, true);
  const framesChunkLength = view.getUint32(20, true);
  const frameCount = view.getUint32(28, true);
  const declaredDisplayFrames = view.getUint32(32, true);

  if (flags !== 0) warnings.push(`Unknown header flags 0x${flags.toString(16)}`);
  if (!frameCount) throw new AnimFileError('Invalid header: frame count is zero');
  if (!width || !height) throw new AnimFileError(`Invalid header: empty frame size ${width}x${height}`);
  if (fps === 0) warnings.push('Header declares 0 fps; playback will use 1 fps');

  const framesStart = HEADER_V0 + sectionsChunkLength;
  const framesEnd = framesStart + framesChunkLength;
  if (framesEnd > bytes.length) {
    throw new AnimFileError(
      `File is truncated: header describes ${framesEnd} bytes but the file is ${bytes.length} bytes`
    );
  }
  if (framesEnd < bytes.length) {
    warnings.push(`${bytes.length - framesEnd} trailing byte(s) after the last frame`);
  }

  const sections: DecodedSection[] = [];
  let position = HEADER_V0;
  while (position < framesStart) {
    if (framesStart - position < SECTION_V0 + 1) {
      warnings.push('Section chunk ends with a partial descriptor');
      break;
    }
    const nameStart = position + SECTION_V0;
    let nameEnd = nameStart;
    while (nameEnd < framesStart && bytes[nameEnd] !== 0) nameEnd++;
    if (nameEnd >= framesStart) throw new AnimFileError('Section name is not NUL-terminated');

    sections.push({
      name: utf8(bytes.subarray(nameStart, nameEnd)),
      start: view.getUint32(position, true),
      end: view.getUint32(position + 4, true),
      frameOffset: view.getUint32(position + 8, true),
    });
    position = nameEnd + 1;
  }

  if (!sections.length) warnings.push('File declares no sections');

  const frameTable: FrameEntry[] = [];
  position = framesStart;
  for (let index = 0; index < frameCount; index++) {
    if (position + FRAME_HEADER_V0 > framesEnd) {
      throw new AnimFileError(`Frame ${index} header lies outside of the frame chunk`);
    }
    const pixelEncoding = view.getUint8(position);
    const holdFrames = Math.max(1, view.getUint8(position + 1));
    const pixelLength = view.getUint16(position + 2, true);

    if (pixelEncoding > PixelEncoding.Rle) {
      throw new AnimFileError(`Frame ${index} uses unknown pixel encoding ${pixelEncoding}`);
    }
    const pixelOffset = position + FRAME_HEADER_V0;
    const end = pixelOffset + pixelLength;
    if (end > framesEnd) {
      throw new AnimFileError(`Frame ${index} data lies outside of the frame chunk`);
    }

    frameTable.push({
      offset: position,
      maskOffset: pixelOffset,
      maskBits: 0,
      pixelOffset,
      pixelLength,
      maskEncoding: MaskEncoding.FullyWhite,
      pixelEncoding,
      holdFrames,
    });
    position = end;
  }

  if (position !== framesEnd) {
    warnings.push(`${framesEnd - position} unread byte(s) at the end of the frame chunk`);
  }

  const displayFrameCount = frameTable.reduce((total, frame) => total + frame.holdFrames, 0);
  if (declaredDisplayFrames && declaredDisplayFrames !== displayFrameCount) {
    warnings.push(
      `Header declares ${declaredDisplayFrames} display frames, frame durations add up to ${displayFrameCount}`
    );
  }

  return {
    format: 'bicycle0',
    width,
    height,
    fps,
    colorFormat,
    flags,
    sections,
    fileFrameCount: frameCount,
    displayFrameCount,
    bytes: bytes.length,
    sectionsChunkLength,
    framesChunkLength,
    frameTable,
    warnings,
  };
}

function utf8(data: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(data);
  let out = '';
  for (const byte of data) out += String.fromCharCode(byte);
  return out;
}

function toBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function parse(input: Uint8Array | ArrayBuffer): AnimationInfo & { frameTable: FrameEntry[] } {
  const bytes = toBytes(input);
  const format = readSignature(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return format === 'bicycle1' ? parseV1(bytes, view) : parseV0(bytes, view);
}

export function inspectAnimation(input: Uint8Array | ArrayBuffer): AnimationInfo {
  const parsed = parse(input);
  const { frameTable: _frameTable, ...info } = parsed;
  return info;
}

export function decodeAnimation(input: Uint8Array | ArrayBuffer): DecodedAnimation {
  const parsed = parse(input);
  const bytes = toBytes(input);
  const { width, height, colorFormat, frameTable } = parsed;
  const area = width * height;

  const frames: DecodedFrame[] = [];
  const canvas = new Uint8ClampedArray(area * 4);
  const runStarts: number[] = [];
  const runCounts: number[] = [];

  for (let index = 0; index < frameTable.length; index++) {
    const entry = frameTable[index];
    const maskData = bytes.subarray(entry.maskOffset, entry.maskOffset + Math.ceil(entry.maskBits / 8));
    const pixelData = bytes.subarray(entry.pixelOffset, entry.pixelOffset + entry.pixelLength);

    runStarts.length = 0;
    runCounts.length = 0;
    const selected = decodeMaskRuns(
      maskData,
      entry.maskBits,
      entry.maskEncoding,
      area,
      runStarts,
      runCounts
    );

    const decoded = decodePixels(pixelData, entry.pixelEncoding, colorFormat, selected, area);
    const allowedDifference = colorFormat === 'gray4' ? 1 : 0;
    if (Math.abs(decoded.count - selected) > allowedDifference) {
      parsed.warnings.push(
        `Frame ${index}: decoded ${decoded.count} pixel(s) but the mask selects ${selected}`
      );
    }

    if (entry.maskEncoding === MaskEncoding.FullyBlack) {
      //
    } else {
      let source = 0;
      for (let run = 0; run < runStarts.length; run++) {
        const start = runStarts[run];
        const count = runCounts[run];
        const available = Math.max(0, decoded.count - source);
        const placed = Math.min(count, available);
        if (placed > 0) {
          canvas.set(decoded.rgba.subarray(source * 4, (source + placed) * 4), start * 4);
          source += placed;
        }
      }
    }

    frames.push({ rgba: canvas.slice(), holdFrames: entry.holdFrames });
  }

  if (!frames.length) throw new AnimFileError('Animation contains no frames');

  const { frameTable: _frameTable, ...info } = parsed;
  return { ...info, frames };
}

export function buildTimeline(animation: DecodedAnimation, sectionName?: string | null): TimelineStep[] {
  const frames = animation.frames;
  if (!frames.length) return [];

  const chosen = sectionName && sectionName !== 'default'
    ? animation.sections.find(section => section.name === sectionName)
    : undefined;

  if (!chosen) {
    return frames.map((frame, index) => ({ frame: index, holds: frame.holdFrames }));
  }

  const starts: number[] = [];
  let accumulated = 0;
  for (const frame of frames) {
    starts.push(accumulated);
    accumulated += frame.holdFrames;
  }

  const lastDisplay = animation.displayFrameCount - 1;
  const from = Math.max(0, Math.min(chosen.start, lastDisplay));
  const to = Math.max(from, Math.min(chosen.end, lastDisplay));

  const steps: TimelineStep[] = [];
  let display = from;
  let index = binarySearchFrame(starts, display);

  while (display <= to && index < frames.length) {
    const offsetInFrame = display - starts[index];
    const available = frames[index].holdFrames - offsetInFrame;
    const holds = Math.min(available, to - display + 1);
    if (holds > 0) steps.push({ frame: index, holds });
    display += holds;
    index++;
  }

  return steps;
}

function binarySearchFrame(starts: number[], displayIndex: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= displayIndex) low = middle;
    else high = middle - 1;
  }
  return low;
}

const MAX_SEQUENCE_LENGTH = 1_000_000;

export function expandTimeline(steps: readonly TimelineStep[]): number[] {
  const total = steps.reduce((sum, step) => sum + step.holds, 0);
  const sequence = new Array<number>(Math.min(total, MAX_SEQUENCE_LENGTH));
  let index = 0;
  for (const step of steps) {
    for (let i = 0; i < step.holds && index < sequence.length; i++) {
      sequence[index++] = step.frame;
    }
  }
  sequence.length = index;
  return sequence;
}

export function frameDurationMs(animation: DecodedAnimation, speed = 1): number {
  return 1000 / Math.max(1, animation.fps) / Math.max(0.01, speed);
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

export function formatAnimationInfo(info: AnimationInfo): string {
  const frames =
    info.fileFrameCount === info.displayFrameCount
      ? count(info.fileFrameCount, 'frame')
      : `${count(info.fileFrameCount, 'file frame')} \u00b7 ${count(info.displayFrameCount, 'display frame')}`;

  const parts = [
    `${info.width}x${info.height}`,
    `${info.fps} fps`,
    frames,
    info.colorFormat,
    info.format,
    formatBytes(info.bytes),
  ];
  return parts.join(' \u00b7 ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
