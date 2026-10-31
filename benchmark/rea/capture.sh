#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 3 ]];then echo 'Usage: bash benchmark/rea/capture.sh baseline|protected CDP_PORT TARGET_ID' >&2;exit 2;fi
MODE="$1"; PORT="$2"; TARGET="$3"
if [[ "$MODE" != "baseline" && "$MODE" != "protected" || ! "$PORT" =~ ^[0-9]{4,5}$ || -z "$TARGET" ]];then echo 'invalid mode / CDP port / target' >&2;exit 2;fi
if ! command -v rea >/dev/null;then echo 'rea is not installed. See benchmark/rea/README.md' >&2;exit 3;fi
DIR="$(cd "$(dirname "$0")/../results" && pwd)/rea/$MODE";mkdir -p "$DIR"
ENDPOINT="http://127.0.0.1:$PORT"
rea --version > "$DIR/rea-version.txt"
# Maintain exit code and full output separately; do not manufacture results.
rea inspect-web-page "$ENDPOINT" "$TARGET" --observation-ms 1000 --include-accessibility-text --include-json-body-shapes --format json --full-output > "$DIR/inspect.json"
rea analyze-web-bundle "$ENDPOINT" "$TARGET" --format json --full-output > "$DIR/bundle.json"
rea capture-web-screenshot "$ENDPOINT" "$TARGET" --format json --full-output > "$DIR/screenshot.json"
rea discover-webmcp-tools "$ENDPOINT" "$TARGET" --format json --full-output > "$DIR/webmcp.json"
echo "REA results in $DIR"
