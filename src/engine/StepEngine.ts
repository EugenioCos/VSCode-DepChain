// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as vscode from 'vscode';
import { DirtyRepo, PlannedStart, PlannedStep, ReadonlyPlan } from '../model';
import { TerminalAdapter } from '../terminal/adapter';
import {
  checkoutCommandLine,
  discardCommand,
  fetchCommand,
  pullCommand,
  startCommandLine,
  stashCommand,
  stepRunLine,
} from './buildCommand';

export type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'started';

export type EngineEvent =
  | { type: 'runStarted' }
  | { type: 'stepStarted'; step: PlannedStep; index: number; total: number }
  | {
      type: 'stepFinished';
      step: PlannedStep;
      index: number;
      ok: boolean;
      exitCode: number | undefined;
    }
  | { type: 'started'; start: PlannedStart }
  | {
      type: 'finished';
      status: RunStatus;
      failedStepIndex?: number;
      exitCode?: number;
      message?: string;
    };

export interface StepEngineOptions {
  plan: ReadonlyPlan;
  adapter: TerminalAdapter;
  log: vscode.LogOutputChannel;
  graceMs: number;
  confirmDiscard(dirty: DirtyRepo[]): Promise<boolean>;
}

/**
 * Sequential, fail-fast executor for a preflighted plan.
 */
export class StepEngine {
  private readonly emitter = new vscode.EventEmitter<EngineEvent>();
  readonly onEvent = this.emitter.event;
  private cancelled = false;

  constructor(private readonly options: StepEngineOptions) {}

  run(signal: AbortSignal): Promise<RunStatus> {
    return this.execute(0, signal, true);
  }

  retryFrom(stepIndex: number, signal: AbortSignal): Promise<RunStatus> {
    return this.execute(stepIndex, signal, false);
  }

  async cancel(): Promise<void> {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    this.options.log.info('Run cancelled by the user.');
    await this.options.adapter.cancel();
  }

  private async execute(
    fromIndex: number,
    signal: AbortSignal,
    applyDirtyPolicy: boolean,
  ): Promise<RunStatus> {
    const { plan, adapter, log } = this.options;
    this.cancelled = false;

    if (signal.aborted) {
      this.finish('cancelled');
      return 'cancelled';
    }

    this.emitter.fire({ type: 'runStarted' });

    if (applyDirtyPolicy) {
      const prepStatus = await this.applyDirtyPolicy(signal);
      if (prepStatus) {
        return prepStatus;
      }
    }

    const total = plan.steps.length;

    for (let index = fromIndex; index < total; index += 1) {
      if (this.cancelled || signal.aborted) {
        this.finish('cancelled');
        return 'cancelled';
      }

      const step = plan.steps[index];
      this.emitter.fire({ type: 'stepStarted', step, index, total });

      if (step.branch) {
        const fetchStatus = await this.runPreparation(
          fetchCommand(step.repoAbsPath),
          index,
          step,
          'git fetch',
          signal,
        );
        if (fetchStatus) {
          return fetchStatus;
        }
      }

      const checkoutLine = checkoutCommandLine(step);
      if (checkoutLine) {
        const checkoutStatus = await this.runPreparation(
          checkoutLine,
          index,
          step,
          'git checkout',
          signal,
        );
        if (checkoutStatus) {
          return checkoutStatus;
        }
      }

      if (step.pull) {
        const pullStatus = await this.runPreparation(
          pullCommand(step.repoAbsPath),
          index,
          step,
          'git pull',
          signal,
        );
        if (pullStatus) {
          return pullStatus;
        }
      }

      const line = stepRunLine(step);
      if (!line) {
        this.emitter.fire({ type: 'stepFinished', step, index, ok: true, exitCode: 0 });
        continue;
      }
      log.info(`[${index + 1}/${total}] ${line}`);

      let exitCode: number | undefined;
      try {
        const result = await adapter.run(line, { signal });
        exitCode = result.exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(message);
        this.finish('failed', index, undefined, message);
        return 'failed';
      }

      if (this.cancelled || signal.aborted) {
        this.finish('cancelled');
        return 'cancelled';
      }

      const ok = exitCode === 0;
      this.emitter.fire({ type: 'stepFinished', step, index, ok, exitCode });

      if (!ok) {
        const message =
          exitCode === undefined
            ? `Step ${index + 1} (${step.repoName}) finished without an exit code.`
            : `Step ${index + 1} (${step.repoName}) failed with exit code ${exitCode}.`;
        log.error(message);
        this.finish('failed', index, exitCode, message);
        return 'failed';
      }
    }

    return this.startIfNeeded();
  }

