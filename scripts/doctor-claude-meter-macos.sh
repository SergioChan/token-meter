#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
exec "$ROOT/integrations/claude-desktop/scripts/doctor.sh" "$@"
