import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatAnimationInfo, inspectAnimation } from './animFile';
import { renderPreviewHtml } from './webview/template';

const VIEW_TYPE = 'busybarAnim.preview';
const ANIM_EXTENSION = '.anim';
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

class AnimDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    //
  }
}

class AnimPreviewProvider implements vscode.CustomReadonlyEditorProvider<AnimDocument> {
  public static readonly viewType = VIEW_TYPE;

  private readonly watcher: vscode.FileSystemWatcher;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.anim');
  }

  openCustomDocument(uri: vscode.Uri): AnimDocument {
    return new AnimDocument(uri);
  }

  resolveCustomEditor(document: AnimDocument, panel: vscode.WebviewPanel): void {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = renderPreviewHtml({
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.css')).toString(),
      cspSource: panel.webview.cspSource,
      nonce: nonce(),
    });

    const reload = () => void this.send(document.uri, panel);
    const changeSubscription = this.watcher.onDidChange(uri => {
      if (uri.toString() === document.uri.toString()) reload();
    });

    panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready' || message?.type === 'reload') reload();
    });
    panel.onDidDispose(() => changeSubscription.dispose());
  }

  private async send(uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    const fileName = path.basename(uri.fsPath);

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_PREVIEW_BYTES) {
        throw new Error(
          `File is ${(stat.size / (1024 * 1024)).toFixed(1)} MB \u2014 too large to preview.`
        );
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      const configuration = vscode.workspace.getConfiguration('busybarAnim', uri);

      await panel.webview.postMessage({
        type: 'load',
        fileName,
        data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
        mtime: stat.mtime,
        autoplay: configuration.get<boolean>('autoplay', true),
        background: configuration.get<string>('background', 'checkerboard'),
      });
    } catch (error) {
      await panel.webview.postMessage({
        type: 'error',
        fileName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose(): void {
    this.watcher.dispose();
  }
}

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

async function resolveAnimation(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri) return uri;

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.path.toLowerCase().endsWith(ANIM_EXTENSION)) return active;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Preview animation',
    filters: { 'BUSY Bar animations': ['anim'] },
  });
  return picked?.[0];
}

async function openPreview(uri?: vscode.Uri): Promise<void> {
  const target = await resolveAnimation(uri);
  if (!target) return;
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
}

function infoReport(uri: vscode.Uri, source: Uint8Array): string {
  const info = inspectAnimation(source);
  const lines = [
    `# ${path.basename(uri.fsPath)}`,
    '',
    `| | |`,
    `|---|---|`,
    `| Format | \`${info.format}\` |`,
    `| Frames | ${info.width}\u00d7${info.height} px |`,
    `| Frame rate | ${info.fps} fps |`,
    `| File frames | ${info.fileFrameCount} |`,
    `| Display frames | ${info.displayFrameCount} |`,
    `| Colour format | \`${info.colorFormat}\` |`,
    `| File size | ${info.bytes} bytes (${info.sectionsChunkLength} sections + ${info.framesChunkLength} frames) |`,
    '',
    '## Sections',
    '',
  ];

  if (info.sections.length === 0) {
    lines.push('_none_');
  } else {
    lines.push('| Name | Display frames |', '|---|---|');
    for (const section of info.sections) {
      const frames = section.end - section.start + 1;
      lines.push(`| \`${section.name}\` | ${section.start}..${section.end} (${frames}) |`);
    }
  }

  if (info.warnings.length) {
    lines.push('', '## Warnings', '');
    for (const warning of info.warnings) lines.push(`- ${warning}`);
  }

  lines.push('', `_${formatAnimationInfo(info)}_`);
  return lines.join('\n');
}

async function showInfo(uri?: vscode.Uri): Promise<void> {
  const target = await resolveAnimation(uri);
  if (!target) return;

  try {
    const source = await vscode.workspace.fs.readFile(target);
    const document = await vscode.workspace.openTextDocument({
      content: infoReport(target, source),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Cannot read animation info: ${message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AnimPreviewProvider(context);

  context.subscriptions.push(
    provider,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('busybarAnim.openPreview', openPreview),
    vscode.commands.registerCommand('busybarAnim.showInfo', showInfo)
  );
}

export function deactivate(): void {
  //
}
