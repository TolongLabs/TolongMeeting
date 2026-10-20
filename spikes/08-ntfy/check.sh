#!/usr/bin/env bash
# Spike 8 checks for ntfy attachments.
#   N1  anonymous GET of an attachment is refused (401 or 403)
#   N2  member 2's token is refused (403); member 1's token returns identical bytes
#   N3  attachment.expires minus publish time <= 10800 s; with --wait-expiry, the URL then returns 404
#       and the file is gone from the attachment directory
# Also checks the ping shape: priority and view actions on a PUT attachment, and a JSON publish
# (3 actions accepted, 5 actions refused, since ntfy allows at most three).
#
# Usage:
#   NTFY_SECRETS=<file with NTFY_TOKEN_1, NTFY_TOKEN_2> WORK_DIR=<scratch dir> EXPIRY_LABEL=3h check.sh
#   ... EXPIRY_LABEL=2m check.sh --wait-expiry
# Writes one object per EXPIRY_LABEL into data/ntfy.json (or $RESULTS). Tokens never leave the subshell.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="${NTFY_BASE:-http://127.0.0.1:18090}"
results="${RESULTS:-$here/data/ntfy.json}"
label="${EXPIRY_LABEL:-3h}"
secrets="${NTFY_SECRETS:?set NTFY_SECRETS to the token file, kept outside the repo}"
work="${WORK_DIR:?set WORK_DIR to a scratch directory}"
compose=(docker compose -f "$here/compose.yaml")
wait_expiry=0
[[ "${1:-}" == "--wait-expiry" ]] && wait_expiry=1

mkdir -p "$work"
umask 077

token1="$(set -a; . "$secrets"; printf '%s' "$NTFY_TOKEN_1")"
token2="$(set -a; . "$secrets"; printf '%s' "$NTFY_TOKEN_2")"
printf 'header = "Authorization: Bearer %s"\n' "$token1" > "$work/auth1.curl"
printf 'header = "Authorization: Bearer %s"\n' "$token2" > "$work/auth2.curl"
unset token1 token2

# Returns 0 when the attachment file for message $1 exists in ntfy's attachment directory.
on_disk() {
  "${compose[@]}" exec -T ntfy sh -c "test -e /var/lib/ntfy/attachments/$1"
}

printf '# Test summary\n' > "$work/summary.md"
local_sha="$(sha256sum "$work/summary.md" | cut -d' ' -f1)"

# Ping with an attachment: one PUT carries the file, priority, title and up to three view actions.
pub="$(curl -sS -f -K "$work/auth1.curl" -X PUT \
  -H 'Filename: 2026-11-02 1900 Test.md' \
  -H 'Title: Meeting summary ready' \
  -H 'Message: Summary ready' \
  -H 'Priority: 4' \
  -H "Click: $base/meetings/test" \
  -H "Actions: view, Open meeting page, $base/meetings/test; view, Sign in again, $base/login; view, Open form, $base/forms/test" \
  -T "$work/summary.md" "$base/tm-spike-member1")"

id="$(jq -r '.id' <<<"$pub")"
pub_time="$(jq -r '.time' <<<"$pub")"
att_url="$(jq -r '.attachment.url' <<<"$pub")"
att_expires="$(jq -r '.attachment.expires' <<<"$pub")"
ping_priority="$(jq -r '.priority' <<<"$pub")"
ping_actions="$(jq -r '.actions | length' <<<"$pub")"
ping_action_kinds="$(jq -r '[.actions[].action] | unique | join(",")' <<<"$pub")"
file_on_disk_after_publish=false
on_disk "$id" && file_on_disk_after_publish=true

# N1: no credentials
n1_status="$(curl -s -o /dev/null -w '%{http_code}' "$att_url")"

# N2: member 2 and member 1
n2_member2_status="$(curl -s -o /dev/null -w '%{http_code}' -K "$work/auth2.curl" "$att_url")"
n2_member1_status="$(curl -s -o "$work/member1.bin" -w '%{http_code}' -K "$work/auth1.curl" "$att_url")"
n2_member1_sha="$(sha256sum "$work/member1.bin" | cut -d' ' -f1)"
n2_identical=false
[[ "$n2_member1_sha" == "$local_sha" ]] && n2_identical=true

# Ping JSON: 3 view actions with priority 4 must be accepted and echoed
json_ping="$work/ping3.json"
jq -n --arg topic tm-spike-member1 '{
  topic: $topic,
  title: "Form needs you",
  message: "Open the form before the meeting starts",
  priority: 4,
  actions: [
    {action: "view", label: "Open form", url: "http://127.0.0.1/forms/test"},
    {action: "view", label: "Open meeting page", url: "http://127.0.0.1/meetings/test"},
    {action: "view", label: "Sign in again", url: "http://127.0.0.1/login"}
  ]
}' > "$json_ping"
ping3="$(curl -sS -K "$work/auth1.curl" -H 'Content-Type: application/json' -d @"$json_ping" "$base")"
json3_priority="$(jq -r '.priority' <<<"$ping3")"
json3_actions="$(jq -r '.actions | length' <<<"$ping3")"

