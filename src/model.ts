// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

export type OnDirty = 'fail' | 'stash' | 'discard';

export interface RawStep {
  repo: string;
  branch?: string;
  shell?: string;
}

export interface RawSetup {
  description?: string;
  onDirty?: OnDirty;
  steps: RawStep[];
  cmdstart?: string;
  startRepo?: string;
}

export interface RawConfig {
  $schema?: string;
  workingDir: string;
  onDirty?: OnDirty;
  setups: Record<string, RawSetup>;
}

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  /** JSON-ish path, e.g. `setups.dev.steps[1].branch`. Empty for top-level errors. */
  path: string;
  message: string;
}

export type CheckoutPlan =
  | { kind: 'branch'; branch: string }
  | { kind: 'track'; branch: string; remoteRef: string }
  | { kind: 'detached'; ref: string };

export interface PlannedStep {
  index: number;
  repoName: string;
  repoAbsPath: string;
  branch?: string;
  /** Absent when the repo is already on the requested branch. */
  checkout?: CheckoutPlan;
  /** True when `git pull --ff-only` should run after the checkout. */
  pull: boolean;
  /** Raw shell command executed after fetch/checkout/pull. */
  shell?: string;
}

export interface PlannedStart {
  repoName: string;
  repoAbsPath: string;
  shell: string;
}

export interface DirtyRepo {
  repoName: string;
  repoAbsPath: string;
  branch: string;
  files: string[];
}

export interface ReadonlyPlan {
  setupName: string;
  workingDirAbs: string;
  onDirty: OnDirty;
  steps: PlannedStep[];
  start?: PlannedStart;
  /** Repos that need a checkout and currently have uncommitted changes. */
  dirty: DirtyRepo[];
  warnings: Diagnostic[];
}
