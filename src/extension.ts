// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as path from 'node:path';
import * as vscode from 'vscode';
import { addSetupToConfigText, removeSetupFromConfigText } from './config/edit';
import { loadConfig, resolveConfigUri, resolveWorkspaceFolder } from './config/loader';
import { cmdStartGracePeriodMs, configPath, shellIntegrationTimeoutMs } from './config/settings';
import { RunStatus, StepEngine } from './engine/StepEngine';
import { DirtyRepo, RawConfig, RawSetup, ReadonlyPlan } from './model';
import { createProbeDeps } from './planner/probes';
import { preflight } from './planner/preflight';
import { TerminalAdapter } from './terminal/adapter';
import { TERMINAL_NAME, acquireAdapter } from './terminal/manager';
import {
  formatDiagnostics,
  openDocument,
  reportDiagnostics,
  showStepFailure,
} from './ui/notifications';
import { SetupNode, SetupTreeProvider } from './ui/setupTree';
import { runSetupWizard } from './ui/setupWizard';
import { StatusBar } from './ui/statusBar';

interface RunSetupArg {
  setupName?: string;
  folderUri?: string;
}

interface Selection {
  folder: vscode.WorkspaceFolder;
  uri: vscode.Uri;
  config: RawConfig;
  setupName: string;
  setup: RawSetup;
}

interface Prepared {
  selection: Selection;
  plan: ReadonlyPlan;
}

interface ActiveRun {
  engine: StepEngine;
  controller: AbortController;
}

interface LastFailure {
  uri: vscode.Uri;
  setupName: string;
  plan: ReadonlyPlan;
  stepIndex: number;
}

let log: vscode.LogOutputChannel;
let fallbackOutput: vscode.OutputChannel;
let statusBar: StatusBar;
let setupTree: SetupTreeProvider | undefined;

let activeRun: ActiveRun | undefined;
let lastFailure: LastFailure | undefined;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Dep Chain', { log: true });
  fallbackOutput = vscode.window.createOutputChannel('Dep Chain (commands)');
  statusBar = new StatusBar();
  setupTree = new SetupTreeProvider();

  const treeView = vscode.window.createTreeView('depChain.setups', {
    treeDataProvider: setupTree,
    showCollapseAll: true,
  });

  context.subscriptions.push(log, fallbackOutput, statusBar, treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('depChain.runSetup', (arg?: RunSetupArg) => runSetup(arg)),
    vscode.commands.registerCommand('depChain.runSetupItem', (node?: SetupNode) =>
      runSetupItem(node),
    ),
    vscode.commands.registerCommand('depChain.deleteSetupItem', (node?: SetupNode) =>
      deleteSetupItem(node),
    ),
    vscode.commands.registerCommand('depChain.createSetup', (folderUri?: string) =>
      createSetup(folderUri),
    ),
    vscode.commands.registerCommand('depChain.cancel', () => cancelRun()),
    vscode.commands.registerCommand('depChain.retryFailed', () => retryFailed()),
    vscode.commands.registerCommand('depChain.validateConfig', () => validateConfig()),
    vscode.commands.registerCommand('depChain.openConfig', (folderUri?: string) =>
      openConfig(folderUri),
    ),
    vscode.commands.registerCommand('depChain.createConfig', (folderUri?: string) =>
      createConfigCommand(folderUri),
    ),
    vscode.commands.registerCommand('depChain.refreshSetups', () => setupTree?.refresh()),
    vscode.commands.registerCommand('depChain.showTerminal', () => showTerminal()),
  );

  const refresh = () => {
    setupTree?.refresh();
    void refreshIdleStatus();
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/dep-chain.json');
  watcher.onDidChange(refresh);
  watcher.onDidCreate(refresh);
  watcher.onDidDelete(refresh);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('depChain.configPath')) {
        refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
  );

  void refreshIdleStatus();
  log.info('Dep Chain activated.');
}

export function deactivate(): void {
  // The "Dep Chain" terminal is intentionally left open between sessions.
}

/**
 * The config contains executable content (shell commands, npm scripts), so nothing runs in a
 * workspace the user has not trusted.
 */
function ensureTrusted(): boolean {
  if (vscode.workspace.isTrusted) {
    return true;
  }

  void vscode.window
    .showErrorMessage(
      'Dep Chain: this workspace is not trusted. Trust it before running setups.',
      'Manage Workspace Trust',
    )
    .then((choice) => {
      if (choice === 'Manage Workspace Trust') {
        void vscode.commands.executeCommand('workbench.trust.manage');
      }
    });
  return false;
}

