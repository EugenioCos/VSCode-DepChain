// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as vscode from 'vscode';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private resetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.setIdle(0);
    this.item.show();
  }

  setIdle(setupCount: number): void {
    this.clearTimer();
    this.item.text = '$(debug-start) Dep Chain';
    this.item.command = 'depChain.runSetup';
    this.item.tooltip =
      setupCount > 0
        ? `${setupCount} setup${setupCount === 1 ? '' : 's'} configured. Click to run.`
        : 'No setups configured. Click to run or create a config.';
    this.item.backgroundColor = undefined;
  }

  setRunning(label: string): void {
    this.clearTimer();
    this.item.text = `$(sync~spin) Dep Chain: ${label}`;
    this.item.command = 'depChain.cancel';
    this.item.tooltip = 'Click to cancel the run.';
    this.item.backgroundColor = undefined;
  }

  setSucceeded(setupName: string): void {
    this.item.text = `$(check) Dep Chain: ${setupName} done`;
    this.item.command = 'depChain.runSetup';
    this.item.tooltip = 'Run completed. Click to run again.';
    this.item.backgroundColor = undefined;
    this.scheduleReset();
  }

  setStarted(): void {
    this.clearTimer();
    this.item.text = '$(play) Dep Chain: dev server';
    this.item.command = 'depChain.showTerminal';
    this.item.tooltip = 'The start command is running in the terminal.';
    this.item.backgroundColor = undefined;
  }

  setFailed(label: string): void {
    this.clearTimer();
    this.item.text = `$(error) Dep Chain: failed at ${label}`;
    this.item.command = 'depChain.showTerminal';
    this.item.tooltip = 'Click to show the terminal.';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  setCancelled(): void {
    this.item.text = '$(circle-slash) Dep Chain: cancelled';
    this.item.command = 'depChain.runSetup';
    this.item.tooltip = 'Run cancelled. Click to run again.';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.scheduleReset();
  }

  dispose(): void {
    this.clearTimer();
    this.item.dispose();
  }

  private scheduleReset(): void {
    this.clearTimer();
    this.resetTimer = setTimeout(() => this.setIdle(0), 10000);
  }

  private clearTimer(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
  }
}
