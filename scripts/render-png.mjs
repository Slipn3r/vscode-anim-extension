#!/usr/bin/env node

import { deflateSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { buildTimeline, decodeAnimation, expandTimeline } from '../dist/animFile.mjs';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([header, body, crc]);
}

/** Encodes RGBA pixels as a PNG (no filtering, 8 bit, non-interlaced). */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function blit(target, targetWidth, source, width, height, scale, offsetX, offsetY) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = (y * width + x) * 4;
      for (let dy = 0; dy < scale; dy++) {
        const row = (offsetY + y * scale + dy) * targetWidth * 4;
        for (let dx = 0; dx < scale; dx++) {
          const at = row + (offsetX + x * scale + dx) * 4;
          target[at] = source[pixel];
          target[at + 1] = source[pixel + 1];
          target[at + 2] = source[pixel + 2];
          target[at + 3] = source[pixel + 3];
        }
      }
    }
  }
}

function parseArgs(argv) {
  const options = { scale: undefined, frame: undefined, columns: undefined, fileFrames: false };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--frame') options.frame = Number(argv[++i]);
    else if (argument === '--scale') options.scale = Number(argv[++i]);
    else if (argument === '--columns') options.columns = Number(argv[++i]);
    else if (argument === '--file-frames') options.fileFrames = true;
    else positional.push(argument);
  }

  return { options, positional };
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const [input, output] = positional;

  if (!input || !output) {
    console.error('usage: node scripts/render-png.mjs <file.anim> <out.png> [--frame n] [--scale n] [--columns n]');
    process.exitCode = 1;
    return;
  }

  const animation = decodeAnimation(await readFile(input));
  console.log(
    `${input}: ${animation.format} ${animation.width}x${animation.height} ${animation.fps}fps ` +
      `${animation.fileFrameCount} file frames, ${animation.displayFrameCount} display frames, ${animation.colorFormat}`
  );
  for (const warning of animation.warnings) console.warn(`  warning: ${warning}`);

  if (options.frame !== undefined) {
    const scale = options.scale ?? 8;
    const frame = animation.frames[options.frame];
    if (!frame) throw new Error(`No frame ${options.frame} (0..${animation.frames.length - 1})`);

    const width = animation.width * scale;
    const height = animation.height * scale;
    const pixels = new Uint8ClampedArray(width * height * 4);
    blit(pixels, width, frame.rgba, animation.width, animation.height, scale, 0, 0);

    await writeFile(output, encodePng(width, height, pixels));
    console.log(`wrote ${output} (frame ${options.frame}, ${width}x${height})`);
    return;
  }

  const scale = options.scale ?? 4;
  const sequence = options.fileFrames
    ? animation.frames.map((_, index) => index)
    : expandTimeline(buildTimeline(animation));

  const columns = options.columns ?? Math.min(16, Math.max(1, Math.ceil(Math.sqrt(sequence.length))));
  const rows = Math.ceil(sequence.length / columns);
  const cellWidth = animation.width * scale;
  const cellHeight = animation.height * scale;
  const pixels = new Uint8ClampedArray(cellWidth * columns * cellHeight * rows * 4);

  // A faint grid so individual frames stay distinguishable.
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;

  sequence.forEach((frameIndex, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    blit(
      pixels,
      cellWidth * columns,
      animation.frames[frameIndex].rgba,
      animation.width,
      animation.height,
      scale,
      column * cellWidth,
      row * cellHeight
    );
  });

  await writeFile(output, encodePng(cellWidth * columns, cellHeight * rows, pixels));
  console.log(`wrote ${output} (${sequence.length} frames, ${columns} columns, scale ${scale})`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
