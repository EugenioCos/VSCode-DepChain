// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as assert from 'node:assert';
import { validateConfig } from '../../config/validate';

function validConfig(): unknown {
  return {
    workingDir: 'repos',
    setups: {
      dev: {
        steps: [{ repo: 'repo1', branch: 'main', shell: 'npm run build' }],
        cmdstart: 'npm start',
      },
    },
  };
}

function errorPaths(raw: unknown): string[] {
  return validateConfig(raw)
    .diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.path);
}

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    const result = validateConfig(validConfig());
    assert.ok(result.config);
    assert.deepStrictEqual(errorPaths(validConfig()), []);
    assert.deepStrictEqual(Object.keys(result.config!.setups), ['dev']);
    assert.strictEqual(result.config!.setups.dev.steps[0].shell, 'npm run build');
  });

  it('rejects non-object configs', () => {
    assert.deepStrictEqual(errorPaths([]), ['']);
    assert.deepStrictEqual(errorPaths(null), ['']);
    assert.deepStrictEqual(errorPaths('config'), ['']);
  });

  it('requires a non-empty workingDir', () => {
    const config = validConfig() as Record<string, unknown>;
    delete config.workingDir;
    assert.deepStrictEqual(errorPaths(config), ['workingDir']);
  });

  it('requires at least one setup', () => {
    assert.deepStrictEqual(errorPaths({ workingDir: 'repos', setups: {} }), ['setups']);
    assert.deepStrictEqual(errorPaths({ workingDir: 'repos' }), ['setups']);
  });

  it('requires non-empty steps', () => {
    assert.deepStrictEqual(
      errorPaths({ workingDir: 'repos', setups: { dev: { steps: [] } } }),
      ['setups.dev.steps'],
    );
  });

  it('requires a non-empty repo name', () => {
    assert.deepStrictEqual(
      errorPaths({ workingDir: 'repos', setups: { dev: { steps: [{ repo: '  ' }] } } }),
      ['setups.dev.steps[0].repo'],
    );
  });

  it('rejects an empty shell command', () => {
    assert.deepStrictEqual(
      errorPaths({
        workingDir: 'repos',
        setups: { dev: { steps: [{ repo: 'repo1', shell: '   ' }] } },
      }),
      ['setups.dev.steps[0].shell'],
    );
  });

  it('accepts shell and checkout-only steps', () => {
    assert.deepStrictEqual(
      errorPaths({
        workingDir: 'repos',
        setups: {
          dev: {
            steps: [{ repo: 'a', shell: 'npm run build' }, { repo: 'b', branch: 'main' }],
          },
        },
      }),
      [],
    );
  });

  it('rejects an invalid onDirty value', () => {
    assert.deepStrictEqual(
      errorPaths({
        workingDir: 'repos',
        onDirty: 'force',
        setups: { dev: { steps: [{ repo: 'a' }] } },
      }),
      ['onDirty'],
    );
  });

  it('rejects a startRepo that is not a step repo', () => {
    assert.deepStrictEqual(
      errorPaths({
        workingDir: 'repos',
        setups: {
          dev: { steps: [{ repo: 'repo1' }], cmdstart: 'npm start', startRepo: 'repo2' },
        },
      }),
      ['setups.dev.startRepo'],
    );
  });

  it('warns when startRepo is used without cmdstart', () => {
    const result = validateConfig({
      workingDir: 'repos',
      setups: { dev: { steps: [{ repo: 'repo1' }], startRepo: 'repo1' } },
    });
    assert.deepStrictEqual(
      result.diagnostics.map((diagnostic) => diagnostic.severity),
      ['warning'],
    );
    assert.ok(result.config);
  });

  it('parses per-setup onDirty overrides', () => {
    const result = validateConfig({
      workingDir: 'repos',
      onDirty: 'fail',
      setups: { dev: { onDirty: 'stash', steps: [{ repo: 'repo1' }] } },
    });
    assert.strictEqual(result.config?.onDirty, 'fail');
    assert.strictEqual(result.config?.setups.dev.onDirty, 'stash');
  });
});
