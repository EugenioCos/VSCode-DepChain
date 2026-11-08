// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import { Diagnostic, OnDirty, RawConfig, RawSetup, RawStep } from '../model';

const ON_DIRTY_VALUES: readonly OnDirty[] = ['fail', 'stash', 'discard'];

export interface ValidationResult {
  config?: RawConfig;
  diagnostics: Diagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOnDirty(value: unknown): value is OnDirty {
  return typeof value === 'string' && (ON_DIRTY_VALUES as readonly string[]).includes(value);
}

/**
 * Structural and semantic validation of the raw JSON. All problems are reported together.
 * Pure: no file system or VS Code access.
 */
export function validateConfig(raw: unknown): ValidationResult {
  const diagnostics: Diagnostic[] = [];

  if (!isRecord(raw)) {
    diagnostics.push({
      severity: 'error',
      path: '',
      message: 'The configuration must be a JSON object.',
    });
    return { diagnostics };
  }

  const workingDir = raw.workingDir;
  if (!isNonEmptyString(workingDir)) {
    diagnostics.push({
      severity: 'error',
      path: 'workingDir',
      message: '`workingDir` must be a non-empty string.',
    });
  }

  let topLevelOnDirty: OnDirty | undefined;
  if (raw.onDirty !== undefined) {
    if (isOnDirty(raw.onDirty)) {
      topLevelOnDirty = raw.onDirty;
    } else {
      diagnostics.push({
        severity: 'error',
        path: 'onDirty',
        message: '`onDirty` must be one of "fail", "stash" or "discard".',
      });
    }
  }

  const setupsRaw = raw.setups;
  if (!isRecord(setupsRaw) || Object.keys(setupsRaw).length === 0) {
    diagnostics.push({
      severity: 'error',
      path: 'setups',
      message: '`setups` must be an object with at least one setup.',
    });
    return { diagnostics };
  }

  const setups: Record<string, RawSetup> = {};
  for (const [name, value] of Object.entries(setupsRaw)) {
    if (!isNonEmptyString(name)) {
      diagnostics.push({
        severity: 'error',
        path: 'setups',
        message: 'Setup names must be non-empty.',
      });
      continue;
    }
    const setup = validateSetup(name, value, diagnostics);
    if (setup) {
      setups[name] = setup;
    }
  }

  if (diagnostics.some((d) => d.severity === 'error')) {
    return { diagnostics };
  }

  const config: RawConfig = {
    workingDir: workingDir as string,
    setups,
  };
  if (typeof raw.$schema === 'string') {
    config.$schema = raw.$schema;
  }
  if (topLevelOnDirty) {
    config.onDirty = topLevelOnDirty;
  }

  return { config, diagnostics };
}

function validateSetup(
  setupName: string,
  value: unknown,
  diagnostics: Diagnostic[],
): RawSetup | undefined {
  const basePath = `setups.${setupName}`;

  if (!isRecord(value)) {
    diagnostics.push({
      severity: 'error',
      path: basePath,
      message: 'A setup must be an object.',
    });
    return undefined;
  }

  const stepsRaw = value.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    diagnostics.push({
      severity: 'error',
      path: `${basePath}.steps`,
      message: '`steps` must be a non-empty array.',
    });
    return undefined;
  }

  const steps: RawStep[] = [];
  stepsRaw.forEach((stepValue, index) => {
    const path = `${basePath}.steps[${index}]`;
    if (!isRecord(stepValue)) {
      diagnostics.push({ severity: 'error', path, message: 'A step must be an object.' });
      return;
    }

    if (!isNonEmptyString(stepValue.repo)) {
      diagnostics.push({
        severity: 'error',
        path: `${path}.repo`,
        message: '`repo` must be a non-empty string.',
      });
      return;
    }

    const step: RawStep = { repo: stepValue.repo };
    let valid = true;

    if (stepValue.branch !== undefined) {
      if (isNonEmptyString(stepValue.branch)) {
        step.branch = stepValue.branch;
      } else {
        valid = false;
        diagnostics.push({
          severity: 'error',
          path: `${path}.branch`,
          message: '`branch` must be a non-empty string.',
        });
      }
    }

    if (stepValue.shell !== undefined) {
      if (isNonEmptyString(stepValue.shell)) {
        step.shell = stepValue.shell;
      } else {
        valid = false;
        diagnostics.push({
          severity: 'error',
          path: `${path}.shell`,
          message: '`shell` must be a non-empty command.',
        });
      }
    }

    if (valid) {
      steps.push(step);
    }
  });

  const setup: RawSetup = { steps };

  if (value.description !== undefined) {
    if (typeof value.description === 'string') {
      setup.description = value.description;
    } else {
      diagnostics.push({
        severity: 'error',
        path: `${basePath}.description`,
        message: '`description` must be a string.',
      });
    }
  }

  if (value.onDirty !== undefined) {
    if (isOnDirty(value.onDirty)) {
      setup.onDirty = value.onDirty;
    } else {
      diagnostics.push({
        severity: 'error',
        path: `${basePath}.onDirty`,
        message: '`onDirty` must be one of "fail", "stash" or "discard".',
      });
    }
  }

  if (value.cmdstart !== undefined) {
    if (isNonEmptyString(value.cmdstart)) {
      setup.cmdstart = value.cmdstart;
    } else {
      diagnostics.push({
        severity: 'error',
        path: `${basePath}.cmdstart`,
        message: '`cmdstart` must be a non-empty command.',
      });
    }
  }

  if (value.startRepo !== undefined) {
    if (!isNonEmptyString(value.startRepo)) {
      diagnostics.push({
        severity: 'error',
        path: `${basePath}.startRepo`,
        message: '`startRepo` must be a non-empty repo name.',
      });
    } else {
      setup.startRepo = value.startRepo;
      if (!setup.cmdstart) {
        diagnostics.push({
          severity: 'warning',
          path: `${basePath}.startRepo`,
          message: '`startRepo` has no effect without `cmdstart`.',
        });
      } else if (!steps.some((step) => step.repo === value.startRepo)) {
        diagnostics.push({
          severity: 'error',
          path: `${basePath}.startRepo`,
          message: `\`startRepo\` must be one of the step repos (got "${value.startRepo}").`,
        });
      }
    }
  }

  return setup;
}
