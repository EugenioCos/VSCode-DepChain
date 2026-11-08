// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as vscode from 'vscode';

export function configPath(): string {
  return vscode.workspace.getConfiguration('depChain').get<string>('configPath', '');
}

export function shellIntegrationTimeoutMs(): number {
  return vscode.workspace.getConfiguration('depChain').get<number>(
    'shellIntegrationTimeoutMs',
    5000,
  );
}

export function cmdStartGracePeriodMs(): number {
  return vscode.workspace.getConfiguration('depChain').get<number>(
    'cmdStartGracePeriodMs',
    1500,
  );
}
