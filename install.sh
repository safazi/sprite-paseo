#!/usr/bin/env bash

set -euo pipefail

readonly REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec "${REPO_DIR}/direct/scripts/install.sh" "$@"
