import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeAnimation } from '../dist/animFile.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'tracks_72x16.anim');
const fixtureBytes = await readFile(fixture);

const calls = {
  customEditors: [],
  commands: new Map(),
  watchers: [],
};

let readFileImpl = async () => Buffer.from(fixtureBytes);

const fakeVscode = {
  Uri: {
    file: value => ({ scheme: 'file', fsPath: value, path: value, toString: () => `file://${value}` }),
    joinPath: (base, ...segments) => {
      const joined = [base.fsPath ?? base.path, ...segments].join('/').replace(/\/+/g, '/');
      return { scheme: 'file', fsPath: joined, path: joined, toString: () => `file://${joined}` };
    },
  },
  workspace: {
    createFileSystemWatcher: glob => {
      const watcher = {
        glob,
        onDidChange: handler => {
          watcher.handler = handler;
          return { dispose() {} };
        },
        dispose() {},
      };
      calls.watchers.push(watcher);
      return watcher;
    },
    fs: {
      stat: async () => ({ size: 1024, mtime: 42 }),
      readFile: uri => readFileImpl(uri),
    },
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    openTextDocument: async options => ({ options }),
  },
  window: {
    registerCustomEditorProvider: (viewType, provider, options) => {
      calls.customEditors.push({ viewType, provider, options });
      return { dispose() {} };
    },
    showTextDocument: async () => ({}),
    showErrorMessage: () => {},
    showOpenDialog: async () => undefined,
    activeTextEditor: undefined,
  },
  commands: {
    registerCommand: (id, handler) => {
      calls.commands.set(id, handler);
      return { dispose() {} };
    },
    executeCommand: async () => {},
  },
  ViewColumn: { Beside: 2 },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, ...rest);
};

const extension = require('../dist/extension.js');
Module._load = originalLoad;

function fakePanel() {
  const sent = [];
  let receiver;
  const panel = {
    webview: {
      options: undefined,
      html: undefined,
      cspSource: 'vscode-webview://test',
      asWebviewUri: uri => uri,
      postMessage: async message => {
        sent.push(message);
      },
      onDidReceiveMessage: handler => {
        receiver = handler;
        return { dispose() {} };
      },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
  return { panel, sent, receive: message => receiver(message) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function activateOnce() {
  const context = { subscriptions: [], extensionUri: fakeVscode.Uri.file('/extension') };
  extension.activate(context);
  const registration = calls.customEditors.at(-1);
  return { context, registration };
}

test('registers the custom editor and commands on activation', async () => {
  const { context, registration } = await activateOnce();

  assert.equal(registration.viewType, 'busybarAnim.preview');
  assert.equal(registration.options.webviewOptions.retainContextWhenHidden, false);
  assert.equal(registration.options.supportsMultipleEditorsPerDocument, true);
  assert.ok([...calls.commands.keys()].includes('busybarAnim.openPreview'));
  assert.ok([...calls.commands.keys()].includes('busybarAnim.showInfo'));
  assert.equal(context.subscriptions.length, 4);
  assert.equal(calls.watchers.at(-1).glob, '**/*.anim');
});

test('resolveCustomEditor installs the webview and answers ready with the file', async () => {
  const { registration } = await activateOnce();
  const provider = registration.provider;
  const uri = fakeVscode.Uri.file(path.join(here, 'fixtures', 'tracks_72x16.anim'));

  const document = provider.openCustomDocument(uri);
  assert.equal(document.uri, uri);

  const { panel, sent, receive } = fakePanel();
  provider.resolveCustomEditor(document, panel);

  assert.equal(panel.webview.options.enableScripts, true);
  assert.equal(panel.webview.options.localResourceRoots.length, 1);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /id="canvas"/);
  assert.match(panel.webview.html, /<script nonce="[A-Za-z0-9]{32}" src="file:\/\/\/extension\/media\/preview\.js">/);
  assert.match(panel.webview.html, /<link rel="stylesheet" href="file:\/\/\/extension\/media\/preview\.css">/);
  assert.equal(sent.length, 0, 'nothing is sent before the webview is ready');

  receive({ type: 'ready' });
  await tick();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'load');
  assert.equal(sent[0].fileName, 'tracks_72x16.anim');
  assert.equal(sent[0].autoplay, true);
  assert.equal(sent[0].background, 'checkerboard');

  const bytes = Buffer.from(sent[0].data, 'base64');
  assert.deepEqual(bytes, fixtureBytes);
  assert.equal(decodeAnimation(bytes).format, 'bicycle0');

  receive({ type: 'reload' });
  await tick();
  assert.equal(sent.length, 2);
});

test('reports read failures to the webview', async () => {
  const { registration } = await activateOnce();
  const provider = registration.provider;
  const uri = fakeVscode.Uri.file('/nowhere/missing.anim');

  const document = provider.openCustomDocument(uri);
  const { panel, sent, receive } = fakePanel();
  provider.resolveCustomEditor(document, panel);

  readFileImpl = async () => {
    throw new Error('ENOENT: no such file or directory');
  };
  try {
    receive({ type: 'ready' });
    await tick();
  } finally {
    readFileImpl = async () => Buffer.from(fixtureBytes);
  }

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].fileName, 'missing.anim');
  assert.match(sent[0].message, /ENOENT/);
});

test('reports oversized files instead of copying them into the webview', async () => {
  const { registration } = await activateOnce();
  const provider = registration.provider;
  const document = provider.openCustomDocument(fakeVscode.Uri.file('/big/huge.anim'));

  const { panel, sent, receive } = fakePanel();
  provider.resolveCustomEditor(document, panel);
  receive({ type: 'ready' });
  await tick();

  assert.equal(sent[0].type, 'load');

  const size = 100 * 1024 * 1024;
  fakeVscode.workspace.fs.stat = async () => ({ size, mtime: 1 });
  try {
    receive({ type: 'reload' });
    await tick();
    assert.equal(sent[1].type, 'error');
    assert.match(sent[1].message, /too large/);
  } finally {
    delete fakeVscode.workspace.fs.stat;
    fakeVscode.workspace.fs.stat = async () => ({ size: 1024, mtime: 42 });
  }
});
