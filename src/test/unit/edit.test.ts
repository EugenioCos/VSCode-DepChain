// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as assert from 'node:assert';
import { addSetupToConfigText, removeSetupFromConfigText } from '../../config/edit';

function configText(): string {
  return JSON.stringify(
    {
      workingDir: 'repos',
      onDirty: 'fail',
      setups: {
        dev: { steps: [{ repo: 'repo1', shell: 'npm run cmd1' }] },
        failure: { steps: [{ repo: 'repo2', shell: 'npm run exit1' }] },
      },
    },
    null,
    2,
  );
}

describe('addSetupToConfigText', () => {
  it('adds a setup and preserves the rest of the document', () => {
    const result = addSetupToConfigText(configText(), 'newsetup', {
      steps: [{ repo: 'repo3', branch: 'branch-3', shell: 'npm run cmd3' }],
    });

    assert.ok(result.text);
    const parsed = JSON.parse(result.text!);
    assert.deepStrictEqual(Object.keys(parsed.setups), ['dev', 'failure', 'newsetup']);
    assert.strictEqual(parsed.setups.newsetup.steps[0].repo, 'repo3');
    assert.strictEqual(parsed.workingDir, 'repos');
    assert.strictEqual(parsed.onDirty, 'fail');
  });

  it('rejects a duplicate setup name', () => {
    const result = addSetupToConfigText(configText(), 'dev', {
      steps: [{ repo: 'repo1' }],
    });

    assert.strictEqual(result.text, undefined);
    assert.ok(result.error?.includes('already exists'));
  });

  it('rejects empty names and empty steps', () => {
    assert.ok(addSetupToConfigText(configText(), '   ', { steps: [{ repo: 'repo1' }] }).error);
    assert.ok(addSetupToConfigText(configText(), 'empty', { steps: [] }).error);
  });

  it('reports invalid JSON', () => {
    assert.ok(addSetupToConfigText('{', 'dev', { steps: [{ repo: 'repo1' }] }).error);
  });

  it('does not pollute the prototype for a __proto__ name', () => {
    const result = addSetupToConfigText(configText(), '__proto__', {
      steps: [{ repo: 'repo1' }],
    });

    assert.ok(result.text);
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
    const parsed = JSON.parse(result.text!);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(parsed.setups, '__proto__'),
      true,
    );
  });
});

describe('removeSetupFromConfigText', () => {
  it('removes the requested setup and keeps the others', () => {
    const result = removeSetupFromConfigText(configText(), 'dev');

    assert.strictEqual(result.remaining, 1);
    assert.ok(result.text);
    const parsed = JSON.parse(result.text!);
    assert.deepStrictEqual(Object.keys(parsed.setups), ['failure']);
    assert.strictEqual(parsed.setups.failure.steps[0].shell, 'npm run exit1');
    assert.strictEqual(parsed.workingDir, 'repos');
    assert.strictEqual(parsed.onDirty, 'fail');
  });

  it('reports the remaining count when removing the last setup', () => {
    const result = removeSetupFromConfigText(configText(), 'failure');
    const again = removeSetupFromConfigText(result.text!, 'dev');

    assert.strictEqual(again.remaining, 0);
  });

  it('reports a missing setup', () => {
    const result = removeSetupFromConfigText(configText(), 'nope');

    assert.strictEqual(result.text, undefined);
    assert.ok(result.error?.includes('not found'));
  });

  it('reports invalid JSON', () => {
    const result = removeSetupFromConfigText('{', 'dev');

    assert.strictEqual(result.text, undefined);
    assert.ok(result.error?.includes('Invalid JSON'));
  });

  it('reports a non-object document', () => {
    const result = removeSetupFromConfigText('[]', 'dev');

    assert.strictEqual(result.text, undefined);
    assert.ok(result.error?.includes('JSON object'));
  });

  it('reports a missing setups object', () => {
    const result = removeSetupFromConfigText('{"workingDir":"repos"}', 'dev');

    assert.strictEqual(result.text, undefined);
    assert.ok(result.error?.includes('setups'));
  });

  it('does not confuse prototype keys with existing setups', () => {
    const result = removeSetupFromConfigText(configText(), '__proto__');

    assert.strictEqual(result.text, undefined);
    assert.ok(result.error?.includes('not found'));
  });
});
