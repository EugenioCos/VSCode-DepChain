// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RawSetup, RawStep } from '../model';
import type { ProbeDeps } from '../planner/probes';

export interface SetupWizardOptions {
  workingDirAbs: string;
  existingNames: readonly string[];
  deps: ProbeDeps;
}

export interface SetupWizardResult {
  name: string;
  setup: RawSetup;
}

interface RepoChoice {
  name: string;
  absPath: string;
}

type BranchChoice = { kind: 'branch'; branch: string } | { kind: 'current' };

/**
 * Collects a new setup through input boxes and quick picks. Returns undefined when the user
 * cancels at any point; nothing is written here.
 */
export async function runSetupWizard(
  options: SetupWizardOptions,
): Promise<SetupWizardResult | undefined> {
  const name = await askName(options.existingNames);
  if (!name) {
    return undefined;
  }

  const repos = await listRepos(options.workingDirAbs, options.deps);
  if (repos.length === 0) {
    void vscode.window.showErrorMessage(
      `Dep Chain: no git repositories found under ${options.workingDirAbs}.`,
    );
    return undefined;
  }

  const steps: RawStep[] = [];
  for (;;) {
    const repo = await pickRepo(repos);
    if (!repo) {
      return undefined;
    }

    const branch = await pickBranch(repo.absPath, options.deps);
    if (!branch) {
      return undefined;
    }

    const shell = await askShell(repo.name);
    if (shell === undefined) {
      return undefined;
    }

    const step: RawStep = { repo: repo.name };
    if (branch.kind === 'branch') {
      step.branch = branch.branch;
    }
    if (shell.trim()) {
      step.shell = shell.trim();
    }
    steps.push(step);

    const next = await vscode.window.showQuickPick(
      [
        { label: 'Add another step', value: 'add' as const },
        { label: 'Finish', value: 'finish' as const },
      ],
      { title: 'Dep Chain: new setup', placeHolder: `Step ${steps.length} added` },
    );
    if (!next) {
      return undefined;
    }
    if (next.value === 'finish') {
      break;
    }
  }

  const cmdstart = await vscode.window.showInputBox({
    title: 'Dep Chain: new setup',
    prompt: 'Optional start command, executed after the chain',
    placeHolder: 'npm start',
  });
  if (cmdstart === undefined) {
    return undefined;
  }

  const description = await vscode.window.showInputBox({
    title: 'Dep Chain: new setup',
    prompt: 'Optional description',
  });
  if (description === undefined) {
    return undefined;
  }

  const setup: RawSetup = { steps };
  if (cmdstart.trim()) {
    setup.cmdstart = cmdstart.trim();
  }
  if (description.trim()) {
    setup.description = description.trim();
  }

  return { name, setup };
}

async function askName(existing: readonly string[]): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'Dep Chain: new setup',
    prompt: 'Setup name',
    placeHolder: 'e.g. local-deps',
    validateInput: (input) => {
      const name = input.trim();
      if (!name) {
        return 'The setup name must not be empty.';
      }
      if (existing.includes(name)) {
        return `A setup named "${name}" already exists.`;
      }
      return undefined;
    },
  });
  return value?.trim();
}

async function listRepos(
  workingDirAbs: string,
  deps: ProbeDeps,
): Promise<RepoChoice[]> {
  let names: string[];
  try {
    const entries = await fs.readdir(workingDirAbs, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }

  const repos: RepoChoice[] = [];
  for (const name of names) {
    const absPath = path.join(workingDirAbs, name);
    if (await deps.isGitWorkTree(absPath)) {
      repos.push({ name, absPath });
    }
  }
  return repos;
}

async function pickRepo(repos: RepoChoice[]): Promise<RepoChoice | undefined> {
  const picked = await vscode.window.showQuickPick(
    repos.map((repo) => ({ label: repo.name, description: repo.absPath, repo })),
    {
      title: 'Dep Chain: new setup',
      placeHolder: 'Select a repository for the step',
    },
  );
  return picked?.repo;
}

async function pickBranch(
  repoAbsPath: string,
  deps: ProbeDeps,
): Promise<BranchChoice | undefined> {
  const [locals, remotes, current] = await Promise.all([
    deps.localBranches(repoAbsPath),
    deps.remoteBranches(repoAbsPath),
    deps.currentBranch(repoAbsPath),
  ]);

  const items: (vscode.QuickPickItem & { choice?: BranchChoice })[] = [];

  if (current) {
    items.push({
      label: `$(check) ${current}`,
      description: 'current branch',
      choice: { kind: 'branch', branch: current },
    });
  }
  for (const branch of locals) {
    if (branch === current) {
      continue;
    }
    items.push({ label: branch, description: 'local branch', choice: { kind: 'branch', branch } });
  }
  for (const branch of remotes) {
    if (locals.includes(branch)) {
      continue;
    }
    items.push({ label: branch, description: 'remote branch', choice: { kind: 'branch', branch } });
  }

  items.push({
    label: '$(edit) Enter a branch or ref…',
    description: 'tag, SHA or another branch',
  });
  items.push({
    label: '$(circle-slash) Keep the current checkout',
    description: 'do not change branch',
    choice: { kind: 'current' },
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Dep Chain: new setup',
    placeHolder: `Select a branch for ${path.basename(repoAbsPath)}`,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.choice) {
    return picked.choice;
  }

  const custom = await vscode.window.showInputBox({
    title: 'Dep Chain: new setup',
    prompt: `Branch or ref for ${path.basename(repoAbsPath)}`,
    placeHolder: 'e.g. origin/feature or v1.2.3',
    validateInput: (input) => (input.trim() ? undefined : 'Enter a branch or ref.'),
  });
  return custom ? { kind: 'branch', branch: custom.trim() } : undefined;
}

async function askShell(repoName: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Dep Chain: new setup',
    prompt: `Shell command for ${repoName} (optional)`,
    placeHolder: 'npm run build',
  });
}
