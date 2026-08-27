# Runtime release public key

Place the production Ed25519 public key at `runtime-release.pub` in this directory
(PEM, SPKI). Desktop loads it as `runtime-prod` from:

- `process.resourcesPath/runtime-keys/runtime-release.pub` in packaged apps
- `electron/runtime/keys/runtime-release.pub` during development

The matching private key is stored only in the `maojindao55/freebuddy-runtime`
Actions secret `RUNTIME_SIGNING_PRIVATE_KEY`. Never commit or print the private key.
Runtime auto-update stays disabled until this public key ships with a desktop release.