  private async startIfNeeded(): Promise<RunStatus> {
    const { plan, adapter, log } = this.options;
    const start = plan.start;
    if (!start) {
      this.finish('succeeded');
      return 'succeeded';
    }

    const line = startCommandLine(start);
    log.info(`[start] ${line}`);
    this.emitter.fire({ type: 'started', start });

    const result = await adapter.runDetached(line, this.options.graceMs);
    if (result.exitedEarly) {
      if (result.exitCode === 0) {
        log.info('Start command exited immediately with exit code 0.');
        this.finish('succeeded');
        return 'succeeded';
      }
      const message =
        result.exitCode === undefined
          ? 'Start command exited early without an exit code.'
          : `Start command exited early with exit code ${result.exitCode}.`;
      log.error(message);
      this.finish('failed', undefined, result.exitCode, message);
      return 'failed';
    }

    this.finish('started');
    return 'started';
  }

  private async runPreparation(
    commandLine: string,
    index: number,
    step: PlannedStep,
    label: string,
    signal: AbortSignal,
  ): Promise<RunStatus | undefined> {
    const { adapter, log, plan } = this.options;
    log.info(`[${index + 1}/${plan.steps.length}] ${commandLine}`);

    let exitCode: number | undefined;
    try {
      exitCode = (await adapter.run(commandLine, { signal })).exitCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(message);
      this.finish('failed', index, undefined, message);
      return 'failed';
    }

    if (this.cancelled || signal.aborted) {
      this.finish('cancelled');
      return 'cancelled';
    }

    if (exitCode !== 0) {
      const message =
        exitCode === undefined
          ? `${label} in ${step.repoName} finished without an exit code.`
          : `${label} in ${step.repoName} failed with exit code ${exitCode}.`;
      log.error(message);
      this.finish('failed', index, exitCode, message);
      return 'failed';
    }

    return undefined;
  }

  private async applyDirtyPolicy(signal: AbortSignal): Promise<RunStatus | undefined> {
    const { plan, adapter, log } = this.options;
    if (plan.dirty.length === 0) {
      return undefined;
    }

    if (plan.onDirty === 'fail') {
      this.finish('failed', undefined, undefined, 'Repositories have uncommitted changes.');
      return 'failed';
    }

    if (plan.onDirty === 'discard') {
      const confirmed = await this.options.confirmDiscard(plan.dirty);
      if (!confirmed) {
        this.finish('cancelled');
        return 'cancelled';
      }
    }

    for (const repo of plan.dirty) {
      if (this.cancelled || signal.aborted) {
        this.finish('cancelled');
        return 'cancelled';
      }

      const line =
        plan.onDirty === 'stash'
          ? stashCommand(repo.repoAbsPath, plan.setupName, repo.repoName)
          : discardCommand(repo.repoAbsPath);

      log.info(`[dirty] ${line}`);
      const result = await adapter.run(line, { signal });

      if (this.cancelled || signal.aborted) {
        this.finish('cancelled');
        return 'cancelled';
      }

      if (result.exitCode !== 0) {
        const message = `Could not ${
          plan.onDirty === 'stash' ? 'stash' : 'discard'
        } changes in ${repo.repoName}.`;
        log.error(message);
        this.finish('failed', undefined, result.exitCode, message);
        return 'failed';
      }
    }

    return undefined;
  }

  private finish(
    status: RunStatus,
    failedStepIndex?: number,
    exitCode?: number,
    message?: string,
  ): void {
    this.emitter.fire({ type: 'finished', status, failedStepIndex, exitCode, message });
  }
}
