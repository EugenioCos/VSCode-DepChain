// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import * as assert from 'node:assert';
import { quotePosix } from '../../util/shellQuote';

describe('quotePosix', () => {
  it('quotes a simple value', () => {
    assert.strictEqual(quotePosix('repo1'), "'repo1'");
  });

  it('quotes paths with spaces', () => {
    assert.strictEqual(quotePosix('/work/example repos'), "'/work/example repos'");
  });

  it('escapes single quotes', () => {
    assert.strictEqual(quotePosix("it's"), "'it'\\''s'");
  });

  it('quotes an empty value', () => {
    assert.strictEqual(quotePosix(''), "''");
  });
});
