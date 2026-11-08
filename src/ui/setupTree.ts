// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as vscode from 'vscode';
import { loadConfig, resolveConfigUri } from '../config/loader';
import { configPath } from '../config/settings';
import { RawConfig, RawSetup, RawStep } from '../model';

export interface FolderState {
  folder: vscode.WorkspaceFolder;
  uri: vscode.Uri;
  exists: boolean;
  config?: RawConfig;
  error?: string;
}

export type SetupNode =
  | { kind: 'folder'; state: FolderState }
  | { kind: 'group'; state: FolderState; group: 'setups' | 'config' }
  | { kind: 'setup'; state: FolderState; name: string; setup: RawSetup }
  | { kind: 'step'; step: RawStep }
  | { kind: 'openConfig'; state: FolderState }
  | { kind: 'createConfig'; state: FolderState }
  | { kind: 'newSetup'; state: FolderState }
  | { kind: 'message'; label: string; severity: 'info' | 'error' };

/**
 * Tree view listing the setups of the workspace config. Clicking a setup runs it directly;
 * the Configuration group links to the config file.
 */
export class SetupTreeProvider implements vscode.TreeDataProvider<SetupNode> {
  private readonly emitter = new vscode.EventEmitter<SetupNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  async getChildren(element?: SetupNode): Promise<SetupNode[]> {
    if (!element) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        return [{ kind: 'message', label: 'Open a folder to use Dep Chain', severity: 'info' }];
      }

      const states = await Promise.all(folders.map((folder) => loadFolderState(folder)));
      if (states.length === 1) {
        return this.folderChildren(states[0]);
      }
      return states.map((state) => ({ kind: 'folder', state }));
    }

    switch (element.kind) {
      case 'folder':
        return this.folderChildren(element.state);

      case 'group': {
        if (element.group === 'setups') {
          const entries = Object.entries(element.state.config?.setups ?? {});
          if (entries.length === 0) {
            return [
              { kind: 'message', label: 'No setups configured', severity: 'info' },
              { kind: 'newSetup', state: element.state },
            ];
          }
          return [
            ...entries.map(([name, setup]) => ({
              kind: 'setup' as const,
              state: element.state,
              name,
              setup,
            })),
            { kind: 'newSetup', state: element.state },
          ];
        }

        return [
          { kind: 'openConfig', state: element.state },
          ...(element.state.exists
            ? []
            : [{ kind: 'createConfig' as const, state: element.state }]),
        ];
      }

      case 'setup':
        return element.setup.steps.map((step) => ({ kind: 'step', step }));

      default:
        return [];
    }
  }

  getTreeItem(element: SetupNode): vscode.TreeItem {
    switch (element.kind) {
      case 'folder': {
        const item = new vscode.TreeItem(
          element.state.folder.name,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.description = element.state.folder.uri.fsPath;
        item.iconPath = new vscode.ThemeIcon('folder');
        return item;
      }

      case 'group': {
        const item = new vscode.TreeItem(
          element.group === 'setups' ? 'Setups' : 'Configuration',
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon(
          element.group === 'setups' ? 'list-unordered' : 'gear',
        );
        return item;
      }

      case 'setup': {
        const item = new vscode.TreeItem(
          element.name,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        const count = element.setup.steps.length;
        item.description =
          element.setup.description ?? `${count} step${count === 1 ? '' : 's'}`;
        item.tooltip = buildTooltip(element.name, element.setup);
        item.iconPath = new vscode.ThemeIcon('layers');
        item.contextValue = 'depChain.setup';
        return item;
      }

      case 'step': {
        const item = new vscode.TreeItem(element.step.repo, vscode.TreeItemCollapsibleState.None);
        item.description = element.step.branch
          ? `@ ${element.step.branch}`
          : 'current checkout';
        item.tooltip = element.step.branch
          ? `${element.step.repo} @ ${element.step.branch}`
          : `${element.step.repo} (current checkout)`;
        item.iconPath = new vscode.ThemeIcon('git-branch');
        return item;
      }

      case 'openConfig': {
        const item = new vscode.TreeItem(
          'Open dep-chain.json',
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = vscode.workspace.asRelativePath(element.state.uri, false);
        item.iconPath = new vscode.ThemeIcon('go-to-file');
        item.command = {
          command: 'depChain.openConfig',
          title: 'Open config',
          arguments: [element.state.folder.uri.toString()],
        };
        return item;
      }

      case 'createConfig': {
        const item = new vscode.TreeItem(
          'Create dep-chain.json',
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = '.vscode';
        item.iconPath = new vscode.ThemeIcon('new-file');
        item.command = {
          command: 'depChain.createConfig',
          title: 'Create config',
          arguments: [element.state.folder.uri.toString()],
        };
        return item;
      }

      case 'newSetup': {
        const item = new vscode.TreeItem(
          'New setup…',
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('add');
        item.tooltip = 'Create a setup through the wizard';
        item.command = {
          command: 'depChain.createSetup',
          title: 'Create setup',
          arguments: [element.state.folder.uri.toString()],
        };
        return item;
      }

      case 'message': {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.tooltip = element.label;
        item.iconPath = new vscode.ThemeIcon(
          element.severity === 'error' ? 'error' : 'info',
        );
        return item;
      }
    }
  }

  private folderChildren(state: FolderState): SetupNode[] {
    if (!state.exists) {
      return [{ kind: 'createConfig', state }];
    }

    if (!state.config) {
      return [
        { kind: 'message', label: state.error ?? 'Invalid configuration', severity: 'error' },
        { kind: 'openConfig', state },
      ];
    }

    return [
      { kind: 'group', state, group: 'setups' },
      { kind: 'group', state, group: 'config' },
    ];
  }
}

async function loadFolderState(folder: vscode.WorkspaceFolder): Promise<FolderState> {
  const uri = resolveConfigUri(folder, configPath());

  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    return { folder, uri, exists: false };
  }

  const loaded = await loadConfig(uri);
  if (!loaded.config) {
    return {
      folder,
      uri,
      exists: true,
      error: loaded.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message,
    };
  }

  return { folder, uri, exists: true, config: loaded.config };
}

function buildTooltip(name: string, setup: RawSetup): string {
  // Plain text on purpose: tree item tooltips may render Markdown links, and this content
  // comes from the workspace config.
  const lines: string[] = [name];

  if (setup.description) {
    lines.push('', setup.description);
  }

  lines.push(
    '',
    ...setup.steps.map((step) =>
      step.branch ? `${step.repo} @ ${step.branch}` : `${step.repo} (current checkout)`,
    ),
  );

  return lines.join('\n');
}
