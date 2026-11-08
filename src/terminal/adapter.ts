// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

export type AdapterMode = 'shellIntegration' | 'childProcess';

export interface RunOptions {
  signal?: AbortSignal;
}

export interface CommandResult {
  /** undefined when the shell or process did not report a code. */
  exitCode: number | undefined;
  /** The terminal/process was closed or the run was cancelled. */
  aborted?: boolean;
}

export interface DetachedResult {
  /** True when the command ended within the grace period. */
  exitedEarly: boolean;
  exitCode?: number;
}

/**
 * Executes one command at a time. Implementations must be sequential: callers await each
 * command before starting the next one.
 */
export interface TerminalAdapter {
  readonly mode: AdapterMode;
  run(commandLine: string, options?: RunOptions): Promise<CommandResult>;
  /** Starts a long-running command and waits at most graceMs for an early exit. */
  runDetached(commandLine: string, graceMs: number): Promise<DetachedResult>;
  cancel(): Promise<void>;
  show(): void;
  dispose(): void;
}