async function runSetup(arg?: RunSetupArg): Promise<void> {
  if (!ensureTrusted()) {
    return;
  }

  if (activeRun) {
    void vscode.window.showInformationMessage(
      'Dep Chain: a setup is already running. Cancel it first.',
    );
    return;
  }

  const prepared = await preparePlan('run', arg);
  if (!prepared) {
    return;
  }

  await executePlan(prepared.selection.uri, prepared.selection.setupName, prepared.plan, 0);
}

function runSetupItem(node?: SetupNode): Promise<void> | undefined {
  if (!node || node.kind !== 'setup') {
    return undefined;
  }
  return runSetup({
    setupName: node.name,
    folderUri: node.state.folder.uri.toString(),
  });
}

async function deleteSetupItem(node?: SetupNode): Promise<void> {
  if (!ensureTrusted()) {
    return;
  }
  if (!node || node.kind !== 'setup') {
    return;
  }

  const { uri, folder } = node.state;
  const name = node.name;

  let text: string;
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Dep Chain: cannot read ${uri.fsPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const result = removeSetupFromConfigText(text, name);
  if (result.error || result.text === undefined) {
    const choice = await vscode.window.showErrorMessage(
      `Dep Chain: ${result.error ?? 'Cannot update the configuration.'}`,
      'Open Config',
    );
    if (choice === 'Open Config') {
      await openDocument(uri);
    }
    setupTree?.refresh();
    return;
  }

  if (result.remaining === 0) {
    void vscode.window.showInformationMessage(
      'Dep Chain: cannot delete the last setup. The configuration must contain at least one setup.',
    );
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Dep Chain: delete setup "${name}" from ${vscode.workspace.asRelativePath(uri, false)} (${folder.name})?`,
    { modal: true },
    'Delete',
  );
  if (choice !== 'Delete') {
    return;
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(result.text, 'utf8'));
  log.info(`Deleted setup "${name}" from ${uri.fsPath}`);
  setupTree?.refresh();
  void refreshIdleStatus();
  void vscode.window.showInformationMessage(`Dep Chain: setup "${name}" deleted.`);
}

async function createSetup(folderUri?: string): Promise<void> {
  if (!ensureTrusted()) {
    return;
  }

  const folder = folderFromUri(folderUri) ?? (await resolveWorkspaceFolder());
  if (!folder) {
    void vscode.window.showErrorMessage('Dep Chain: open a folder to use this extension.');
    return;
  }

  const uri = resolveConfigUri(folder, configPath());
  const loaded = await loadConfig(uri);
  if (!loaded.config) {
    await reportDiagnostics(loaded.diagnostics, uri, log);
    return;
  }

  const config = loaded.config;
  const workingDirAbs = resolveWorkingDir(folder, config);

  const result = await runSetupWizard({
    workingDirAbs,
    existingNames: Object.keys(config.setups),
    deps: createProbeDeps(),
  });
  if (!result) {
    return;
  }

  // Re-read just before writing so edits made in the meantime are preserved.
  let text: string;
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Dep Chain: cannot read ${uri.fsPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const updated = addSetupToConfigText(text, result.name, result.setup);
  if (updated.error || updated.text === undefined) {
    const choice = await vscode.window.showErrorMessage(
      `Dep Chain: ${updated.error ?? 'Cannot update the configuration.'}`,
      'Open Config',
    );
    if (choice === 'Open Config') {
      await openDocument(uri);
    }
    return;
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(updated.text, 'utf8'));
  log.info(`Created setup "${result.name}" in ${uri.fsPath}`);
  setupTree?.refresh();
  void refreshIdleStatus();

  const choice = await vscode.window.showInformationMessage(
    `Dep Chain: setup "${result.name}" created.`,
    'Run now',
    'Open config',
  );
  if (choice === 'Run now') {
    await runSetup({ setupName: result.name, folderUri: folder.uri.toString() });
  } else if (choice === 'Open config') {
    await openDocument(uri);
  }
}

async function cancelRun(): Promise<void> {
  if (!activeRun) {
    void vscode.window.showInformationMessage('Dep Chain: nothing is running.');
    return;
  }
  await activeRun.engine.cancel();
}

async function retryFailed(): Promise<void> {
  if (!ensureTrusted()) {
    return;
  }

  if (activeRun) {
    void vscode.window.showInformationMessage(
      'Dep Chain: a setup is already running. Cancel it first.',
    );
    return;
  }

  const failure = lastFailure;
  if (!failure) {
    void vscode.window.showInformationMessage('Dep Chain: nothing to retry.');
    return;
  }

  await executePlan(failure.uri, failure.setupName, failure.plan, failure.stepIndex);
}

async function validateConfig(): Promise<void> {
  if (!ensureTrusted()) {
    return;
  }

  if (activeRun) {
    void vscode.window.showInformationMessage(
      'Dep Chain: a setup is already running. Cancel it first.',
    );
    return;
  }
  await preparePlan('validate');
}

async function openConfig(folderUri?: string): Promise<void> {
  if (!ensureTrusted()) {
    return;
  }

  const folder = folderFromUri(folderUri) ?? (await resolveWorkspaceFolder());
  if (!folder) {
    void vscode.window.showErrorMessage('Dep Chain: open a folder to use this extension.');
    return;
  }

  const uri = resolveConfigUri(folder, configPath());
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const choice = await vscode.window.showWarningMessage(
      'Dep Chain: config file not found. Create it?',
      'Create',
    );
    if (choice === 'Create') {
      await createConfig(uri);
    }
    return;
  }

  await openDocument(uri);
}

async function createConfigCommand(folderUri?: string): Promise<void> {
  if (!ensureTrusted()) {
    return;
  }

  const folder = folderFromUri(folderUri) ?? (await resolveWorkspaceFolder());
  if (!folder) {
    void vscode.window.showErrorMessage('Dep Chain: open a folder to use this extension.');
    return;
  }

  const uri = resolveConfigUri(folder, configPath());
  let exists = true;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    exists = false;
  }

  if (exists) {
    const choice = await vscode.window.showWarningMessage(
      `Dep Chain: ${uri.fsPath} already exists. Overwrite it?`,
      { modal: true },
      'Overwrite',
    );
    if (choice !== 'Overwrite') {
      return;
    }
  }

  await createConfig(uri);
}

async function createConfig(uri: vscode.Uri): Promise<void> {
  const template = {
    workingDir: '.',
    onDirty: 'fail',
    setups: {
      default: {
        steps: [{ repo: 'repo-a', branch: 'main', shell: 'npm run build' }],
        cmdstart: 'npm start',
      },
    },
  };

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(`${JSON.stringify(template, null, 2)}\n`, 'utf8'),
  );
  log.info(`Created config at ${uri.fsPath}`);
  setupTree?.refresh();
  await openDocument(uri);
}

function showTerminal(): void {
  const terminal = vscode.window.terminals.find((item) => item.name === TERMINAL_NAME);
  if (terminal) {
    terminal.show();
    return;
  }
  fallbackOutput.show(true);
}

function folderFromUri(value?: string): vscode.WorkspaceFolder | undefined {
  if (!value) {
    return undefined;
  }
  return (vscode.workspace.workspaceFolders ?? []).find(
    (folder) => folder.uri.toString() === value,
  );
}

function resolveWorkingDir(folder: vscode.WorkspaceFolder, config: RawConfig): string {
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.join(folder.uri.fsPath, config.workingDir);
}

async function loadSelection(preferred?: RunSetupArg): Promise<Selection | undefined> {
  const folder = folderFromUri(preferred?.folderUri) ?? (await resolveWorkspaceFolder());
  if (!folder) {
    void vscode.window.showErrorMessage('Dep Chain: open a folder to use this extension.');
    return undefined;
  }

  const uri = resolveConfigUri(folder, configPath());
  const loaded = await loadConfig(uri);
  if (!loaded.config) {
    await reportDiagnostics(loaded.diagnostics, uri, log);
    return undefined;
  }
  if (loaded.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    await reportDiagnostics(loaded.diagnostics, uri, log);
    return undefined;
  }

  const config = loaded.config;
  const names = Object.keys(config.setups);
  let setupName: string | undefined;

  const preferredName = preferred?.setupName;
  if (
    preferredName &&
    Object.prototype.hasOwnProperty.call(config.setups, preferredName)
  ) {
    setupName = preferredName;
  }

  if (!setupName) {
    if (names.length === 1) {
      setupName = names[0];
    } else {
      const picked = await vscode.window.showQuickPick(
        names.map((name) => {
          const setup = config.setups[name];
          const count = setup.steps.length;
          return {
            label: name,
            description: setup.description ?? `${count} step${count === 1 ? '' : 's'}`,
          };
        }),
        { placeHolder: 'Select a setup to run' },
      );
      if (!picked) {
        return undefined;
      }
      setupName = picked.label;
    }
  }

  return {
    folder,
    uri,
    config,
    setupName,
    setup: config.setups[setupName],
  };
}

async function preparePlan(
  mode: 'run' | 'validate',
  preferred?: RunSetupArg,
): Promise<Prepared | undefined> {
  const selection = await loadSelection(preferred);
  if (!selection) {
    return undefined;
  }

  const workingDirAbs = resolveWorkingDir(selection.folder, selection.config);
  const onDirty = selection.setup.onDirty ?? selection.config.onDirty ?? 'fail';

  const result = await preflight(
    selection.setupName,
    selection.setup,
    workingDirAbs,
    onDirty,
    createProbeDeps(),
  );

  const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
  if (warnings.length > 0) {
    log.warn(formatDiagnostics(warnings));
  }

  if (!result.plan) {
    await reportDiagnostics(result.diagnostics, selection.uri, log);
    return undefined;
  }

  if (mode === 'validate') {
    const count = result.plan.steps.length;
    void vscode.window.showInformationMessage(
      `Dep Chain: setup "${selection.setupName}" is valid (${count} step${
        count === 1 ? '' : 's'
      }).`,
    );
  }

  return { selection, plan: result.plan };
}

async function executePlan(
  uri: vscode.Uri,
  setupName: string,
  plan: ReadonlyPlan,
  fromStep: number,
): Promise<void> {
  // A retry is only valid for the failure of the current run.
  lastFailure = undefined;

  let adapter: TerminalAdapter;
  try {
    adapter = await acquireAdapter({
      timeoutMs: shellIntegrationTimeoutMs(),
      log,
      output: fallbackOutput,
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Dep Chain: cannot start the terminal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const controller = new AbortController();
  const engine = new StepEngine({
    plan,
    adapter,
    log,
    graceMs: cmdStartGracePeriodMs(),
    confirmDiscard,
  });

  activeRun = { engine, controller };
  statusBar.setRunning(setupName);

  let failedStepIndex: number | undefined;
  let failureMessage: string | undefined;

  const subscription = engine.onEvent((event) => {
    if (event.type === 'stepStarted') {
      statusBar.setRunning(`${setupName} (${event.index + 1}/${event.total})`);
    } else if (event.type === 'finished' && event.status === 'failed') {
      failedStepIndex = event.failedStepIndex;
      failureMessage = event.message;
    }
  });

  if (fromStep > 0) {
    log.info(`Retrying setup "${setupName}" from step ${fromStep + 1}.`);
  }

  let status: RunStatus = 'failed';
  try {
    status =
      fromStep > 0
        ? await engine.retryFrom(fromStep, controller.signal)
        : await engine.run(controller.signal);
  } finally {
    subscription.dispose();
    adapter.dispose();
    activeRun = undefined;
    void refreshIdleStatus();
  }

  await handleStatus(status, uri, setupName, plan, failedStepIndex, failureMessage);
}

async function handleStatus(
  status: RunStatus,
  uri: vscode.Uri,
  setupName: string,
  plan: ReadonlyPlan,
  failedStepIndex: number | undefined,
  failureMessage: string | undefined,
): Promise<void> {
  switch (status) {
    case 'succeeded':
      lastFailure = undefined;
      statusBar.setSucceeded(setupName);
      void vscode.window.showInformationMessage(`Dep Chain: setup "${setupName}" completed.`);
      return;

    case 'started':
      lastFailure = undefined;
      statusBar.setStarted();
      void vscode.window
        .showInformationMessage(`Dep Chain: setup "${setupName}" started.`, 'Show Terminal')
        .then((choice) => {
          if (choice === 'Show Terminal') {
            showTerminal();
          }
        });
      return;

    case 'cancelled':
      statusBar.setCancelled();
      log.info('Run cancelled.');
      return;

    case 'failed': {
      const step = failedStepIndex !== undefined ? plan.steps[failedStepIndex] : undefined;
      statusBar.setFailed(step ? step.repoName : setupName);
      if (failedStepIndex !== undefined) {
        lastFailure = { uri, setupName, plan, stepIndex: failedStepIndex };
      }

      const action = await showStepFailure(failureMessage ?? 'The run failed.');
      if (action === 'showTerminal') {
        showTerminal();
      } else if (action === 'retry') {
        void retryFailed();
      } else if (action === 'openConfig') {
        await openDocument(uri);
      }
      return;
    }

    default:
      return;
  }
}

async function confirmDiscard(dirty: DirtyRepo[]): Promise<boolean> {
  const summary = dirty
    .map(
      (repo) =>
        `- ${repo.repoAbsPath} (${repo.files.length} file${
          repo.files.length === 1 ? '' : 's'
        })`,
    )
    .join('\n');
  const choice = await vscode.window.showWarningMessage(
    `Dep Chain will discard local changes in ${
      dirty.length === 1 ? '1 repository' : `${dirty.length} repositories`
    }:\n${summary}\nContinue?`,
    { modal: true },
    'Discard changes',
  );
  return choice === 'Discard changes';
}

async function refreshIdleStatus(): Promise<void> {
  if (activeRun) {
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    statusBar.setIdle(0);
    return;
  }

  try {
    const loaded = await loadConfig(resolveConfigUri(folder, configPath()));
    statusBar.setIdle(loaded.config ? Object.keys(loaded.config.setups).length : 0);
  } catch {
    statusBar.setIdle(0);
  }
}
