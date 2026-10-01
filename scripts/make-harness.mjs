#!/usr/bin/env node

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { renderPreviewHtml } from '../dist/template.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputDirectory = path.join(root, 'test', 'harness');
const examplesDirectory = path.join(root, 'examples', 'built');

let animations = [];
try {
  animations = (await readdir(examplesDirectory))
    .filter(name => name.endsWith('.anim'))
    .sort()
    .map(name => `examples/built/${name}`);
} catch {
  console.warn(`no example animations found in ${examplesDirectory}`);
}

const harnessScript = `<script>
  (function () {
    var files = ${JSON.stringify(animations)};

    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:50;display:flex;gap:6px;'
      + 'align-items:center;padding:4px 8px;border:1px solid #8886;border-radius:4px;'
      + 'background:rgba(30,30,30,.88);color:#ddd;font:12px sans-serif';

    var select = document.createElement('select');
    select.id = 'harness-file';
    files.forEach(function (file) {
      var option = document.createElement('option');
      option.value = '../../' + file;
      option.textContent = file.split('/').pop();
      select.append(option);
    });

    var load = document.createElement('button');
    load.id = 'harness-load';
    load.textContent = 'Load';
    load.onclick = function () { window.__harnessSend(); };

    var broken = document.createElement('button');
    broken.id = 'harness-broken';
    broken.textContent = 'Broken';
    broken.title = 'Feed the preview a file that is not an animation';
    broken.onclick = function () {
      window.postMessage({ type: 'load', fileName: 'broken.anim', data: btoa('not an animation at all'), mtime: Date.now(), autoplay: true, background: 'checkerboard' }, '*');
    };

    bar.append(select, load, broken);
    document.body.append(bar);

    window.__harnessSend = async function () {
      var response = await fetch(select.value);
      var bytes = new Uint8Array(await response.arrayBuffer());
      var chunks = [];
      for (var i = 0; i < bytes.length; i += 8192) {
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
      }
      window.postMessage({
        type: 'load',
        fileName: select.value.split('/').pop(),
        data: btoa(chunks.join('')),
        mtime: Date.now(),
        autoplay: true,
        background: 'checkerboard'
      }, '*');
    };

    var api = {
      postMessage: function (message) {
        if (message && (message.type === 'ready' || message.type === 'reload')) window.__harnessSend();
      },
      getState: function () { return undefined; },
      setState: function () {}
    };
    window.acquireVsCodeApi = function () { return api; };
  })();
</script>`;

const html = renderPreviewHtml({
  scriptUri: '../../media/preview.js',
  styleUri: '../../media/preview.css',
  beforeScript: harnessScript,
});

await mkdir(outputDirectory, { recursive: true });
const target = path.join(outputDirectory, 'preview.html');
await writeFile(target, html);
console.log(`wrote ${path.relative(process.cwd(), target)} (${animations.length} examples)`);
