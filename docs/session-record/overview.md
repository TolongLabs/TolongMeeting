# Session overview

On 19 October 2026 an AI agent (Claude Code on the user's Windows PC) attended a hackathon's Zoom opening ceremony in the user's place, recorded it, captured its slides and chat, transcribed it, wrote it up, published it to the team's repository, and then gathered the organisers' follow-up documents, while the user kept working on the same PC. This page summarises what happened; the other pages in this folder hold the detail.

Contents:

1.  [The job](#the-job)
1.  [Constraints](#constraints)
1.  [Result](#result)
1.  [Timeline](#timeline)
1.  [What worked](#what-worked)
1.  [What went wrong](#what-went-wrong)
1.  [Ten lessons for an app](#ten-lessons-for-an-app)
1.  [Where to read next](#where-to-read-next)

## The job

The user couldn't attend the SDC Hackathon 2026 online orientation (Zoom, 8 to 10 PM Malaysia time; link to be posted on Discord). They asked the agent to:

1.  Attend as a guest named "Team T010NG", with camera and microphone off.
2.  Record with their OBS Studio and stop when the meeting ends.
3.  Convert the recording to high-quality audio and transcribe it with their local Whisper project (`medium`).
4.  Capture notable slides during the meeting.
5.  Post-process by hand into the "three-file set" (transcript, slides, chat) used for an earlier hackathon.
6.  Fill an attendance form from the team portal if one appeared.
7.  Save the result to a Downloads folder and push it to the team repository.

Later requests: check whether problem statements were published, scrape the organisers' participant Drive folder, clean up, and document the whole session for building a general-purpose app.

## Constraints

- **Shared desktop**: the user kept working on the PC throughout, so the agent couldn't use the keyboard, mouse or foreground window.
- **Late link**: posted at 19:32 for an 8 PM start.
- **Modest hardware**: a 4 GB laptop GPU and 32 GB of RAM shared with Chrome, OBS and the user's apps.
- **Agent tooling limits**: browser-extension output truncated at 1,000 characters and redacted; scheduled prompts only live while the session runs; context compaction at 22:33.
- **Consent**: guest terms, recording notices, paid APIs, pushes and deletions all needed the user's say-so.

## Result

- The meeting was attended from 19:48 to its end at 21:16, recorded for 1:36:23 with complete audio; video lost about 6.5 minutes when the Chrome window was minimised.
- Published to `TolongLabs/sdc-hack` and the user's Downloads folder: an 11,600-word transcript, 65 slides with full text, 99 chat messages with cited answers.
- Also published: both problem statements and rubrics, the participant handbook, the submission templates, the sample repository and the tutorial videos, with a list of seven contradictions between official documents.
- The team learned its domain (Domain 1, AIverseCity) and the real deadline (25 October, 7:59 AM).
- Cost: under US$0.70 in API calls; everything else ran locally.

Details: [outcomes](outcomes.md).

## Timeline

| Time        | What happened                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------- |
| 17:43       | Request received; machine inventoried; precedents found                                            |
| 17:55       | Plan agreed (link source, display name, attendance form, output format)                            |
| 17:57-18:03 | Sleep disabled; isolated OBS profile and scene collection; websocket; Zoom desktop settings        |
| 18:03-18:28 | Rehearsal on Zoom's test meeting: desktop app abandoned, web client adopted, black-frame fix       |
| 18:28-19:34 | Discord polled every 5 minutes; link posted at 19:32                                               |
| 19:47-19:49 | Joined through the web client; recording started 19:49:12                                          |
| 19:49-21:16 | Meeting monitored: keyframes, chat capture, check-ins; Chrome minimised 20:09-20:16 (keeper added) |
| 21:16       | Host ended the meeting; recording stopped at 21:25 after a manual check                            |
| 21:26-21:35 | Slides cropped, curated and transcribed by four parallel agents                                    |
| 21:36       | Both transcription jobs killed by the harness for low memory                                       |
| 21:52-22:05 | User approved their OpenAI key; cloud cross-check pass run; Whisper medium re-run alone            |
| 22:02       | Team portal captured: Domain 1 and the organisers' Drive link                                      |
| 22:31-22:48 | Side-by-side review, clip re-checks, hand-written transcript, chat and slides                      |
| 22:49       | Pushed to the repository (`3bb70d2`, then `d651e50` for file modes)                                |
| 22:50-22:58 | Settings restored; Chrome shut down                                                                |
| 23:01-23:21 | Organisers' Drive scraped and documented; pushed (`60cce3f`)                                       |
| 23:35-23:40 | Local files cleaned up; this documentation started                                                 |

## What worked

- Joining Zoom through the web client's direct URL, with devices never granted to the browser.
- Recording only the meeting window and Chrome's own audio through an isolated OBS profile controlled by websocket.
- A frame watcher that kept 91 keyframes with no near-duplicates, and auto-cropping to the shared screen.
- Page JavaScript for everything inside the meeting, and focus-free Win32 calls for everything outside it.
- Two transcription engines plus targeted clip re-checks, with slides as the source of truth for names.
- Parallel subagents for vision-heavy transcription (slides, PDFs).
- Durable state that let scheduled prompts and the post-compaction agent carry on.

## What went wrong

- Keystrokes meant for a Zoom dialog went into the user's WhatsApp during the rehearsal (nothing was sent).
- Chrome stopped rendering when covered (fixed with a launch flag) and when minimised (fixed with a keeper, after 6.5 minutes of black video).
- The end of the meeting wasn't detected automatically; recording ran 9 minutes long.
- Chat messages were missed when the list scrolled up and when tool output was truncated; a sweep and a paging protocol recovered them.
- Running two Whisper jobs at once got both killed; the cloud model first chosen would have cost four times the estimate.
- Smaller snags: lost browser tab groups, a Node version mismatch in git hooks, an executable bit from the Windows drive, Git Bash mangling Windows switches, settings that didn't persist on exit.

Details: [problems and fixes](problems-and-fixes.md).

## Ten lessons for an app

1.  Never synthesise OS keyboard or mouse input on a shared desktop; drive the meeting page itself and use window calls that don't take focus. Better still, run in an isolated browser profile on a virtual display.
2.  Keep the capture surface rendering: disable Chrome's occlusion tracking, restore the window if minimised, and alarm on black frames from the first second.
3.  Join through the platform's web-client URL and resolve the page's DOM root at run time.
4.  Detect the end of a meeting from what's on the page (end dialog, controls gone, frozen count, silence), not from window titles.
5.  Treat chat as a virtualised list: pin it to the bottom, sweep it periodically and before teardown, and pull it with a cursor that only advances after a durable write.
6.  Assume the control channel is lossy: return small structured data, reduce URLs, page long output.
7.  Persist state and use stable helper functions for scheduled work; re-validate browser handles on every run.
8.  Budget memory and money: one heavy model at a time, price one chunk before a paid run, and ask before restarting killed jobs.
9.  Cross-check two transcription engines, re-check disagreements on short clips, use slides and invitations as vocabulary, and flag spoken facts that contradict the documents.
10. Isolate every change to the user's machine and keep a restore list that runs even after failure; verify that settings actually persisted.

## Where to read next

- [Workflow](workflow.md): each stage's goal, inputs, steps, outputs and checks.
- [Techniques](techniques.md): configuration, commands and code patterns.
- [Problems and fixes](problems-and-fixes.md): every failure with its cause, fix and design rule.
- [Decisions and guardrails](decisions-and-guardrails.md): the consent model and safety rules.
- [Environment](environment.md): machine, software, accounts and conventions.
- [Outcomes](outcomes.md): deliverables, numbers, costs and open items.
- [Runbook](runbook.md): how an agent should do this again today.
- [Reference scripts](../reference-scripts/README.md): the code written during the session.
