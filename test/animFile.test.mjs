import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AnimFileError,
  buildTimeline,
  decodeAnimation,
  expandTimeline,
  formatAnimationInfo,
  formatBytes,
  inspectAnimation,
} from '../dist/animFile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const examples = path.join(here, '..', 'examples', 'built');

const COLOR = { bgr888: 0, gray4: 1, bgra8888: 2 };
const MASK = { fullyBlack: 0, fullyWhite: 1, rleBlack: 2, rleWhite: 3, bitmap: 4 };
const PIXELS = { raw: 0, rle: 1, qoi: 2 };

function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function concat(parts) {
  return Buffer.concat(parts.map(part => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function buildV1({ width, height, colorFormat = COLOR.bgr888, fps = 10, frames, sections = [] }) {
  const allSections = [{ name: 'default', start: 0, end: frames.length - 1 }, ...sections];

  const encodedFrames = frames.map(frame => {
    const maskData = Buffer.from(frame.maskData ?? []);
    return concat([
      Buffer.from([frame.pixelEncoding | (frame.maskEncoding << 4)]),
      u16(frame.maskBits ?? maskData.length * 8),
      u16(frame.pixelData.length),
      maskData,
      Buffer.from(frame.pixelData),
    ]);
  });

  const sectionDescriptors = allSections.map(section => ({
    ...section,
    name: Buffer.from(section.name, 'utf8'),
  }));

  let sectionsChunkLength = 0;
  for (const section of sectionDescriptors) sectionsChunkLength += 12 + section.name.length + 1;

  const framesStart = 34 + sectionsChunkLength;
  const offsets = [];
  let cursor = framesStart;
  for (const frame of encodedFrames) {
    offsets.push(cursor);
    cursor += frame.length;
  }

  const sectionsChunk = concat(
    sectionDescriptors.map(section =>
      concat([u32(section.start), u32(section.end), u32(offsets[section.start] ?? 0), section.name, [0]])
    )
  );
  const framesChunk = concat(encodedFrames);

  const header = concat([
    'bicycle1',
    [0, width, height, colorFormat],
    u16(Math.max(0, ...encodedFrames.map(frame => frame.readUInt16LE(1)))),
    u16(Math.max(0, ...encodedFrames.map(frame => frame.readUInt16LE(3)))),
    [fps, 0],
    u32(sectionsChunkLength),
    u32(framesChunk.length),
    u32(sectionDescriptors.length),
    u32(encodedFrames.length),
  ]);

  assert.equal(header.length, 34);
  return concat([header, sectionsChunk, framesChunk]);
}

function buildV0({ width, height, colorFormat = COLOR.bgr888, fps = 10, frames, sections = [] }) {
  const allSections = [{ name: 'default', start: 0, end: frames.reduce((sum, f) => sum + f.holdFrames, 0) - 1 }, ...sections];
  const encodedFrames = frames.map(frame =>
    concat([Buffer.from([frame.pixelEncoding, frame.holdFrames]), u16(frame.pixelData.length), Buffer.from(frame.pixelData)])
  );

  const sectionDescriptors = allSections.map(section => ({
    ...section,
    name: Buffer.from(section.name, 'utf8'),
  }));

  let sectionsChunkLength = 0;
  for (const section of sectionDescriptors) sectionsChunkLength += 13 + section.name.length + 1;

  const framesStart = 36 + sectionsChunkLength;
  const frameStarts = [];
  let cursor = framesStart;
  for (const frame of encodedFrames) {
    frameStarts.push(cursor);
    cursor += frame.length;
  }
  const holdStarts = [];
  let display = 0;
  for (const frame of frames) {
    holdStarts.push(display);
    display += frame.holdFrames;
  }
  const fileFrameOfDisplay = index => {
    let found = 0;
    for (let i = 0; i < holdStarts.length; i++) if (holdStarts[i] <= index) found = i;
    return found;
  };

  const sectionsChunk = concat(
    sectionDescriptors.map(section =>
      concat([
        u32(section.start),
        u32(section.end),
        u32(frameStarts[fileFrameOfDisplay(section.start)]),
        [0], // legacy duration_override
        section.name,
        [0],
      ])
    )
  );
  const framesChunk = concat(encodedFrames);

  const header = concat([
    'bicycle0',
    [0, width, height, colorFormat, fps, 0, 0, 0],
    u32(sectionsChunkLength),
    u32(framesChunk.length),
    u32(1),
    u32(encodedFrames.length),
    u32(allSections[0].end + 1),
  ]);

  assert.equal(header.length, 36);
  return concat([header, sectionsChunk, framesChunk]);
}

function pixelsOf(animation, frame, index) {
  const rgba = animation.frames[frame].rgba;
  return Array.from(rgba.subarray(index * 4, index * 4 + 4));
}

test('bicycle0 fixture: tracks_72x16.anim', async () => {
  const source = await readFile(path.join(fixtures, 'tracks_72x16.anim'));
  const info = inspectAnimation(source);

  assert.equal(info.format, 'bicycle0');
  assert.equal(info.width, 72);
  assert.equal(info.height, 16);
  assert.equal(info.fps, 1);
  assert.equal(info.colorFormat, 'bgr888');
  assert.equal(info.fileFrameCount, 4);
  assert.equal(info.displayFrameCount, 4);
  assert.equal(info.bytes, 6567);
  assert.equal(info.sectionsChunkLength, 21);
  assert.deepEqual(
    info.sections.map(section => [section.name, section.start, section.end]),
    [['default', 0, 3]]
  );
  assert.deepEqual(info.warnings, []);

  const animation = decodeAnimation(source);
  assert.equal(animation.frames.length, 4);
  assert.equal(animation.frames[0].rgba.length, 72 * 16 * 4);
  assert.equal(animation.frames[0].rgba[3], 255, 'bgr888 is fully opaque');
  assert.equal(fnv1a(animation.frames[0].rgba), '990fa0a7');
  assert.equal(fnv1a(animation.frames[2].rgba), 'b6fff117');

  const steps = buildTimeline(animation);
  assert.deepEqual(steps, [
    { frame: 0, holds: 1 },
    { frame: 1, holds: 1 },
    { frame: 2, holds: 1 },
    { frame: 3, holds: 1 },
  ]);
  assert.deepEqual(expandTimeline(steps), [0, 1, 2, 3]);
});

test('bicycle1 fixture: clear_night.anim', async () => {
  const source = await readFile(path.join(fixtures, 'clear_night.anim'));
  const info = inspectAnimation(source);

  assert.equal(info.format, 'bicycle1');
  assert.equal(info.width, 16);
  assert.equal(info.height, 16);
  assert.equal(info.fps, 60);
  assert.equal(info.colorFormat, 'bgra8888');
  assert.equal(info.fileFrameCount, 180);
  assert.equal(info.displayFrameCount, 180);
  assert.deepEqual(info.warnings, []);

  const animation = decodeAnimation(source);
  assert.equal(animation.frames.length, 180);
  assert.equal(fnv1a(animation.frames[0].rgba), 'c1a59c66');
  assert.equal(fnv1a(animation.frames[90].rgba), 'ea3cc966');
  assert.equal(fnv1a(animation.frames[179].rgba), '0f4129df');

  assert.equal(pixelsOf(animation, 0, 0)[3], 0);
  assert.notEqual(fnv1a(animation.frames[0].rgba), fnv1a(animation.frames[1].rgba));

  assert.equal(buildTimeline(animation).length, 180);
  assert.equal(expandTimeline(buildTimeline(animation)).length, 180);
  assert.deepEqual(buildTimeline(animation, 'nope'), buildTimeline(animation));
});

test('gray4 + fully white mask + raw pixels', () => {
  const source = buildV1({
    width: 2,
    height: 2,
    colorFormat: COLOR.gray4,
    frames: [
      {
        maskEncoding: MASK.fullyWhite,
        pixelEncoding: PIXELS.raw,
        maskData: [],
        pixelData: [0x0f, 0x80],
      },
    ],
  });

  const animation = decodeAnimation(source);
  assert.equal(animation.colorFormat, 'gray4');
  assert.deepEqual(pixelsOf(animation, 0, 0), [0x00, 0x00, 0x00, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 1), [0xf0, 0xf0, 0xf0, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 2), [0x80, 0x80, 0x80, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 3), [0x00, 0x00, 0x00, 255]);
  assert.deepEqual(animation.warnings, []);
});

test('bitmap mask selects single pixels', () => {
  const source = buildV1({
    width: 2,
    height: 2,
    colorFormat: COLOR.gray4,
    frames: [
      {
        maskEncoding: MASK.bitmap,
        maskBits: 4,
        maskData: [0b1010_0000],
        pixelEncoding: PIXELS.raw,
        pixelData: [0x0f],
      },
    ],
  });

  const animation = decodeAnimation(source);
  assert.deepEqual(pixelsOf(animation, 0, 0), [0x00, 0x00, 0x00, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixelsOf(animation, 0, 2), [0xf0, 0xf0, 0xf0, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 3), [0, 0, 0, 0]);
});

test('run-length encoded mask, first pixel black', () => {
  const source = buildV1({
    width: 4,
    height: 1,
    colorFormat: COLOR.gray4,
    frames: [
      {
        maskEncoding: MASK.rleBlack,
        maskBits: 6,
        maskData: [0b010010_00],
        pixelEncoding: PIXELS.raw,
        pixelData: [0x8f],
      },
    ],
  });

  const animation = decodeAnimation(source);
  assert.deepEqual(pixelsOf(animation, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelsOf(animation, 0, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixelsOf(animation, 0, 2), [0x80, 0x80, 0x80, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 3), [0xf0, 0xf0, 0xf0, 255]);
});

test('run-length encoded mask with a run longer than 255', () => {
  const bits = [];
  const push = (value, count) => {
    for (let bit = count - 1; bit >= 0; bit--) bits.push((value >> bit) & 1);
  };
  push(1, 3); // 1 black
  push(7, 3);
  push(255, 8);
  push(0, 3);
  push(7, 3);
  push(45, 8); // 255 + 45 = 300 white
  push(7, 3);
  push(19, 8); // 19 black

  const maskData = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    if (bit) maskData[index >> 3] |= 0x80 >> (index & 7);
  });

  const source = buildV1({
    width: 32,
    height: 10,
    colorFormat: COLOR.gray4,
    frames: [
      {
        maskEncoding: MASK.rleBlack,
        maskBits: bits.length,
        maskData,
        pixelEncoding: PIXELS.raw,
        pixelData: Buffer.alloc(150, 0x77), // 300 gray4 pixels
      },
    ],
  });

  const animation = decodeAnimation(source);
  assert.equal(animation.width, 32);
  assert.deepEqual(animation.warnings, []);
  assert.deepEqual(pixelsOf(animation, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelsOf(animation, 0, 1), [0x70, 0x70, 0x70, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 255), [0x70, 0x70, 0x70, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 256), [0x70, 0x70, 0x70, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 300), [0x70, 0x70, 0x70, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 301), [0, 0, 0, 0]);
  assert.deepEqual(pixelsOf(animation, 0, 319), [0, 0, 0, 0]);
});

test('RLE pixel encoding (bgr888 blocks of 3 and verbatim runs)', () => {
  const source = buildV1({
    width: 4,
    height: 1,
    colorFormat: COLOR.bgr888,
    frames: [
      {
        maskEncoding: MASK.fullyWhite,
        pixelEncoding: PIXELS.rle,
        pixelData: [0x02, 1, 2, 3, 0x80 | 0x02, 4, 5, 6, 7, 8, 9],
      },
    ],
  });

  const animation = decodeAnimation(source);
  assert.deepEqual(pixelsOf(animation, 0, 0), [3, 2, 1, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 1), [3, 2, 1, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 2), [6, 5, 4, 255]);
  assert.deepEqual(pixelsOf(animation, 0, 3), [9, 8, 7, 255]);
});

test('QOI-like pixel encoding', () => {
  const source = buildV1({
    width: 4,
    height: 1,
    colorFormat: COLOR.bgra8888,
    frames: [
      {
        maskEncoding: MASK.fullyWhite,
        pixelEncoding: PIXELS.qoi,
        pixelData: [0xff, 10, 20, 30, 255, 0b1100_0011],
      },
    ],
  });

  const animation = decodeAnimation(source);
  assert.deepEqual(animation.warnings, []);
  for (let index = 0; index < 4; index++) {
    assert.deepEqual(pixelsOf(animation, 0, index), [10, 20, 30, 255], `pixel ${index}`);
  }
});

test('interframe masks build on the previous frame', () => {
  const source = buildV1({
    width: 2,
    height: 1,
    colorFormat: COLOR.gray4,
    frames: [
      {
        maskEncoding: MASK.fullyWhite,
        pixelEncoding: PIXELS.raw,
        pixelData: [0x00, 0xf0],
      },
      {
        maskEncoding: MASK.bitmap,
        maskBits: 2,
        maskData: [0b0100_0000],
        pixelEncoding: PIXELS.raw,
        pixelData: [0x80],
      },
      {
        maskEncoding: MASK.fullyBlack,
        pixelEncoding: PIXELS.raw,
        pixelData: [],
      },
    ],
  });

  const animation = decodeAnimation(source);
  assert.deepEqual(pixelsOf(animation, 1, 0), [0x00, 0x00, 0x00, 255]);
  assert.deepEqual(pixelsOf(animation, 1, 1), [0x80, 0x80, 0x80, 255]);
  assert.equal(fnv1a(animation.frames[2].rgba), fnv1a(animation.frames[1].rgba));
});

test('legacy frame durations and sections', () => {
  const source = buildV0({
    width: 2,
    height: 1,
    colorFormat: COLOR.bgr888,
    fps: 10,
    frames: [
      { pixelEncoding: PIXELS.raw, holdFrames: 1, pixelData: [0, 0, 0, 0, 0, 0] },
      { pixelEncoding: PIXELS.raw, holdFrames: 3, pixelData: [1, 1, 1, 1, 1, 1] },
      { pixelEncoding: PIXELS.raw, holdFrames: 2, pixelData: [2, 2, 2, 2, 2, 2] },
    ],
    sections: [
      { name: 'mid', start: 1, end: 4 },
      { name: 'tail', start: 2, end: 5 },
    ],
  });

  const info = inspectAnimation(source);
  assert.equal(info.fileFrameCount, 3);
  assert.equal(info.displayFrameCount, 6);
  assert.deepEqual(
    info.sections.map(section => section.name),
    ['default', 'mid', 'tail']
  );

  const animation = decodeAnimation(source);
  assert.deepEqual(
    animation.frames.map(frame => frame.holdFrames),
    [1, 3, 2]
  );

  assert.deepEqual(buildTimeline(animation), [
    { frame: 0, holds: 1 },
    { frame: 1, holds: 3 },
    { frame: 2, holds: 2 },
  ]);
  assert.deepEqual(buildTimeline(animation, 'mid'), [
    { frame: 1, holds: 3 },
    { frame: 2, holds: 1 },
  ]);
  assert.deepEqual(buildTimeline(animation, 'tail'), [
    { frame: 1, holds: 2 },
    { frame: 2, holds: 2 },
  ]);
  assert.deepEqual(expandTimeline(buildTimeline(animation, 'tail')), [1, 1, 2, 2]);
});

test('rejects files that are not animations', () => {
  assert.throws(() => decodeAnimation(Buffer.from('hello')), AnimFileError);
  assert.throws(() => decodeAnimation(Buffer.alloc(64, 0x41)), /Not an animation file/);
  assert.throws(() => inspectAnimation(Buffer.alloc(0)), /too short/);
});

test('rejects truncated and malformed files', () => {
  const good = buildV1({
    width: 2,
    height: 2,
    colorFormat: COLOR.gray4,
    frames: [
      { maskEncoding: MASK.fullyWhite, pixelEncoding: PIXELS.raw, pixelData: [0x0f, 0x80] },
      { maskEncoding: MASK.fullyWhite, pixelEncoding: PIXELS.raw, pixelData: [0x0f, 0x80] },
    ],
  });

  assert.throws(() => decodeAnimation(good.subarray(0, good.length - 2)), /truncated/);

  const badColor = Buffer.from(good);
  badColor[11] = 7;
  assert.throws(() => decodeAnimation(badColor), /Unsupported color format/);

  const badMask = Buffer.from(good);
  badMask[34 + 12 + 7 + 1] |= 0xf0;
  assert.throws(() => decodeAnimation(badMask), /unknown mask encoding/);
});

test('reports recoverable problems as warnings', () => {
  const good = buildV1({
    width: 2,
    height: 2,
    colorFormat: COLOR.gray4,
    frames: [{ maskEncoding: MASK.fullyWhite, pixelEncoding: PIXELS.raw, pixelData: [0x0f, 0x80] }],
  });

  const withTrailing = Buffer.concat([good, Buffer.from([0, 0, 0])]);
  assert.match(inspectAnimation(withTrailing).warnings.join(), /trailing byte/);

  const badFlags = Buffer.from(good);
  badFlags[8] = 0x02;
  assert.match(inspectAnimation(badFlags).warnings.join(), /flags/);
});

test('formats sizes for humans', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.match(formatBytes(3 * 1024 * 1024), /3.00 MB/);

  const base = { width: 72, height: 16, fps: 60, colorFormat: 'bgr888', bytes: 1000 };

  assert.match(
    formatAnimationInfo({ ...base, format: 'bicycle1', fileFrameCount: 180, displayFrameCount: 180 }),
    /^72x16 · 60 fps · 180 frames · bgr888 · bicycle1 · 1000 B$/
  );
  assert.match(
    formatAnimationInfo({ ...base, format: 'bicycle0', fileFrameCount: 1, displayFrameCount: 1 }),
    /· 1 frame ·/
  );

  assert.match(
    formatAnimationInfo({ ...base, format: 'bicycle0', fileFrameCount: 1092, displayFrameCount: 1200 }),
    /· 1092 file frames · 1200 display frames ·/
  );
  assert.match(
    formatAnimationInfo({ ...base, format: 'bicycle0', fileFrameCount: 1, displayFrameCount: 3 }),
    /· 1 file frame · 3 display frames ·/
  );
});

test('decodes every example animation without warnings', async t => {
  if (!existsSync(examples)) {
    t.skip('examples/built is not present');
    return;
  }

  const files = (await readdir(examples)).filter(name => name.endsWith('.anim'));
  assert.ok(files.length > 0, 'expected example animations');

  for (const file of files) {
    const source = await readFile(path.join(examples, file));
    const animation = decodeAnimation(source);
    assert.deepEqual(animation.warnings, [], `${file} produced warnings`);
    assert.equal(animation.frames.length, animation.fileFrameCount, file);
    assert.ok(animation.displayFrameCount >= animation.fileFrameCount, file);
    assert.equal(animation.frames[0].rgba.length, animation.width * animation.height * 4, file);
    for (const frame of animation.frames) {
      assert.equal(frame.holdFrames >= 1, true, file);
    }
    const sequence = expandTimeline(buildTimeline(animation));
    assert.equal(sequence.length, animation.displayFrameCount, file);
    assert.ok(sequence.every(index => index < animation.frames.length), file);
    assert.doesNotThrow(() => buildTimeline(animation, 'default'), file);
  }
});
