#!/bin/zsh

main() {
  local script_path="$1"
  shift
  local script_directory="${script_path:h}"
  local repository_root="${script_directory:h}"
  local server_path="${repository_root}/apps/admin-web/dist/server.js"
  local home_directory="${HOME-}"
  local database_path
  local database_parent
  local portal_origin
  local sync_api_token=""

  if [[ ! -f "$server_path" ]]; then
    print -u2 -- "ERROR: production admin build is missing: $server_path"
    print -u2 -- "ERROR: Run 'npm run build' from the repository root, then retry."
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    print -u2 -- "ERROR: node is not available on PATH. Install Node.js 24 and retry."
    return 1
  fi

  if [[ -z "$home_directory" ]]; then
    print -u2 -- "ERROR: HOME is not set, so the default local database path cannot be resolved."
    return 1
  fi

  if (( ${+FANBOX_ADMIN_DB_PATH} )); then
    database_path="$FANBOX_ADMIN_DB_PATH"
  else
    database_path="$home_directory/Library/Application Support/fanbox-level-manager/admin.sqlite3"
  fi

  if [[ -z "${database_path//[[:space:]]/}" ]]; then
    print -u2 -- "ERROR: FANBOX_ADMIN_DB_PATH must be a non-blank filesystem path."
    return 1
  fi

  if (( ${+FANBOX_PORTAL_ORIGIN} )); then
    portal_origin="$FANBOX_PORTAL_ORIGIN"
  else
    portal_origin="https://fanbox-level-portal.sayosomi.workers.dev"
  fi

  if (( ${+FANBOX_PORTAL_SYNC_API_TOKEN} )); then
    sync_api_token="$FANBOX_PORTAL_SYNC_API_TOKEN"
  fi

  if [[ -z "${sync_api_token//[[:space:]]/}" ]]; then
    if ! read -r -s "sync_api_token?Enter production portal sync token (input hidden): "; then
      print -u2
      print -u2 -- "ERROR: Could not read FANBOX_PORTAL_SYNC_API_TOKEN."
      return 1
    fi
    print -u2

    if [[ -z "${sync_api_token//[[:space:]]/}" ]]; then
      print -u2 -- "ERROR: FANBOX_PORTAL_SYNC_API_TOKEN must not be blank."
      return 1
    fi
  fi

  database_parent="${database_path:h}"
  if [[ ! -d "$database_parent" ]] && ! mkdir -p -- "$database_parent"; then
    print -u2 -- "ERROR: Could not create database parent directory: $database_parent"
    return 1
  fi

  FANBOX_ADMIN_DB_PATH="$database_path" \
  FANBOX_PORTAL_ORIGIN="$portal_origin" \
  FANBOX_PORTAL_SYNC_API_TOKEN="$sync_api_token" \
  exec node "$server_path"
}

main "${0:A}" "$@"
