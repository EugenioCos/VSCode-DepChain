// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as path from 'node:path';
import {
  CheckoutPlan,
  Diagnostic,
  DirtyRepo,
  OnDirty,
  PlannedStart,
  PlannedStep,
  RawSetup,
  ReadonlyPlan,
} from '../model';
import type { ProbeDeps } from './probes';

export interface PreflightResult {
  plan?: ReadonlyPlan;
  diagnostics: Diagnostic[];
}

/**
 * Validates the whole setup without side effects and builds the immutable execution plan.
 * Every problem is collected so the user sees them all at once; if any error is found no
 * plan is returned and no repository is touched.
 */
export async function preflight(
  setupName: string,
  setup: RawSetup,
  workingDirAbs: string,
  onDirty: OnDirty,
  deps: ProbeDeps,
): Promise<PreflightResult> {
  const diagnostics: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const resolvedWorkingDir = path.resolve(workingDirAbs);

  if (!(await deps.isDirectory(resolvedWorkingDir))) {
    return {
      diagnostics: [
        {
          severity: 'error',
          path: 'workingDir',
          message: `Working directory not found: ${resolvedWorkingDir}`,
        },
      ],
    };
  }

  const steps: PlannedStep[] = [];

  for (let index = 0; index < setup.steps.length; index += 1) {
    const raw = setup.steps[index];
    const basePath = `setups.${setupName}.steps[${index}]`;
    const repoAbsPath = path.resolve(resolvedWorkingDir, raw.repo);

    if (!(await deps.isDirectory(repoAbsPath))) {
      diagnostics.push({
        severity: 'error',
        path: `${basePath}.repo`,
        message: `Repository not found: ${repoAbsPath}`,
      });
      continue;
    }

    if (!(await deps.isGitWorkTree(repoAbsPath))) {
      diagnostics.push({
        severity: 'error',
        path: `${basePath}.repo`,
        message: `Not a git repository: ${repoAbsPath}`,
      });
      continue;
    }

    let checkout: CheckoutPlan | undefined;
    let pull = false;
    if (raw.branch) {
      const current = await deps.currentBranch(repoAbsPath);
      if (current !== raw.branch) {
        const locals = await deps.localBranches(repoAbsPath);
        if (locals.includes(raw.branch)) {
          checkout = { kind: 'branch', branch: raw.branch };
        } else {
          const remoteRef = await deps.remoteTracking(repoAbsPath, raw.branch);
          if (remoteRef) {
            checkout = { kind: 'track', branch: raw.branch, remoteRef };
          } else if (await deps.refExists(repoAbsPath, raw.branch)) {
            checkout = { kind: 'detached', ref: raw.branch };
          } else {
            diagnostics.push({
              severity: 'error',
              path: `${basePath}.branch`,
              message: `Branch or ref "${raw.branch}" not found in ${repoAbsPath}.`,
            });
          }
        }
      }

      if (checkout?.kind === 'track') {
        // `git checkout -b <branch> --track <remote>` sets the upstream.
        pull = true;
      } else if (checkout?.kind === 'detached') {
        pull = false;
      } else if (current === raw.branch || checkout?.kind === 'branch') {
        const upstream = await deps.upstream(repoAbsPath, raw.branch);
        pull = upstream !== null;
        if (!pull) {
          warnings.push({
            severity: 'warning',
            path: `${basePath}.branch`,
            message: `Branch "${raw.branch}" has no upstream; git pull will be skipped.`,
          });
        }
      }
    }

    steps.push({
      index,
      repoName: raw.repo,
      repoAbsPath,
      branch: raw.branch,
      checkout,
      pull,
      shell: raw.shell,
    });
  }

  let start: PlannedStart | undefined;
  if (setup.cmdstart) {
    const startRepoName = setup.startRepo ?? setup.steps[setup.steps.length - 1]?.repo;
    const startStep = startRepoName
      ? steps.find((step) => step.repoName === startRepoName)
      : undefined;
    if (!startRepoName) {
      diagnostics.push({
        severity: 'error',
        path: `setups.${setupName}.cmdstart`,
        message: '`cmdstart` requires at least one step.',
      });
    } else if (!startStep) {
      diagnostics.push({
        severity: 'error',
        path: `setups.${setupName}.startRepo`,
        message: `Cannot run cmdstart: repo "${startRepoName}" is not a valid step repo.`,
      });
    } else {
      start = {
        repoName: startStep.repoName,
        repoAbsPath: startStep.repoAbsPath,
        shell: setup.cmdstart,
      };
    }
  }

  // Only repos that actually need a checkout can be blocked by a dirty working tree.
  const needsCheckout = new Map<string, { repoName: string; index: number }>();
  steps.forEach((step, index) => {
    if (step.checkout) {
      needsCheckout.set(step.repoAbsPath, { repoName: step.repoName, index });
    }
  });

  const dirty: DirtyRepo[] = [];
  for (const [repoAbsPath, entry] of needsCheckout) {
    const status = await deps.status(repoAbsPath);
    if (status.files.length === 0) {
      continue;
    }

    dirty.push({
      repoName: entry.repoName,
      repoAbsPath,
      branch: status.branch,
      files: status.files,
    });

    const preview = status.files.slice(0, 5).join('\n');
    const omitted = status.files.length > 5 ? `\n… and ${status.files.length - 5} more` : '';
    const detail = `Repository "${entry.repoName}" has uncommitted changes:\n${preview}${omitted}`;

    if (onDirty === 'fail') {
      diagnostics.push({
        severity: 'error',
        path: `setups.${setupName}.steps[${entry.index}].repo`,
        message: detail,
      });
    } else {
      warnings.push({
        severity: 'warning',
        path: `setups.${setupName}.steps[${entry.index}].repo`,
        message: `${detail}\nDep Chain will ${onDirty === 'stash' ? 'stash them' : 'discard them'} before checkout.`,
      });
    }
  }

  diagnostics.push(...warnings);

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { diagnostics };
  }

  return {
    diagnostics,
    plan: {
      setupName,
      workingDirAbs: resolvedWorkingDir,
      onDirty,
      steps,
      start,
      dirty,
      warnings,
    },
  };
}
