#!/bin/bash
# Captures DocStudio / ButlerBuddy fixture screenshots.
# Usage: ./tests/fixtures/doc-studio-capture.sh   (run `npx vite` first)
set -u
BASE="http://127.0.0.1:5199/tests/fixtures/doc-studio-preview.html"
OUT="artifacts/product-design/doc-studio-audit/before"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p "$OUT"

shot() { # name, query, w, h
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --virtual-time-budget=8000 --window-size="$3,$4" \
    --screenshot="$OUT/$1.png" "$BASE?$2" >/dev/null 2>&1
  echo "$OUT/$1.png"
}

shot docstudio-sheet-light            "view=sheet&theme=light"            1568 912
shot docstudio-sheet-light-chat       "view=sheet&theme=light&chat=1"     1568 912
shot docstudio-sheet-dark-chat        "view=sheet&theme=dark&chat=1"      1568 912
shot docstudio-empty-light            "view=empty&theme=light"            1568 912
shot docstudio-markdown-light         "view=markdown&theme=light"         1568 912
shot butler-chat-light                "view=butler&theme=light&chat=1"     420 640
