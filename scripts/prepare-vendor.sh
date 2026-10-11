#!/usr/bin/env sh
# Prepare the pinned browser build asset without installing anything on the host.
set -eu

project_directory=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_directory"
installer=vendor/chrome.deb
expected_chrome=$(awk '$2 == "vendor/chrome.deb" { print $1 }' vendor/checksums.sha256)
[ "${#expected_chrome}" -eq 64 ] || { printf 'Invalid browser checksum manifest.\n' >&2; exit 1; }

verify_chrome() {
  [ -f "$installer" ] && printf '%s  %s\n' "$expected_chrome" "$installer" | sha256sum --check --status
}

if verify_chrome; then
  printf 'Using the existing verified browser installer.\n'
else
  chrome_deb_url=${CHROME_DEB_URL:-https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb}
  case "$chrome_deb_url" in
    https://*) ;;
    *) printf 'CHROME_DEB_URL must use HTTPS.\n' >&2; exit 1 ;;
  esac
  asset_download=$(mktemp "$project_directory/vendor/.chrome.deb.XXXXXX")
  trap 'rm -f "$asset_download"' EXIT HUP INT TERM
  printf 'Downloading the browser installer into vendor/.\n'
  curl -fsSL --connect-timeout 15 --max-time 600 --output "$asset_download" "$chrome_deb_url"
  if ! printf '%s  %s\n' "$expected_chrome" "$asset_download" | sha256sum --check --status; then
    printf 'The download does not match the pinned Google Chrome 155.0.8059.39 installer.\n' >&2
    printf 'Supply the matching official package using CHROME_DEB_URL or place it at vendor/chrome.deb.\n' >&2
    printf 'Any existing installer was left unchanged.\n' >&2
    exit 1
  fi
  mv "$asset_download" "$installer"
  trap - EXIT HUP INT TERM
fi

sha256sum --check vendor/checksums.sha256