# Ping JSON: 5 view actions (the design's button list) must be refused
json_ping5="$work/ping5.json"
jq -n --arg topic tm-spike-member1 '{
  topic: $topic,
  message: "Five buttons",
  priority: 4,
  actions: [
    {action: "view", label: "Open form", url: "http://127.0.0.1/a"},
    {action: "view", label: "Open meeting page", url: "http://127.0.0.1/b"},
    {action: "view", label: "Sign in again", url: "http://127.0.0.1/c"},
    {action: "view", label: "Make the bot leave", url: "http://127.0.0.1/d"},
    {action: "view", label: "Take over", url: "http://127.0.0.1/e"}
  ]
}' > "$json_ping5"
json5_status="$(curl -s -o "$work/ping5.out" -w '%{http_code}' -K "$work/auth1.curl" -H 'Content-Type: application/json' -d @"$json_ping5" "$base")"
json5_error="$(jq -r '.error // empty' "$work/ping5.out" 2>/dev/null || true)"

expires_minus_published="$((att_expires - pub_time))"

n3='null'
if (( wait_expiry )); then
  # Poll until the file is gone. ntfy deletes an attachment file only once it is 1 h old (orphan grace),
  # at its 15-minute sync. For the 2 m test set N3_DEADLINE_SECONDS=5400. Default 1500 s.
  deadline=$((att_expires + ${N3_DEADLINE_SECONDS:-1500}))
  while (( $(date +%s) < att_expires + 5 )); do sleep 5; done
  n3_status=''
  file_gone=false
  while :; do
    n3_status="$(curl -s -o /dev/null -w '%{http_code}' -K "$work/auth1.curl" "$att_url")"
    if ! on_disk "$id"; then file_gone=true; fi
    [[ "$n3_status" == 404 && "$file_gone" == true ]] && break
    (( $(date +%s) > deadline )) && break
    sleep 15
  done
  n3="$(jq -n --arg status "$n3_status" --argjson gone "$file_gone" \
    --argjson seconds "$(( $(date +%s) - pub_time ))" \
    '{memberTokenStatusAfterExpiry: ($status | tonumber), fileGone: $gone, secondsSincePublish: $seconds}')"
fi

version="$("${compose[@]}" exec -T ntfy ntfy --version | awk '{print $3}')"

run="$(jq -n \
  --arg version "$version" \
  --arg label "$label" \
  --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg n1 "$n1_status" \
  --arg n2m2 "$n2_member2_status" \
  --arg n2m1 "$n2_member1_status" \
  --argjson identical "$n2_identical" \
  --argjson pubTime "$pub_time" \
  --argjson expires "$att_expires" \
  --argjson expMinusPub "$expires_minus_published" \
  --argjson onDisk "$file_on_disk_after_publish" \
  --argjson pingPriority "$ping_priority" \
  --argjson pingActions "$ping_actions" \
  --arg pingKinds "$ping_action_kinds" \
  --argjson json3Priority "$json3_priority" \
  --argjson json3Actions "$json3_actions" \
  --arg json5 "$json5_status" \
  --arg json5Error "$json5_error" \
  --argjson n3 "$n3" \
  '{
    ntfyVersion: $version,
    expiryLabel: $label,
    checkedAt: $checkedAt,
    publishedAt: $pubTime,
    attachmentExpires: $expires,
    expiresMinusPublishedSeconds: $expMinusPub,
    fileOnDiskAfterPublish: $onDisk,
    N1_anonymousStatus: ($n1 | tonumber),
    N2_member2TokenStatus: ($n2m2 | tonumber),
    N2_member1TokenStatus: ($n2m1 | tonumber),
    N2_member1BytesIdenticalToSource: $identical,
    N3: $n3,
    pingAttachmentPriority: $pingPriority,
    pingAttachmentActionCount: $pingActions,
    pingAttachmentActionKinds: $pingKinds,
    pingJsonPriority: $json3Priority,
    pingJsonActionCount: $json3Actions,
    pingJsonFiveActionsStatus: ($json5 | tonumber),
    pingJsonFiveActionsError: $json5Error
  }')"

mkdir -p "$(dirname "$results")"
existing="$(cat "$results" 2>/dev/null || echo '{}')"
jq --arg k "$label" --argjson r "$run" '. + {($k): $r}' <<<"$existing" > "$results.tmp"
mv "$results.tmp" "$results"
cat "$results"
