#!/usr/bin/env bash
# Import CSC_LINK into a temporary keychain, then leave it on the search list
# so electron-builder can auto-discover the identity.
#
# electron-builder 26.15.3 creates its own keychain when CSC_LINK is set, then
# calls `security set-key-partition-list -k <p12 password>`. That flag needs
# the *keychain* password. macOS 26.5 let the mismatch through; 26.6 rejects
# it with SecKeychainUnlock. Import here, then omit CSC_LINK from the builder.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping macOS certificate import on $(uname -s)"
  exit 0
fi

if [[ -z "${CSC_LINK:-}" ]]; then
  echo "CSC_LINK is empty; skipping certificate import"
  exit 0
fi

tmp_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
certificate_path="${tmp_dir}/freebuddy-csc.p12"
keychain_path="${tmp_dir}/freebuddy-signing.keychain-db"
keychain_password="$(openssl rand -base64 32)"

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::add-mask::${keychain_password}"
fi

python3 - "${certificate_path}" <<'PY'
import base64, os, pathlib, sys

dest = pathlib.Path(sys.argv[1])
raw = os.environ["CSC_LINK"].strip()
source = pathlib.Path(raw)
if source.is_file():
    dest.write_bytes(source.read_bytes())
else:
    dest.write_bytes(base64.b64decode(raw))
PY

# npm test on macOS previously invoked this script with a dummy CSC_LINK and
# left this keychain behind. create-keychain then fails with exit 48
# (SecKeychainCreate: A keychain with the same name already exists).
security delete-keychain "${keychain_path}" >/dev/null 2>&1 || true
rm -f "${keychain_path}"

security create-keychain -p "${keychain_password}" "${keychain_path}"
security set-keychain-settings -lut 21600 "${keychain_path}"
security unlock-keychain -p "${keychain_password}" "${keychain_path}"
# Import the PKCS12 identity (cert + private key). Do not set the import
# type to certificate-only: that drops the private key and find-identity
# reports 0 identities.
security import "${certificate_path}" \
  -k "${keychain_path}" \
  -P "${CSC_KEY_PASSWORD:-}" \
  -A \
  -f pkcs12 \
  -T /usr/bin/codesign \
  -T /usr/bin/security \
  -T /usr/bin/productbuild
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "${keychain_password}" \
  "${keychain_path}"

existing_keychains=()
while IFS= read -r line; do
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%\"}"
  trimmed="${trimmed#\"}"
  if [[ -n "${trimmed}" && "${trimmed}" != "${keychain_path}" ]]; then
    existing_keychains+=("${trimmed}")
  fi
done < <(security list-keychains -d user)
security list-keychains -d user -s "${keychain_path}" "${existing_keychains[@]+"${existing_keychains[@]}"}"
security default-keychain -s "${keychain_path}"

identities="$(security find-identity -v -p codesigning "${keychain_path}")"
printf '%s\n' "${identities}"
if printf '%s\n' "${identities}" | grep -Eq '^[[:space:]]*0 valid identities found'; then
  echo "No code-signing identities were imported from CSC_LINK" >&2
  exit 1
fi
