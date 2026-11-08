// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import { CheckoutPlan, PlannedStart, PlannedStep } from '../model';
import { quotePosix } from '../util/shellQuote';

export function cdCommand(dir: string): string {
  return `cd ${quotePosix(dir)}`;
}

export function fetchCommand(repoAbsPath: string): string {
  return `${cdCommand(repoAbsPath)} && git fetch --all --prune`;
}

export function checkoutCommand(checkout: CheckoutPlan): string {
  switch (checkout.kind) {
    case 'branch':
      return `git checkout ${quotePosix(checkout.branch)}`;
    case 'track':
      // The plain checkout succeeds if the branch was created by a previous (failed) run,
      // which makes "retry failed step" safe.
      return (
        `git checkout ${quotePosix(checkout.branch)} || ` +
        `git checkout -b ${quotePosix(checkout.branch)} --track ${quotePosix(checkout.remoteRef)}`
      );
    case 'detached':
      return `git checkout ${quotePosix(checkout.ref)}`;
  }
}

export function checkoutCommandLine(step: PlannedStep): string | undefined {
  if (!step.checkout) {
    return undefined;
  }
  return `${cdCommand(step.repoAbsPath)} && ${checkoutCommand(step.checkout)}`;
}

export function pullCommand(repoAbsPath: string): string {
  return `${cdCommand(repoAbsPath)} && git pull --ff-only`;
}

export function stepRunLine(step: PlannedStep): string | undefined {
  if (!step.shell) {
    return undefined;
  }
  return `${cdCommand(step.repoAbsPath)} && ${step.shell}`;
}

export function startCommandLine(start: PlannedStart): string {
  return `${cdCommand(start.repoAbsPath)} && ${start.shell}`;
}

export function stashCommand(
  repoAbsPath: string,
  setupName: string,
  repoName: string,
): string {
  const message = `dep-chain:${setupName}:${repoName}`;
  return `${cdCommand(repoAbsPath)} && git stash push -u -m ${quotePosix(message)}`;
}

export function discardCommand(repoAbsPath: string): string {
  return `${cdCommand(repoAbsPath)} && git checkout -- . && git clean -fd`;
}
