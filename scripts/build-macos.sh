#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/build/FreeBuddy.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
WEB_DIR="$RESOURCES_DIR/web"
MODULE_CACHE_DIR="$ROOT_DIR/build/module-cache"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$WEB_DIR" "$MODULE_CACHE_DIR"

npm run build:renderer

CLANG_MODULE_CACHE_PATH="$MODULE_CACHE_DIR" swiftc "$ROOT_DIR/desktop/macos/FreeBuddyApp.swift" \
  -o "$MACOS_DIR/FreeBuddy" \
  -framework AppKit \
  -framework WebKit

cp "$ROOT_DIR/desktop/macos/Info.plist" "$CONTENTS_DIR/Info.plist"
cp "$ROOT_DIR/desktop/macos/AppIcon.icns" "$RESOURCES_DIR/AppIcon.icns"
cp -R "$ROOT_DIR/dist/." "$WEB_DIR/"

plutil -lint "$CONTENTS_DIR/Info.plist"

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null
fi

echo "$APP_DIR"
