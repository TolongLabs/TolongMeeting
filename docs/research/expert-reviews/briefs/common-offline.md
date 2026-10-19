## The job

You are reviewing a software design specification for an internal tool called TolongMeeting, built by a small Malaysian developer collective (TolongLabs). The tool sends a bot into online lectures and work meetings (Zoom, Microsoft Teams, Google Meet) as the member themself, using a Chrome browser profile that is signed in to the member's own accounts. It records the meeting, transcribes it, detects attendance forms (a QR code on the shared screen or a Google Forms or Microsoft Forms link in chat) and submits them with saved details, then delivers an ADHD-friendly summary file plus a small website with full details. One person will build it, with no deadline. Today is 20 October 2026.

The requester asked one question: is this spec rigid (precise enough to plan and build from without guessing) and feasible (will it actually work as specified, in October 2026, for one builder)? Answer it from your specialist angle only. Be blunt. Do not rewrite the spec.

## Inputs (read them; never mention their machine paths in your output)

- `inputs/design.md`: the specification under review. Read all of it.
- `inputs/overview.md`, `inputs/workflow.md`, `inputs/techniques.md`, `inputs/problems-and-fixes.md`: the record of a manual run on 19 October 2026, when an AI agent attended a Zoom meeting through the Zoom web client in Chrome on a Windows desktop. The spec builds on its lessons. Consult these as needed.

They are in the workspace directory that contains `inputs/` (the parent of your output directory).

Web and URL tools are NOT available in this run: do not call them (they are denied and end the run). Rely on your own knowledge and the inputs. Mark every factual claim you cannot confirm from the inputs as (unverified), name the official documentation that should be checked, and never invent facts, versions, prices or API names.

## Output: exactly one file, and nothing else

Write your review to the output file named in your specialist brief. Create no other files, and change nothing in `inputs/`.

Format (Markdown, strictly):

- One H1: `# <Your specialist title> review`.
- A 2 to 3 sentence intro, then a line `Contents:` followed by a numbered list linking every `##` heading (use `1.  ` for every item).
- `## Verdict`: one of "Feasible as specified", "Feasible with changes" or "Not feasible as specified", then 3 to 5 sentences explaining why.
- `## Findings`: each finding as a `###` heading `<ID>: <short title>`, where ID is your prefix plus a two-digit number (for example BOT-01). Then these bullets, in this order:
  - **Severity:** Blocker (the spec can't work as written), Major (it will work badly or cost far more than planned unless changed), or Minor.
  - **Spec section:** the heading in design.md it concerns.
  - **Problem:** what is wrong, missing, ambiguous or risky.
  - **Evidence:** sources or reasoning; mark uncertain points as uncertain.
  - **Recommended change:** a concrete change to the spec, phrased so it could be pasted in.

  Order the findings by severity, then importance. Aim for 6 to 15 findings; quality over quantity.

- `## Rigidity gaps`: places where a builder would have to guess and a wrong guess would matter. One line each, naming the spec section.
- `## What the spec gets right`: up to 5 bullets.
- `## Questions for the requester`: only questions whose answers would change what gets built (may be empty: say "None").

Style: sentence-case headings; no hard line wraps (one line per paragraph or list item); no trailing whitespace; plain British English; no emojis; total length 1,500 to 3,000 words.

## Report

When done, print a short report to stdout: the file written, the verdict, and the count of findings by severity.
