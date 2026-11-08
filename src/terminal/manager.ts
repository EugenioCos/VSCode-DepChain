// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as vscode from 'vscode';
import { TerminalAdapter } from './adapter';
import { ChildProcessAdapter } from './childProcessAdapter';
import { ShellIntegrationAdapter } from './shellIntegrationAdapter';

export const TERMINAL_NAME = 'Dep Chain';

export interface AcquireOptions {
  timeoutMs: number;
  log: vscode.LogOutputChannel;
  output: vscode.OutputChannel;
  cwd: string;
}

/**
 * Returns an adapter bound to one terminal (reused across runs) with shell integration, or
 * a child-process adapter writing to one output channel. A new terminal is never created
 * per step.
 */
export async function acquireAdapter(options: AcquireOptions): Promise<TerminalAdapter> {
  const existing = vscode.window.terminals.find((terminal) => terminal.name === TERMINAL_NAME);
  const terminal = existing ?? vscode.window.createTerminal({ name: TERMINAL_NAME });
  terminal.show();

  const integration = await waitForShellIntegration(terminal, options.timeoutMs);
  if (integration) {
    options.log.info('Using shell integration in the "Dep Chain" terminal.');
    return new ShellIntegrationAdapter(terminal);
  }

  options.log.warn(
    `Shell integration did not activate within ${options.timeoutMs} ms; using the output channel instead.`,
  );
  options.output.show(true);
  return new ChildProcessAdapter(options.output, options.cwd);
}

function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }

  return new Promise((resolve) => {
    const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal && event.shellIntegration) {
        subscription.dispose();
        clearTimeout(timer);
        resolve(event.shellIntegration);
      }
    });

    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(undefined);
    }, timeoutMs);
  });
}
