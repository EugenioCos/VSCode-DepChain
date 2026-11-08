// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Quote a value for a POSIX shell using single quotes. Works with bash, zsh, sh and fish.
 */
export function quotePosix(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
