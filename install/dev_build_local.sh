#!/bin/bash
# Builds all Project N.O.M.A.D. images locally from source and hot-swaps
# running containers — use this to verify changes before pushing to GitHub.
#
# Usage:
#   ./install/dev_build_local.sh                  # build + reload everything
#   ./install/dev_build_local.sh admin             # build + reload admin only
#   ./install/dev_build_local.sh book-builder      # build job image only (no reload)
#   ./install/dev_build_local.sh youtube-builder book-builder admin

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Locate the running installation by finding the compose.yml.
# NOMAD_DIR may be provided as an environment variable; otherwise we probe common paths
# and then ask Docker itself.
if [ -n "${NOMAD_DIR}" ] && [ -f "${NOMAD_DIR}/compose.yml" ]; then
  : # use NOMAD_DIR as-is
elif [ -f "${REPO_DIR}/compose.yml" ]; then
  NOMAD_DIR="${REPO_DIR}"
elif [ -f "/opt/project-nomad/compose.yml" ]; then
  NOMAD_DIR="/opt/project-nomad"
elif [ -f "/media/user/Spinny/project-nomad/compose.yml" ]; then
  NOMAD_DIR="/media/user/Spinny/project-nomad"
else
  # Ask docker compose which projects are running and find the project-nomad one
  COMPOSE_FILE=$(docker compose ls --format json 2>/dev/null \
    | python3 -c "import sys,json; projects=[p for p in json.load(sys.stdin) if 'nomad' in p.get('Name','').lower() or 'nomad' in p.get('ConfigFiles','').lower()]; print(projects[0]['ConfigFiles'].split(',')[0] if projects else '')" 2>/dev/null || true)
  if [ -n "${COMPOSE_FILE}" ] && [ -f "${COMPOSE_FILE}" ]; then
    NOMAD_DIR="$(dirname "${COMPOSE_FILE}")"
  else
    echo "ERROR: Could not find compose.yml. Set NOMAD_DIR to your install path, e.g.:"
    echo "  NOMAD_DIR=/path/to/project-nomad bash install/dev_build_local.sh admin"
    echo ""
    echo "Running compose projects:"
    docker compose ls 2>/dev/null || true
    exit 1
  fi
fi

GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
info() { echo -e "${YELLOW}→${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*"; exit 1; }

echo ""
echo "Project N.O.M.A.D. — Local Build & Reload"
echo "  Repo:    ${REPO_DIR}"
echo "  Install: ${NOMAD_DIR}"
echo ""

# ---------------------------------------------------------------------------
# Image definitions: name → (tag, build context, compose service or "job")
# ---------------------------------------------------------------------------
# Format: IMAGE_TAG|BUILD_CONTEXT|COMPOSE_SERVICE_OR_JOB
declare -A IMAGE_MAP=(
  [admin]="ghcr.io/flynnty/project-nomad:latest|${REPO_DIR}|admin"
  [updater]="ghcr.io/flynnty/project-nomad-sidecar-updater:latest|${REPO_DIR}/install/sidecar-updater|updater"
  [disk-collector]="ghcr.io/flynnty/project-nomad-disk-collector:latest|${REPO_DIR}/install/sidecar-disk-collector|disk-collector"
  [youtube-builder]="ghcr.io/flynnty/project-nomad-youtube-builder:latest|${REPO_DIR}/install/youtube-builder|job"
  [book-builder]="ghcr.io/flynnty/project-nomad-book-builder:latest|${REPO_DIR}/install/book-builder|job"
)

# Determine which targets to build
if [ $# -eq 0 ]; then
  TARGETS=("${!IMAGE_MAP[@]}")
else
  TARGETS=("$@")
fi

# Validate targets
for target in "${TARGETS[@]}"; do
  if [ -z "${IMAGE_MAP[$target]}" ]; then
    err "Unknown target '${target}'. Valid targets: ${!IMAGE_MAP[*]}"
  fi
done

# ---------------------------------------------------------------------------
# 1. Build images
# ---------------------------------------------------------------------------
COMPOSE_SERVICES=()

for target in "${TARGETS[@]}"; do
  IFS='|' read -r tag context service <<< "${IMAGE_MAP[$target]}"

  if [ ! -f "${context}/Dockerfile" ] && [ "${target}" != "admin" ]; then
    err "Dockerfile not found at ${context}/Dockerfile"
  fi

  info "Building ${target} → ${tag}"
  if docker build -t "${tag}" "${context}"; then
    ok "Built ${target}"
  else
    err "Build failed for ${target}"
  fi
  echo ""

  if [ "${service}" != "job" ]; then
    COMPOSE_SERVICES+=("${service}")
  fi
done

# ---------------------------------------------------------------------------
# 2. Reload compose services (skip pull so local images are used)
# ---------------------------------------------------------------------------
if [ ${#COMPOSE_SERVICES[@]} -gt 0 ]; then
  info "Reloading compose services: ${COMPOSE_SERVICES[*]}"
  NOMAD_DIR="${NOMAD_DIR}" docker compose \
    -p project-nomad \
    -f "${NOMAD_DIR}/compose.yml" \
    up -d --force-recreate --pull never \
    "${COMPOSE_SERVICES[@]}"
  ok "Services reloaded."
  echo ""
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "Done."
if [[ " ${TARGETS[*]} " =~ " youtube-builder " ]] || [[ " ${TARGETS[*]} " =~ " book-builder " ]]; then
  echo ""
  echo "Note: job images (youtube-builder, book-builder) are used on the next"
  echo "triggered job run — no restart needed."
fi
echo ""
echo "Admin UI: http://localhost:8080"
echo ""
