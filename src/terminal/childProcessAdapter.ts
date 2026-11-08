// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import { ChildProcess, spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { CommandResult, DetachedResult, RunOptions, TerminalAdapter } from './adapter';

interface ShellInvocation {
  file: string;
  args: string[];
}

function shellInvocation(commandLine: string): ShellInvocation {
  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/sh';
  return { file: shell, args: ['-c', commandLine] };
}

/**
 * Fallback used when terminal shell integration is unavailable. Commands run in a child
 * process and their output goes to a single dedicated output channel, so no extra terminal
 * is created. Exit codes are still authoritative.
 */
export class ChildProcessAdapter implements TerminalAdapter {
  readonly mode = 'childProcess' as const;

  private current: ChildProcess | undefined;
  private readonly detached = new Set<ChildProcess>();

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly cwd: string,
  ) {}

  run(commandLine: string, options?: RunOptions): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      this.output.appendLine(`\n$ ${commandLine}`);

      let child: ChildProcess;
      try {
        const invocation = shellInvocation(commandLine);
        child = spawn(invocation.file, invocation.args, {
          cwd: this.cwd,
          env: process.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        this.output.appendLine(`Cannot start command: ${errorMessage(error)}`);
        resolve({ exitCode: undefined });
        return;
      }

      this.current = child;
      child.stdout?.on('data', (data: Buffer) => this.output.append(data.toString()));
      child.stderr?.on('data', (data: Buffer) => this.output.append(data.toString()));

      child.on('error', (error) => {
        this.output.appendLine(`Process error: ${error.message}`);
        if (this.current === child) {
          this.current = undefined;
        }
        resolve({ exitCode: undefined });
      });

      child.on('close', (code) => {
        if (this.current === child) {
          this.current = undefined;
        }
        this.output.appendLine(`\n[exit ${code ?? 'unknown'}]`);
        resolve({ exitCode: code ?? undefined });
      });

      if (options?.signal) {
        if (options.signal.aborted) {
          void this.cancel();
        } else {
          options.signal.addEventListener('abort', () => void this.cancel(), { once: true });
        }
      }
    });
  }

  runDetached(commandLine: string, graceMs: number): Promise<DetachedResult> {
    this.output.appendLine(`\n$ ${commandLine}`);

    let child: ChildProcess;
    try {
      const invocation = shellInvocation(commandLine);
      child = spawn(invocation.file, invocation.args, {
        cwd: this.cwd,
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.output.appendLine(`Cannot start command: ${errorMessage(error)}`);
      return Promise.resolve({ exitedEarly: true, exitCode: undefined });
    }

    this.detached.add(child);
    child.stdout?.on('data', (data: Buffer) => this.output.append(data.toString()));
    child.stderr?.on('data', (data: Buffer) => this.output.append(data.toString()));

    return new Promise<DetachedResult>((resolve) => {
      let settled = false;
      const finish = (result: DetachedResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.detached.delete(child);
        resolve(result);
      };

      child.on('error', (error) => {
        this.output.appendLine(`Process error: ${error.message}`);
        finish({ exitedEarly: true, exitCode: undefined });
      });
      child.on('close', (code) => finish({ exitedEarly: true, exitCode: code ?? undefined }));

      const timer = setTimeout(() => finish({ exitedEarly: false }), graceMs);
    });
  }

  async cancel(): Promise<void> {
    const child = this.current;
    const pid = child?.pid;
    if (!child || pid === undefined) {
      return;
    }

    try {
      process.kill(-pid, 'SIGINT');
    } catch {
      try {
        child.kill('SIGINT');
      } catch {
        // Already gone.
      }
    }

    const killTimer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, 2000);
    killTimer.unref();
  }

  show(): void {
    this.output.show(true);
  }

  dispose(): void {
    // Detached commands (the "start" one) are intentionally left running.
    this.current = undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
