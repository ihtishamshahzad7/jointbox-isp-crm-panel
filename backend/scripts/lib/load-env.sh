#!/usr/bin/env bash
# load-env.sh — source this to load backend/.env into the current shell.
#
# WHY: Node scripts call require('dotenv').config() individually, but psql and
# bash heredoc `node -` children do not. Without this, DATABASE_URL is missing
# in those children and the deploy aborts. Sourcing this once exports every
# .env variable so ALL children (psql, node, sub-scripts) inherit them.
#
# Usage (from a script whose CWD is the backend dir):
#   source "$(dirname "$0")/lib/load-env.sh"
#   load_env_file            # loads ./.env if present
#
# It never overwrites variables already set in the environment is NOT the
# behaviour here: .env is the source of truth for a deploy, so values in .env
# win. Callers that must preserve a pre-set value should export it after
# calling load_env_file, or not call it.
#
# Values are parsed by dotenv (via print-env-exports.js) and single-quoted, so
# this is safe against spaces, '#', and quotes inside values. No value is ever
# echoed to stdout or a log.

load_env_file() {
  local envfile="${1:-.env}"
  [ -f "$envfile" ] || return 0

  local here exports
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  # Prefer dotenv's parser. If node or dotenv is unavailable, fall back to a
  # conservative line reader that handles KEY=VALUE and optional surrounding
  # quotes (enough for a standard generated .env).
  if exports="$(node "$here/print-env-exports.js" "$envfile" 2>/dev/null)" && [ -n "$exports" ]; then
    eval "$exports"
    return 0
  fi

  # Fallback parser (no dotenv): skip comments/blanks, strip matching quotes.
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    [ "${line#*=}" = "$line" ] && continue        # no '=' -> skip
    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    case "$key" in
      [A-Za-z_]*) ;;                               # valid identifier start
      *) continue ;;
    esac
    # strip one layer of matching single or double quotes
    if [ "${val#\"}" != "$val" ] && [ "${val%\"}" != "$val" ]; then
      val="${val#\"}"; val="${val%\"}"
    elif [ "${val#\'}" != "$val" ] && [ "${val%\'}" != "$val" ]; then
      val="${val#\'}"; val="${val%\'}"
    fi
    export "$key=$val"
  done < "$envfile"
}
