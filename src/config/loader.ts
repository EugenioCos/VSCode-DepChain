// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as path from 'node:path';
import * as vscode from 'vscode';
import { Diagnostic, RawConfig } from '../model';
import { validateConfig } from './validate';

export interface LoadedConfig {
  uri: vscode.Uri;
  config?: RawConfig;
  diagnostics: Diagnostic[];
}

export function resolveConfigUri(folder: vscode.WorkspaceFolder, configPath: string): vscode.Uri {
  const value = configPath.trim();
  if (!value) {
    return vscode.Uri.joinPath(folder.uri, '.vscode', 'dep-chain.json');
  }
  if (path.isAbsolute(value)) {
    return vscode.Uri.file(value);
  }
  return vscode.Uri.joinPath(folder.uri, value);
}

export async function loadConfig(uri: vscode.Uri): Promise<LoadedConfig> {
  let text: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    text = Buffer.from(bytes).toString('utf8');
  } catch (error) {
    return {
      uri,
      diagnostics: [
        {
          severity: 'error',
          path: '',
          message: `Cannot read config file ${uri.fsPath}: ${errorMessage(error)}`,
        },
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      uri,
      diagnostics: [
        {
          severity: 'error',
          path: '',
          message: `Invalid JSON in ${uri.fsPath}: ${errorMessage(error)}`,
        },
      ],
    };
  }

  const { config, diagnostics } = validateConfig(raw);
  return { uri, config, diagnostics };
}

export async function resolveWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }

  const items = folders.map((folder) => ({
    label: folder.name,
    description: folder.uri.fsPath,
    folder,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the workspace folder',
  });
  return picked?.folder;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
