// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as vscode from 'vscode';
import { CommandResult, DetachedResult, RunOptions, TerminalAdapter } from './adapter';

interface PendingRun {
  execution: vscode.TerminalShellExecution;
  resolve: (result: CommandResult) => void;
  endSub: vscode.Disposable;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Drives a single reusable terminal through the shell integration API. Requires VS Code
 * 1.93+: `executeCommand` gives us per-command end events with their exit code.
 */
export class ShellIntegrationAdapter implements TerminalAdapter {
  readonly mode = 'shellIntegration' as const;

  private readonly pending = new Set<PendingRun>();
  private readonly closeSub: vscode.Disposable;
  private closed = false;

  constructor(private readonly terminal: vscode.Terminal) {
    this.closeSub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== this.terminal) {
        return;
      }
      this.closed = true;
      for (const run of [...this.pending]) {
        this.settle(run, { exitCode: undefined, aborted: true });
      }
    });
  }

  run(commandLine: string, options?: RunOptions): Promise<CommandResult> {
    const integration = this.terminal.shellIntegration;
    if (this.closed || !integration) {
      return Promise.resolve({ exitCode: undefined, aborted: true });
    }

    const execution = integration.executeCommand(commandLine);

    return new Promise<CommandResult>((resolve) => {
      const pending: PendingRun = {
        execution,
        resolve,
        endSub: vscode.window.onDidEndTerminalShellExecution((event) => {
          if (event.execution !== execution) {
            return;
          }
          this.settle(pending, { exitCode: event.exitCode });
        }),
        signal: options?.signal,
      };

      if (options?.signal) {
        const onAbort = () => {
          void this.cancel();
        };
        pending.onAbort = onAbort;
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.add(pending);
    });
  }

  async runDetached(commandLine: string, graceMs: number): Promise<DetachedResult> {
    const integration = this.terminal.shellIntegration;
    if (this.closed || !integration) {
      return { exitedEarly: true, exitCode: undefined };
    }

    const execution = integration.executeCommand(commandLine);

    return new Promise<DetachedResult>((resolve) => {
      let settled = false;
      const endSub = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution !== execution || settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        endSub.dispose();
        resolve({ exitedEarly: true, exitCode: event.exitCode });
      });
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        endSub.dispose();
        resolve({ exitedEarly: false });
      }, graceMs);
    });
  }

  /**
   * Interrupts the running command with Ctrl+C. The next `executeCommand` also sends ^C
   * automatically, so the terminal is never left in a half-typed state.
   */
  async cancel(): Promise<void> {
    if (!this.closed) {
      this.terminal.sendText('\u0003', false);
    }
    for (const run of [...this.pending]) {
      this.settle(run, { exitCode: undefined, aborted: true });
    }
  }

  show(): void {
    this.terminal.show();
  }

  dispose(): void {
    this.closeSub.dispose();
    for (const run of [...this.pending]) {
      this.settle(run, { exitCode: undefined, aborted: true });
    }
  }

  private settle(run: PendingRun, result: CommandResult): void {
    if (!this.pending.delete(run)) {
      return;
    }
    run.endSub.dispose();
    if (run.signal && run.onAbort) {
      run.signal.removeEventListener('abort', run.onAbort);
    }
    run.resolve(result);
  }
}
