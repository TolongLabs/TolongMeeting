# Transcription and post-processing

How audio becomes a transcript, and how transcript, slides and chat become the summary. What the member gets is in [transcription](../PRD.md#transcription), [summaries](../PRD.md#summaries) and [name mentions](../PRD.md#name-mentions) in the PRD, and the summary's format is in the [design](../DESIGN.md#summary-file-format). The code lives in `packages/ai`, `packages/worker/src/asr` and `packages/pipeline`. This page is part of the [TRD](../TRD.md#components).

Contents:

1.  [Transcription](#transcription)
1.  [Name-mention detection](#name-mention-detection)
1.  [Post-processing](#post-processing)
1.  [Summary generation](#summary-generation)

## Transcription

- **Live mode**: stream the meeting audio (16 kHz mono PCM) to DashScope's real-time speech recognition, `qwen3-asr-flash-realtime`, over its WebSocket API on the Singapore endpoint, with the member's own key. It supports English and Malay.
  - **Timestamps** (decision 42): the expert review reports that this model returns no timestamps, accepts no vocabulary, and ends sessions at 120 minutes. The worker therefore timestamps each result by the stream offset of the audio it covers.
  - **Long meetings**: it reconnects during a pause before 110 minutes, with 5 seconds of overlapping audio, and removes duplicate text.
  - **Names**: corrected afterwards from slide text and the timetable entry (TRN-5).
  - **Swapping models**: [spike 5](../TRD.md#early-spikes) checks whether a streaming model with native timestamps and vocabulary support is available on DashScope; if so, it replaces this one behind the same interface.
- **Native mode**: after the meeting, 48 kHz mono FLAC is extracted wherever the recording is: on the server, or on the member's PC in local mode. For server runs, the companion app downloads the FLAC. It runs the member's configured whisper-transcriber command (default model `medium`, one job at a time) and uploads the text, subtitles and segment JSON.
- **Key failures**: a 401, 402 or 429 from DashScope raises `AiKeyError`; artefacts are kept (TRN-3).
- **Hallucination filter**: `isHallucination` drops the segments listed in TRN-4.

## Name-mention detection

In live mode the worker watches the live transcript for each of the member's names (MENT-1) and sends the ping in MENT-2 with the last 30 seconds of transcript.

## Post-processing

- **Slides**: keyframes are de-duplicated (the session's dHash rule) and cropped to the shared-screen region. Transition and partial frames are dropped, and slide text is read with the vision model. Output is numbered slides with images and text (SUM-4).
- **Chat**: processed as SUM-5 says; the code is `buildChat`, `orderChat` and `stripInviteLinks`.
- **Transcript**: built as SUM-6 says from the live results or the native segment JSON; the code is `buildTranscript`.
- The keyframe and crop algorithms start from the session's [techniques](../session-record/techniques.md#slides-cropping-curation-and-transcription).

## Summary generation

Two steps (designer's call):

1.  **Inventory**: extract an uncapped JSON list of every deadline, task, announcement and link from transcript, slides and chat, ranked as in SUM-2.
1.  **Render**: write the Markdown summary from the inventory with the template for the entry's type, following the i-have-adhd rules and the templates in the [design](../DESIGN.md#summary-file-format).

Prompts for summaries, slide reading and form-label matching are left to the builder within the templates and rules.
