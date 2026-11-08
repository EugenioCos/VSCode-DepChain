# Dep Chain

Dep Chain runs an ordered chain of operations across multiple repositories: checkout a branch in
each repo, run the configured shell command, and finally launch the main project — all in **one
reused terminal**, stopping at the first failure.

## Configuration

The default config file is `.vscode/dep-chain.json` in the workspace (override with the
`depChain.configPath` setting). `workingDir` is relative to the workspace folder, not to the
location of the config file.

```json
{
  "workingDir": "example repos",
  "onDirty": "fail",
  "setups": {
    "dev": {
      "description": "Local dependency assembly",
      "steps": [
        { "repo": "repo1", "branch": "branch-1", "shell": "npm run cmd1" },
        { "repo": "repo2", "branch": "branch-2", "shell": "npm run cmd2" },
        { "repo": "repo3", "branch": "branch-3", "shell": "npm run build && npm pack" }
      ],
      "cmdstart": "npm start"
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `workingDir` | yes | Directory containing the repositories, relative to the workspace folder or absolute. |
| `onDirty` | no | `fail` (default), `stash`, `discard`: what to do when a repo to check out has local changes. |
| `setups` | yes | Map name → setup. With more than one, a QuickPick is shown. |
| `setup.steps` | yes | **Ordered** array of steps. |
| `step.repo` | yes | Repository directory name under `workingDir`. |
| `step.branch` | no | Branch, tag or commit to check out. If omitted, the current checkout is kept. |
| `step.shell` | no | Shell command executed after fetch/checkout/pull. For an npm script use `npm run <script>`. |
| `setup.cmdstart` | no | Shell command launched when the chain completes, without waiting for it to finish. |
| `setup.startRepo` | no | Repository where `cmdstart` runs; default: the repository of the last step. |

For every step with a `branch`, Dep Chain runs `git fetch --all --prune`, then the checkout (if the
repo is not already on the branch) and `git pull --ff-only` when the branch has an upstream;
detached refs and branches without upstream skip the pull. A failure in fetch, checkout or pull
stops the chain. Steps without `shell` only check out. If a command exits non-zero, the chain stops
and the terminal stays in the repo of the failed step.

## Commands

- **Dep Chain: Create Setup** — guided creation: name, repositories, branch, shell command and optional start command.
- **Dep Chain: Run Setup** — runs a setup (QuickPick when there is more than one).
- **Dep Chain: Cancel Run** — interrupts the current run (Ctrl+C in the terminal).
- **Dep Chain: Retry Failed Step** — restarts from the failed step.
- **Dep Chain: Validate Config** — loads and validates the config and plan without touching the repos.
- **Dep Chain: Open/Create Config File** — opens or creates the configuration file.
- **Dep Chain: Show Terminal** — shows the terminal of the run.

The status bar shows the current step; clicking it during a run cancels the run.

## Setup panel

The extension adds a **Dep Chain** panel to the side bar. Each setup is an expandable node listing
the repositories of the chain with their branch. The ▶ icon next to a setup runs it directly,
without the QuickPick; the trash icon deletes it from the configuration after a confirmation (the
last setup cannot be deleted). The **New setup…** entry at the bottom of the group, or the `+`
action in the view title, starts the guided creation: name, repositories discovered under
`workingDir`, local/remote branch or ref, shell command and optional start command. The
**Configuration** group hosts the link to `dep-chain.json` (or the entry to create it). The view
title has Run, Refresh and Open config actions. In a multi-root workspace, each folder is a root
node with its own setups.

When there is more than one setup, the **Dep Chain: Run Setup** command also shows a QuickPick;
from the panel you pick the setup directly.

## Terminal and shell integration

The extension reuses a single terminal named `Dep Chain`. To know the exit code of each command it
uses VS Code [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration)
(stable API since VS Code 1.93). If shell integration does not activate within the timeout
(`depChain.shellIntegrationTimeoutMs`, default 5 s), the extension falls back to a single output
channel with a child process: exit codes stay reliable, but there is no interactive terminal.

## Security

The configuration is **executable content**: the `shell` and `cmdstart` fields run as-is, including
any `npm run <script>`, which in turn executes repository code. Only open and trust workspaces you
trust. The extension declares `untrustedWorkspaces.supported: false`, so it is disabled in
Restricted Mode; additionally, every command checks `workspace.isTrusted` at runtime.

Paths, branches, remote refs and stash messages are quoted (POSIX single quotes), so config values
cannot break the command line. Only `shell` and `cmdstart` are intentionally raw. Do not put
secrets in those fields: command lines end up in the local `Dep Chain` log channel.

## License

[GPL-3.0-or-later](./LICENSE) — the full license text is in `LICENSE`.

## Usage

1. Open the workspace that owns `dep-chain.json` — or create one with
   **Dep Chain: Create Config File**.
2. Open the **Dep Chain** panel in the side bar: each setup shows its repositories and branches.
3. Click ▶ on a setup (or run **Dep Chain: Run Setup**) to start the chain.
4. Follow the progress in the reused `Dep Chain` terminal and in the status bar (`(2/3)`).
5. Click the status bar item to cancel a running chain.
6. When a step fails the chain stops immediately, and a notification offers
   **Show Terminal** and **Retry Failed Step** (which re-runs only the failed step, with its
   fetch/checkout/pull).

What happens during a run, for every step that declares a `branch`:
`git fetch --all --prune` → `git checkout <branch>` → `git pull --ff-only` (when the branch has an
upstream) → `step.shell`. Steps that omit `branch` only run their command in the current checkout.
When the whole chain succeeds, `cmdstart` launches in the last repository (or in `startRepo`) and
keeps running in the terminal.

### Examples

Dependency assembly across three repositories — build each layer, `npm pack` it, install the
tarball in the next layer, then start the top project:

```json
{
  "workingDir": "source",
  "onDirty": "stash",
  "setups": {
    "pack-dev": {
      "description": "Assemble core → domain → app, then start the app",
      "steps": [
        {
          "repo": "core",
          "branch": "feature/api-v2",
          "shell": "npm ci && npm run build && npm pack --pack-destination ../tarballs"
        },
        {
          "repo": "domain",
          "branch": "feature/api-v2",
          "shell": "npm ci && npm install ../tarballs/core-1.0.0.tgz && npm run build && npm pack --pack-destination ../tarballs"
        },
        {
          "repo": "app",
          "branch": "develop",
          "shell": "npm ci && npm install ../tarballs/domain-2.0.0.tgz"
        }
      ],
      "cmdstart": "npm run dev"
    }
  }
}
```

`npm pack` names tarballs `<name>-<version>.tgz`, so adjust the file names to the versions you
publish. The chain stops at the first non-zero exit code — a failing build, a missing tarball, a
dirty checkout with `onDirty: "fail"` — and the status bar shows where. A checkout-only step is
also valid when you just want to align a repository without running anything:

```json
{ "repo": "shared-lib", "branch": "release/1.4" }
```

The bundled `example repos/` fixtures demonstrate both outcomes with the `dev` and `failure`
setups of `.vscode/dep-chain.json`: `dev` completes and launches the start command, while
`failure` stops on the `exit1` script (exit code 1) before touching `repo2`.
