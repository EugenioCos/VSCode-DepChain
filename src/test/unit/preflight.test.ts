// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as assert from 'node:assert';
import * as path from 'node:path';
import { RawSetup } from '../../model';
import { preflight } from '../../planner/preflight';
import type { ProbeDeps } from '../../planner/probes';

const WORKDIR = '/work/repos';

function repoPath(name: string): string {
  return path.resolve(WORKDIR, name);
}

function makeDeps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    isDirectory: async () => true,
    isGitWorkTree: async () => true,
    currentBranch: async () => 'main',
    localBranches: async () => ['branch-1'],
    remoteBranches: async () => [],
    remoteTracking: async () => null,
    refExists: async () => false,
    upstream: async () => 'origin/branch-1',
    status: async () => ({ branch: 'main', files: [] }),
    ...overrides,
  };
}

function makeSetup(overrides: Partial<RawSetup> = {}): RawSetup {
  return {
    steps: [{ repo: 'repo1', branch: 'branch-1', shell: 'npm run cmd1' }],
    ...overrides,
  };
}

function errorPaths(diagnostics: { severity: string; path: string }[]): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.path);
}

describe('preflight', () => {
  it('builds a plan for a valid setup', async () => {
    const result = await preflight('dev', makeSetup(), WORKDIR, 'fail', makeDeps());

    assert.ok(result.plan);
    assert.deepStrictEqual(errorPaths(result.diagnostics), []);
    assert.strictEqual(result.plan!.steps.length, 1);
    assert.deepStrictEqual(result.plan!.steps[0].checkout, {
      kind: 'branch',
      branch: 'branch-1',
    });
    assert.strictEqual(result.plan!.steps[0].shell, 'npm run cmd1');
  });

  it('enables pull when the branch has an upstream', async () => {
    const result = await preflight('dev', makeSetup(), WORKDIR, 'fail', makeDeps());

    assert.ok(result.plan);
    assert.strictEqual(result.plan!.steps[0].pull, true);
  });

  it('skips pull and warns when the branch has no upstream', async () => {
    const result = await preflight(
      'dev',
      makeSetup(),
      WORKDIR,
      'fail',
      makeDeps({ upstream: async () => null }),
    );

    assert.ok(result.plan);
    assert.strictEqual(result.plan!.steps[0].pull, false);
    assert.ok(
      result.plan!.warnings.some((warning) => warning.message.includes('no upstream')),
    );
  });

  it('enables pull for a tracked branch', async () => {
    const result = await preflight(
      'dev',
      makeSetup(),
      WORKDIR,
      'fail',
      makeDeps({
        localBranches: async () => [],
        remoteTracking: async () => 'origin/branch-1',
      }),
    );

    assert.strictEqual(result.plan!.steps[0].pull, true);
  });

  it('skips pull for a detached ref', async () => {
    const result = await preflight(
      'dev',
      makeSetup(),
      WORKDIR,
      'fail',
      makeDeps({ localBranches: async () => [], refExists: async () => true }),
    );

    assert.deepStrictEqual(result.plan!.steps[0].checkout, {
      kind: 'detached',
      ref: 'branch-1',
    });
    assert.strictEqual(result.plan!.steps[0].pull, false);
  });

  it('skips checkout when the repo is already on the branch', async () => {
    let statusCalls = 0;
    const deps = makeDeps({
      currentBranch: async () => 'branch-1',
      status: async () => {
        statusCalls += 1;
        return { branch: 'branch-1', files: [' M package.json'] };
      },
    });

    const result = await preflight('dev', makeSetup(), WORKDIR, 'fail', deps);

    assert.ok(result.plan);
    assert.strictEqual(result.plan!.steps[0].checkout, undefined);
    assert.strictEqual(statusCalls, 0);
    assert.strictEqual(result.plan!.dirty.length, 0);
  });

  it('uses the remote tracking branch when the local branch is missing', async () => {
    const deps = makeDeps({
      localBranches: async () => [],
      remoteTracking: async () => 'origin/branch-1',
    });

    const result = await preflight('dev', makeSetup(), WORKDIR, 'fail', deps);

    assert.deepStrictEqual(result.plan!.steps[0].checkout, {
      kind: 'track',
      branch: 'branch-1',
      remoteRef: 'origin/branch-1',
    });
  });

  it('checks out a tag or SHA in detached mode', async () => {
    const deps = makeDeps({
      localBranches: async () => [],
      refExists: async () => true,
    });

    const result = await preflight('dev', makeSetup(), WORKDIR, 'fail', deps);

    assert.deepStrictEqual(result.plan!.steps[0].checkout, {
      kind: 'detached',
      ref: 'branch-1',
    });
  });

  it('reports a missing branch', async () => {
    const deps = makeDeps({ localBranches: async () => [] });

    const result = await preflight('dev', makeSetup(), WORKDIR, 'fail', deps);

    assert.strictEqual(result.plan, undefined);
    assert.deepStrictEqual(errorPaths(result.diagnostics), ['setups.dev.steps[0].branch']);
  });

  it('reports a missing repository', async () => {
    const deps = makeDeps({
      isDirectory: async (dir) => dir !== repoPath('repo1'),
    });

    const result = await preflight('dev', makeSetup(), WORKDIR, 'fail', deps);

    assert.strictEqual(result.plan, undefined);
    assert.deepStrictEqual(errorPaths(result.diagnostics), ['setups.dev.steps[0].repo']);
  });

  it('reports a directory that is not a git work tree', async () => {
    const deps = makeDeps({ isGitWorkTree: async () => false });

    const result = await preflight('dev', makeSetup(), WORKDIR, 'fail', deps);

    assert.strictEqual(result.plan, undefined);
    assert.deepStrictEqual(errorPaths(result.diagnostics), ['setups.dev.steps[0].repo']);
  });

  it('fails loud on a dirty working tree when onDirty is fail', async () => {
    const result = await preflight(
      'dev',
      makeSetup(),
      WORKDIR,
      'fail',
      makeDeps({
        status: async () => ({ branch: 'main', files: [' M package.json', '?? notes.txt'] }),
      }),
    );

    assert.strictEqual(result.plan, undefined);
    assert.deepStrictEqual(errorPaths(result.diagnostics), ['setups.dev.steps[0].repo']);
    const message = result.diagnostics.find(
      (diagnostic) => diagnostic.severity === 'error',
    )!.message;
    assert.ok(message.includes('uncommitted changes'));
    assert.ok(message.includes('M package.json'));
  });

  it('records dirty repos and warns when onDirty is stash', async () => {
    const result = await preflight(
      'dev',
      makeSetup(),
      WORKDIR,
      'stash',
      makeDeps({ status: async () => ({ branch: 'main', files: [' M package.json'] }) }),
    );

    assert.ok(result.plan);
    assert.strictEqual(result.plan!.onDirty, 'stash');
    assert.strictEqual(result.plan!.dirty.length, 1);
    assert.deepStrictEqual(result.plan!.dirty[0].files, [' M package.json']);
    assert.strictEqual(result.plan!.warnings.length, 1);
    assert.ok(result.plan!.warnings[0].message.includes('stash'));
  });

  it('records dirty repos when onDirty is discard', async () => {
    const result = await preflight(
      'dev',
      makeSetup(),
      WORKDIR,
      'discard',
      makeDeps({ status: async () => ({ branch: 'main', files: [' M package.json'] }) }),
    );

    assert.ok(result.plan);
    assert.strictEqual(result.plan!.dirty.length, 1);
    assert.ok(result.plan!.warnings[0].message.includes('discard'));
  });

  it('reports a missing working directory', async () => {
    const result = await preflight(
      'dev',
      makeSetup(),
      WORKDIR,
      'fail',
      makeDeps({ isDirectory: async () => false }),
    );

    assert.strictEqual(result.plan, undefined);
    assert.deepStrictEqual(errorPaths(result.diagnostics), ['workingDir']);
  });

  it('runs cmdstart in the last step repo by default', async () => {
    const result = await preflight(
      'dev',
      makeSetup({
        steps: [
          { repo: 'repo1', branch: 'branch-1' },
          { repo: 'repo2', branch: 'branch-2' },
        ],
        cmdstart: 'npm start',
      }),
      WORKDIR,
      'fail',
      makeDeps({ localBranches: async () => ['branch-1', 'branch-2'] }),
    );

    assert.ok(result.plan);
    assert.strictEqual(result.plan!.start?.repoName, 'repo2');
    assert.strictEqual(result.plan!.start?.repoAbsPath, repoPath('repo2'));
    assert.strictEqual(result.plan!.start?.shell, 'npm start');
  });

  it('honours startRepo', async () => {
    const result = await preflight(
      'dev',
      makeSetup({
        steps: [
          { repo: 'repo1', branch: 'branch-1' },
          { repo: 'repo2', branch: 'branch-2' },
        ],
        cmdstart: 'npm start',
        startRepo: 'repo1',
      }),
      WORKDIR,
      'fail',
      makeDeps({ localBranches: async () => ['branch-1', 'branch-2'] }),
    );

    assert.ok(result.plan);
    assert.strictEqual(result.plan!.start?.repoName, 'repo1');
  });

  it('reports an invalid startRepo', async () => {
    const result = await preflight(
      'dev',
      makeSetup({ cmdstart: 'npm start', startRepo: 'repo2' }),
      WORKDIR,
      'fail',
      makeDeps(),
    );

    assert.strictEqual(result.plan, undefined);
    assert.deepStrictEqual(errorPaths(result.diagnostics), ['setups.dev.startRepo']);
  });

  it('collects every error instead of failing fast', async () => {
    const result = await preflight(
      'dev',
      makeSetup({
        steps: [
          { repo: 'repo1', branch: 'missing-1' },
          { repo: 'repo2', branch: 'missing-2' },
        ],
      }),
      WORKDIR,
      'fail',
      makeDeps({ localBranches: async () => [] }),
    );

    assert.strictEqual(result.plan, undefined);
    assert.deepStrictEqual(errorPaths(result.diagnostics), [
      'setups.dev.steps[0].branch',
      'setups.dev.steps[1].branch',
    ]);
  });

});
