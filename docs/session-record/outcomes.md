# Outcomes

What the session produced, what it cost, how long each stage took, and what fell short. Use these numbers as the baseline an app has to beat.

Contents:

1.  [Deliverables](#deliverables)
1.  [Meeting coverage](#meeting-coverage)
1.  [Transcription](#transcription)
1.  [Slides and chat](#slides-and-chat)
1.  [Post-event sources](#post-event-sources)
1.  [Timings](#timings)
1.  [Costs](#costs)
1.  [Shortfalls and open items](#shortfalls-and-open-items)

## Deliverables

- **Three-file set** in `C:\Users\User\Downloads\sdc-hack-opening-ceremony\` and in the repo at `docs/sources/opening-briefing/`, byte-identical:
  - `transcript.md`: 11,621 words, speakers section, `[HH:MM:SS]` paragraphs from recording start, uncertain words marked as heard.
  - `slides.md` plus `slides/01.webp` to `65.webp` (2.9 MB): each slide's image and full text.
  - `chat.md`: 99 messages with an answer under each question, citing transcript times and slide numbers.
- **Participant Drive sources** in the repo at `docs/sources/participant-drive/`: both domain problem statements with rubrics, the participant handbook, the submission and technical-declaration templates, the sample repository, the video tutorials, and an index with a "Conflicts between sources" section.
- **Commits on `TolongLabs/sdc-hack` `main`**: `3bb70d2` (opening briefing), `d651e50` (file-mode fix), `60cce3f` (participant Drive).
- **Key fact for the team**: assigned Domain 1 (AIverseCity Future-Ready Workforce); preliminary deadline 25 October, 7:59 AM MYT.
- **Not produced**: no attendance form appeared, so none was filled.

## Meeting coverage

- Joined at 19:48 as "Team T010NG", about 12 minutes before the start; camera and microphone off throughout. 103 participants at the join, peaking at about 635 around 20:45, down to 407 by 21:15.
- Orientation ran 20:00 to 21:16 (host ended the meeting around 21:16:34); recording ran 19:49:12 to 21:25:36 (1:36:23).
- Audio: Chrome application audio only, mean level about -21 dB; complete for the whole meeting.
- Video: complete except about 20:09:35 to 20:16:00, when the Chrome window was minimised and the capture went black; a second minimise at 20:28:55 was undone within a second by the watchdog added after the first. Sponsor slides shown during the gap were lost; the audio of that stretch is in the transcript.
- The end of the meeting was not detected automatically (the tab title didn't change when the host ended it); recording was stopped by hand about nine minutes later.

## Transcription

- **Primary**: local Whisper `medium` on the GPU, 902 segments, 34.6 minutes wall time for 96 minutes of audio (about 2.8x real time) when run alone.
- **Cross-check**: OpenAI `gpt-4o-transcribe` in 30 three-minute chunks (about 10,900 words), replacing a planned CPU `large-v3` run that the memory reaper killed.
- **Targeted re-checks**: 16 clips of 20 to 80 seconds through both `gpt-4o-transcribe` and `whisper-1` to settle names, dates and passages one pass had dropped.
- **Hand-written result**: proper nouns fixed (sponsors, clubs, places), speakers attributed from introductions and hand-overs, three spoken dates that contradict the slides marked as heard with the slide value, silent stretches noted.
- **Accuracy issues seen in the raw passes**:
  - Whisper hallucinated on silence ("you" every 30 seconds, "Thank you for watching!").
  - `gpt-4o-transcribe` echoed its prompt for silent chunks.
  - Each pass dropped different stretches: `medium` missed the starts of two tutorial videos and a rules passage; the OpenAI pass missed nothing important.
  - Both mangled proper nouns without a prompt; the OpenAI prompt fixed most of them.

## Slides and chat

- **Frames**: 91 keyframes saved by the watcher, auto-cropped to the shared screen; 65 curated as slides, including stills from tutorial videos where they carried information.
- **Slide text**: transcribed by four parallel subagents in 2.5 to 4 minutes each; a handful of words hidden behind callouts or cursors marked `[covered]`; nothing marked illegible.
- **Chat**: 104 captured lines, 99 unique after de-duplication; about 50 questions, each answered from the organisers' live answers, their chat replies, the slides or the handbook. Two invite links removed.

## Post-event sources

- **Team portal** (captured at 10:05 PM): the team's domain and the Drive link; bank details and teammates' emails excluded.
- **Organisers' Drive folder**: 15 files (about 1 GB) downloaded through public link endpoints; 7 PDFs (190 pages), a sample repo zip and 7 videos turned into 8 Markdown documents by four subagents plus the main agent in about 20 minutes.
- **Findings**: the Drive copies of the official handbook and terms match the repo's website copies word for word; the new participant handbook contradicts the other official documents in seven places (deadline time, repo creation timing, repo visibility, mentor booking channel, formal-question channel, score reviews, pitching schedule and rooms).

## Timings

| Stage                                      | Wall time                                |
| ------------------------------------------ | ---------------------------------------- |
| Request to plan (inventory, research)      | About 12 minutes (17:43 to 17:55)        |
| Setup: OBS, Zoom settings, helpers         | About 30 minutes                         |
| Rehearsal with a Zoom test meeting         | About 25 minutes, three attempts         |
| Waiting for the link (5-minute polling)    | 18:28 to 19:34                           |
| Join                                       | About 2 minutes (19:47 to 19:48)         |
| Meeting, monitored                         | 19:48 to 21:25                           |
| Cropping, slide curation and export        | About 5 minutes                          |
| Slide transcription (4 agents in parallel) | About 4 minutes                          |
| Transcription, primary (after the reaper)  | 34.6 minutes                             |
| Transcription, cross-check (OpenAI)        | About 6 minutes                          |
| Write-up of transcript, chat and slides    | About 15 minutes (22:33 to 22:48)        |
| Publishing to the repo                     | About 1 minute, including a hook failure |
| Drive scrape and 8 documents               | About 20 minutes (23:01 to 23:21)        |

## Costs

- OpenAI: about US$0.30 to 0.50 for the full cross-check pass, about US$0.10 for one test chunk with the diarizing model, and a few cents for the clip re-checks.
- Everything else ran locally. Agent tokens are not counted here; the parallel subagents used roughly 80,000 to 300,000 tokens each.

## Shortfalls and open items

- The video gap lost a few sponsor slides; the organisers' own recording on Drive could fill it but wasn't downloaded.
- Meeting-end detection failed; an app needs a stronger signal (the "meeting has been ended by host" dialog, participant count dropping to one, or the leave page).
- Speaker attribution was manual; the two MCs shared one Zoom account and couldn't always be told apart.
- Three spoken dates remain unresolved (mentor-session dates, the final pitching date as spoken, and the judging dates as spoken); the slides and handbook give the authoritative values.
- The portal's mentor list and the Discord announcements after 10 PM weren't captured (they need a logged-in browser, and Chrome had been shut down).
- The organisers' documents contradict each other; the team should confirm the deadline and repository-creation timing with them.
