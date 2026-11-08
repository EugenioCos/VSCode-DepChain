// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as assert from 'node:assert';
import {
  checkoutCommand,
  checkoutCommandLine,
  fetchCommand,
  pullCommand,
  startCommandLine,
  stepRunLine,
  stashCommand,
} from '../../engine/buildCommand';
import { PlannedStart, PlannedStep } from '../../model';

function step(overrides: Partial<PlannedStep> = {}): PlannedStep {
  return {
    index: 0,
    repoName: 'repo1',
    repoAbsPath: '/work/example repos/repo1',
    pull: false,
    ...overrides,
  };
}

describe('fetchCommand', () => {
  it('fetches every remote and prunes stale refs in the repo', () => {
    assert.strictEqual(
      fetchCommand('/work/example repos/repo1'),
      "cd '/work/example repos/repo1' && git fetch --all --prune",
    );
  });
});

describe('checkoutCommand', () => {
  it('checks out an existing branch', () => {
    assert.strictEqual(
      checkoutCommand({ kind: 'branch', branch: 'branch-1' }),
      "git checkout 'branch-1'",
    );
  });

  it('falls back to a tracking branch', () => {
    assert.strictEqual(
      checkoutCommand({ kind: 'track', branch: 'branch-1', remoteRef: 'origin/branch-1' }),
      "git checkout 'branch-1' || git checkout -b 'branch-1' --track 'origin/branch-1'",
    );
  });

  it('checks out a detached ref', () => {
    assert.strictEqual(
      checkoutCommand({ kind: 'detached', ref: 'v1.0.0' }),
      "git checkout 'v1.0.0'",
    );
  });
});

describe('checkoutCommandLine', () => {
  it('cds into the repo and checks out the branch', () => {
    assert.strictEqual(
      checkoutCommandLine(step({ checkout: { kind: 'branch', branch: 'branch-1' } })),
      "cd '/work/example repos/repo1' && git checkout 'branch-1'",
    );
  });

  it('returns undefined when no checkout is needed', () => {
    assert.strictEqual(checkoutCommandLine(step()), undefined);
  });
});

describe('pullCommand', () => {
  it('pulls the current branch fast-forward only', () => {
    assert.strictEqual(
      pullCommand('/work/example repos/repo1'),
      "cd '/work/example repos/repo1' && git pull --ff-only",
    );
  });
});

describe('stepRunLine', () => {
  it('runs the raw shell command without quoting it', () => {
    assert.strictEqual(
      stepRunLine(step({ shell: 'npm run build && npm pack' })),
      "cd '/work/example repos/repo1' && npm run build && npm pack",
    );
  });

  it('returns undefined when the step has no command', () => {
    assert.strictEqual(stepRunLine(step()), undefined);
  });
});

describe('startCommandLine', () => {
  it('cds into the start repo and runs the raw command', () => {
    const start: PlannedStart = {
      repoName: 'repo3',
      repoAbsPath: '/work/example repos/repo3',
      shell: 'npm start',
    };
    assert.strictEqual(
      startCommandLine(start),
      "cd '/work/example repos/repo3' && npm start",
    );
  });
});

describe('stashCommand', () => {
  it('stashes tracked and untracked changes with a recognizable message', () => {
    assert.strictEqual(
      stashCommand('/work/example repos/repo1', 'dev', 'repo1'),
      "cd '/work/example repos/repo1' && git stash push -u -m 'dep-chain:dev:repo1'",
    );
  });
});
