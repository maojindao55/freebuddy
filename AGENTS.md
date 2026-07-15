# Repository agent instructions

## GitHub publishing

- Before pushing a branch or creating/updating a pull request, run
  `npm run github:preflight`.
- A successful SSH push does not prove that GitHub API or GitHub App access is
  valid; rely on the preflight API checks.
- When the check fails inside a Codex sandbox, rerun it with system permissions
  before starting a new browser login. The sandbox may be unable to access the
  macOS keychain or network even when the stored credential is valid.
- Do not print token values or persist `GH_TOKEN`/`GITHUB_TOKEN` in local shell
  profiles as a workaround.
