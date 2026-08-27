# Runtime Pack release

Runtime Packs are published independently of desktop installers, to a dedicated artifact repository.

| Surface | Repository | Tag | GitHub Latest |
| --- | --- | --- | --- |
| Desktop installers | `maojindao55/freebuddy` | `v*` | Desktop release (keep this as Latest) |
| Runtime Pack zips | `maojindao55/freebuddy-runtime` | `runtime-v*` | Latest Runtime in that repository |

Desktop clients never `npm install` Runtime packages. Workspace packages stay `private: true`. The distribution unit is one signed `freebuddy-runtime-<version>.zip`.

## Release topology

Runtime publishing runs in `maojindao55/freebuddy-runtime`, not in the Desktop source repository. This lets the artifact repository use its own short-lived `GITHUB_TOKEN` with `contents:write`; no cross-repository PAT is stored.

1. Push `runtime-vX.Y.Z` in `maojindao55/freebuddy`. The source workflow typechecks, tests, builds, and probes an unsigned pack in isolation.
2. Run the `Publish Runtime` workflow in `maojindao55/freebuddy-runtime` with version `X.Y.Z`.
3. The artifact workflow checks out the matching source tag, builds and Ed25519-signs the pack with a deterministic `publishedAt`, and stages `freebuddy-runtime-X.Y.Z.zip`, `stable.json`, and `stable.json.sig`.
4. It creates a **draft** GitHub Release in the artifact repository and uploads the zip.
5. It re-downloads the zip, verifies the outer SHA-256 and inner signature/checksums/Host API compatibility, then runs the isolated process probe.
6. It publishes the Release and atomically commits `channels/stable.json` and `channels/stable.json.sig` in **one** git commit.

If a `runtime-vX.Y.Z` zip already exists, the publisher compares SHA-256. Identical bytes succeed idempotently. Different bytes fail; the publisher never deletes or overwrites a published asset.

Channel JSON is not updated until the zip is on a published Release, so clients never see a descriptor that 404s.

Channel JSON is fetched from:

`https://raw.githubusercontent.com/maojindao55/freebuddy-runtime/main/channels/stable.json`

The zip is downloaded from the matching GitHub Release. The downloader follows a limited number of HTTPS 302s.

Desktop Runtime auto-update stays **disabled** until the production public key is shipped with the app. Checking for updates in Settings will not download a pack while `update.enabled` is false.

## Secret (set on `maojindao55/freebuddy-runtime`)

Add this repository Actions secret before publishing:

`RUNTIME_SIGNING_PRIVATE_KEY` — Ed25519 PKCS#8 PEM. GitHub secrets may use `\n` for newlines.

The workflow maps its repository-scoped `github.token` to the publisher process. Do not copy a personal `GH_TOKEN` into repository secrets or shell profiles.

Generate a one-time key pair:

```sh
node --input-type=module -e "
import { generateKeyPairSync } from 'node:crypto';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());
"
```

Store the private PEM in the artifact repository's `RUNTIME_SIGNING_PRIVATE_KEY`. Commit the matching public PEM as `electron/runtime/keys/runtime-release.pub` (see that directory's README) in a **desktop** release before turning Runtime auto-update on.

## Local development

```sh
npm run runtime:build
npm run runtime:sign
npm run runtime:verify
npm run runtime:probe
npm run runtime:package
```

Development keys are written to `.build/runtime-keys/` and are not production keys. `npm run runtime:publish` talks to GitHub and requires `FREEBUDDY_RUNTIME_RELEASE_TOKEN`; do not run it against the desktop repository.

For a local production-key rehearsal, point `RUNTIME_SIGNING_PRIVATE_KEY_FILE` at a protected PEM file instead of placing the key in shell history.

## First publish to the empty artifact repo

The artifact repository is initialized with its publishing workflow and public verification key before the first release. The first successful publish creates `channels/` and uploads the zip. After that, GitHub Latest in the artifact repo may point at Runtime. Desktop Latest stays on `maojindao55/freebuddy`.
