// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import { RawSetup } from '../model';

export interface AddSetupResult {
  text?: string;
  error?: string;
}

export interface RemoveSetupResult {
  text?: string;
  /** Number of setups left after the removal. */
  remaining?: number;
  error?: string;
}

function parseConfigObject(text: string): { record?: Record<string, unknown>; setups?: Record<string, unknown>; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'The configuration must be a JSON object.' };
  }

  const record = raw as Record<string, unknown>;
  const setups = record.setups;
  if (typeof setups !== 'object' || setups === null || Array.isArray(setups)) {
    return { error: '`setups` is missing or invalid.' };
  }

  return { record, setups: setups as Record<string, unknown> };
}

/**
 * Adds a setup to a strict-JSON config document. Pure, so it can be unit tested without
 * touching the file system. The document is re-serialized with two-space indentation.
 */
export function addSetupToConfigText(
  text: string,
  setupName: string,
  setup: RawSetup,
): AddSetupResult {
  const name = setupName.trim();
  if (!name) {
    return { error: 'The setup name must not be empty.' };
  }
  if (setup.steps.length === 0) {
    return { error: 'A setup must contain at least one step.' };
  }

  const parsed = parseConfigObject(text);
  if (!parsed.record || !parsed.setups) {
    return { error: parsed.error ?? 'Invalid configuration.' };
  }

  if (Object.prototype.hasOwnProperty.call(parsed.setups, name)) {
    return { error: `Setup "${name}" already exists.` };
  }

  // defineProperty instead of assignment so a name like "__proto__" cannot touch the prototype.
  Object.defineProperty(parsed.setups, name, {
    value: setup,
    enumerable: true,
    configurable: true,
    writable: true,
  });

  return { text: `${JSON.stringify(parsed.record, null, 2)}\n` };
}

/**
 * Removes one setup from a strict-JSON config document. Pure, so it can be unit tested
 * without touching the file system. The document is re-serialized with two-space indentation.
 */
export function removeSetupFromConfigText(
  text: string,
  setupName: string,
): RemoveSetupResult {
  const parsed = parseConfigObject(text);
  if (!parsed.record || !parsed.setups) {
    return { error: parsed.error ?? 'Invalid configuration.' };
  }

  if (!Object.prototype.hasOwnProperty.call(parsed.setups, setupName)) {
    return { error: `Setup "${setupName}" not found.` };
  }

  delete parsed.setups[setupName];

  return {
    text: `${JSON.stringify(parsed.record, null, 2)}\n`,
    remaining: Object.keys(parsed.setups).length,
  };
}
