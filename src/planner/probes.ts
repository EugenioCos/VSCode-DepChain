// dep-chain - ordered cross-repo setup chains
// Copyright (C) 2026 Eugenio Cos
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';

export interface GitStatus {
  branch: string;
  /** Lines from `git status --porcelain=v1`, e.g. " M package.json". */
  files: string[];
}

/**
 * Read-only probes used by the preflight. Injected so the planner can be unit tested
 * without touching a real file system or git.
 */
export interface ProbeDeps {
  isDirectory(dir: string): Promise<boolean>;
  isGitWorkTree(repoAbs: string): Promise<boolean>;
  currentBranch(repoAbs: string): Promise<string | null>;
  localBranches(repoAbs: string): Promise<string[]>;
  /** e.g. ["origin/main", "origin/feature"], without remote HEAD symbolic refs. */
  remoteBranches(repoAbs: string): Promise<string[]>;
  /** e.g. "origin/branch-1", or null when no remote has it. */
  remoteTracking(repoAbs: string, branch: string): Promise<string | null>;
  refExists(repoAbs: string, ref: string): Promise<boolean>;
  /** e.g. "origin/branch-1", or null when the branch has no upstream. */
  upstream(repoAbs: string, branch: string): Promise<string | null>;
  status(repoAbs: string): Promise<GitStatus>;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(file: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      let code = 0;
      if (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        code = typeof errorCode === 'number' ? errorCode : 1;
      }
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function git(repoAbs: string, args: string[]): Promise<ExecResult> {
  return exec('git', ['-C', repoAbs, ...args]);
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function createProbeDeps(): ProbeDeps {
  return {
    async isDirectory(dir: string): Promise<boolean> {
      try {
        return (await fs.stat(dir)).isDirectory();
      } catch {
        return false;
      }
    },

    async isGitWorkTree(repoAbs: string): Promise<boolean> {
      const result = await git(repoAbs, ['rev-parse', '--is-inside-work-tree']);
      return result.code === 0 && result.stdout.trim() === 'true';
    },

    async currentBranch(repoAbs: string): Promise<string | null> {
      const result = await git(repoAbs, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (result.code !== 0) {
        return null;
      }
      const branch = result.stdout.trim();
      return branch === '' || branch === 'HEAD' ? null : branch;
    },

    async localBranches(repoAbs: string): Promise<string[]> {
      const result = await git(repoAbs, [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads',
      ]);
      return result.code === 0 ? lines(result.stdout) : [];
    },

    async remoteBranches(repoAbs: string): Promise<string[]> {
      const result = await git(repoAbs, [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/remotes',
      ]);
      return result.code === 0
        ? lines(result.stdout).filter((ref) => !ref.endsWith('/HEAD'))
        : [];
    },

    async remoteTracking(repoAbs: string, branch: string): Promise<string | null> {
      const remotes = await git(repoAbs, ['remote']);
      if (remotes.code !== 0) {
        return null;
      }
      for (const remote of lines(remotes.stdout)) {
        const ref = `${remote}/${branch}`;
        const result = await git(repoAbs, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/remotes/${ref}^{commit}`,
        ]);
        if (result.code === 0) {
          return ref;
        }
      }
      return null;
    },

    async refExists(repoAbs: string, ref: string): Promise<boolean> {
      const result = await git(repoAbs, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return result.code === 0;
    },

    async upstream(repoAbs: string, branch: string): Promise<string | null> {
      const result = await git(repoAbs, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        `${branch}@{u}`,
      ]);
      if (result.code !== 0) {
        return null;
      }
      const value = result.stdout.trim();
      return value === '' ? null : value;
    },

    async status(repoAbs: string): Promise<GitStatus> {
      const [branch, porcelain] = await Promise.all([
        git(repoAbs, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(repoAbs, ['status', '--porcelain=v1']),
      ]);
      const current = branch.code === 0 ? branch.stdout.trim() : '';
      return {
        branch: current === '' || current === 'HEAD' ? 'detached HEAD' : current,
        files:
          porcelain.code === 0
            ? porcelain.stdout
                .split('\n')
                .map((line) => line.trimEnd())
                .filter((line) => line.length > 0)
            : [],
      };
    },
  };
}
