// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as vscode from 'vscode';
import { Diagnostic } from '../model';

export type FailureAction = 'showTerminal' | 'retry' | 'openConfig';

export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.severity === 'error' ? 'ERROR' : 'WARN'}${
          diagnostic.path ? ` ${diagnostic.path}` : ''
        }: ${diagnostic.message}`,
    )
    .join('\n');
}

export async function reportDiagnostics(
  diagnostics: Diagnostic[],
  uri: vscode.Uri,
  log: vscode.LogOutputChannel,
): Promise<void> {
  if (diagnostics.length === 0) {
    return;
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    log.error(formatDiagnostics(diagnostics));
  } else {
    log.warn(formatDiagnostics(diagnostics));
  }

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length === 0) {
    return;
  }

  const firstMessage = errors[0].message;
  const more = errors.length > 1 ? `\n(+${errors.length - 1} more in the log)` : '';
  const choice = await vscode.window.showErrorMessage(
    `Dep Chain: ${firstMessage}${more}`,
    'Open Config',
    'Show Log',
  );

  if (choice === 'Open Config') {
    await openDocument(uri);
  } else if (choice === 'Show Log') {
    log.show();
  }
}

export async function showStepFailure(message: string): Promise<FailureAction | undefined> {
  const choice = await vscode.window.showErrorMessage(
    `Dep Chain: ${message}`,
    'Show Terminal',
    'Retry Failed Step',
    'Open Config',
  );

  if (choice === 'Show Terminal') {
    return 'showTerminal';
  }
  if (choice === 'Retry Failed Step') {
    return 'retry';
  }
  if (choice === 'Open Config') {
    return 'openConfig';
  }
  return undefined;
}

export async function openDocument(uri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
}
