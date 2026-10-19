#!/usr/bin/env bash
# Cross-check pass: gpt-4o-transcribe over 3-minute chunks of the SDC opening FLAC (0 to 01:27:30).
# Env: WORKDIR (chunk output dir), SRC (meeting audio file), OPENAI_API_KEY or ENV_FILE (absolute path to a .env holding it).
set -uo pipefail
cd "${WORKDIR:?set WORKDIR to the chunk output directory}"
if [ -z "${OPENAI_API_KEY:-}" ]; then set -a; source <(grep -E "^OPENAI_API_KEY=" "${ENV_FILE:?set OPENAI_API_KEY or ENV_FILE}" | tr -d "\r"); set +a; fi
SRC="${SRC:?set SRC to the meeting audio file}"
END=5250
CH=180
PROMPT="SDC Hackathon 2026 online orientation by XMUM AI Club and the Rotaract Club of Xiamen University Malaysia (XMUM). Sponsors and partners: AIverseCity (Aiversecity), Alphared Solutions, Orbyte, Replit, RunPod, Kracked Devs, ORION AI Youth Community. Domain 1: Aiversecity Future-Ready Workforce. Domain 2: Orbyte Smart SME Challenge. Discord, WhatsApp, Google Drive, GitHub, README, Apache 2.0, SDG, MYT."
for ((s=0; s<END; s+=CH)); do
  n=$(printf %02d $((s/CH)))
  [ -s chunk_$n.json ] && continue
  ffmpeg -hide_banner -loglevel error -y -ss $s -t $CH -i "$SRC" -ac 1 -ar 16000 -b:a 64k chunk_$n.mp3
  if curl -sS --fail-with-body https://api.openai.com/v1/audio/transcriptions \
      -H "Authorization: Bearer $OPENAI_API_KEY" -F model=gpt-4o-transcribe -F file=@chunk_$n.mp3 \
      -F response_format=json -F language=en -F "prompt=$PROMPT" > chunk_$n.json.tmp; then
    mv chunk_$n.json.tmp chunk_$n.json; echo "chunk $n ok ($s s)"
  else
    echo "chunk $n FAILED: $(head -c 300 chunk_$n.json.tmp)"; rm -f chunk_$n.json.tmp
  fi
done
echo "done: $(ls chunk_*.json | wc -l) chunks"
