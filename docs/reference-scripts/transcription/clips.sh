#!/usr/bin/env bash
# Re-check short clips: gpt-4o-transcribe (text) + whisper-1 (segment timestamps). Args: name start_s dur_s ...
# Env: WORKDIR, SRC, OPENAI_API_KEY or ENV_FILE, as for run.sh. segs.py is taken from this script's directory.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "${WORKDIR:?set WORKDIR to the working directory}"; mkdir -p clips
if [ -z "${OPENAI_API_KEY:-}" ]; then set -a; source <(grep -E "^OPENAI_API_KEY=" "${ENV_FILE:?set OPENAI_API_KEY or ENV_FILE}" | tr -d "\r"); set +a; fi
SRC="${SRC:?set SRC to the meeting audio file}"
# Vocabulary prompt: replace the <...> placeholders with the real speaker names (they fix name spellings).
PROMPT="SDC Hackathon 2026 orientation, Xiamen University Malaysia (XMUM), AI Club, Rotaract Club. MCs <MC_1> and <MC_2>. <SPEAKER_1> (<SPEAKER_1_FULL_NAME>), <SPEAKER_2>, <SPEAKER_3>, <SPEAKER_4>. Sponsors AIverseCity, <SPONSOR_SPEAKER_1>, Alphared Solutions, Orbyte, RunPod, <SPONSOR_SPEAKER_2>, Replit, Kracked Devs."
while [ $# -ge 3 ]; do
  n=$1; s=$2; d=$3; shift 3
  ffmpeg -hide_banner -loglevel error -y -ss $s -t $d -i "$SRC" -ac 1 -ar 16000 -b:a 64k clips/$n.mp3
  g=$(curl -sS https://api.openai.com/v1/audio/transcriptions -H "Authorization: Bearer $OPENAI_API_KEY" -F model=gpt-4o-transcribe -F file=@clips/$n.mp3 -F language=en -F "prompt=$PROMPT" -F response_format=json | python3 -c "import sys,json; print(json.load(sys.stdin).get(chr(116)+'ext', '?'))")
  w=$(curl -sS https://api.openai.com/v1/audio/transcriptions -H "Authorization: Bearer $OPENAI_API_KEY" -F model=whisper-1 -F file=@clips/$n.mp3 -F language=en -F "prompt=$PROMPT" -F response_format=verbose_json -F "timestamp_granularities[]=segment" | python3 "$HERE/segs.py" $s)
  printf "## %s @%ss+%s\nG: %s\nW: %s\n\n" "$n" "$s" "$d" "$g" "$w"
done
