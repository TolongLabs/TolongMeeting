# Attendance form handler

How the worker detects, vets, fills and submits attendance forms. The rules the member relies on (trusted sources, what counts as an attendance form, what is filled, proof, never-do list) are FORM-1 to FORM-9 in [attendance forms](../PRD.md#attendance-forms) in the PRD. The code lives in `packages/worker/src/forms`, in milestones 1A (detection and trust) and 1B (filling and submitting). Lectures only. This page is part of the [TRD](../TRD.md#components).

Contents:

1.  [Detection](#detection)
1.  [QR decoding](#qr-decoding)
1.  [Opening](#opening)
1.  [Filling](#filling)
1.  [Submitting](#submitting)
1.  [State machine](#state-machine)

## Detection

- **Inputs**: QR codes from stage frames, links in the meeting chat, and links in the watched chat during the meeting.
- **Unwrapping**: unwrap known link wrappers (Microsoft Safe Links, Google redirect links). Follow up to 5 HTTP redirects with no cookies and no scripts, 5 seconds at most, to find the final URL.
- **Domains**: only final URLs on the providers in FORM-2 count.
- **Duplicates**: the same form URL is handled once per meeting, by canonical URL.
- **Trust**: the trust check runs before the form is opened (`checkTrust`; see [worker interfaces](../TRD.md#worker-interfaces)).

## QR decoding

Decode the full stage frame and, if known, the upscaled shared-screen region with both zxing-cpp and OpenCV's WeChat detector (compared in [spike 3](../TRD.md#early-spikes)). Accept a code only after it decodes in 2 consecutive frames.

## Opening

Open the URL in a new tab of the desk window, so the member's university session applies. The handler doesn't try to sign in when the form provider asks (FORM-5); it pings and waits for the member.

## Filling

1.  Read every question on the page: label, type, options and whether it's required.
1.  Match each question to a saved detail. Exact label variants match first. Otherwise all remaining labels on the page go to the form-matching model in one batched call. The call sends only the question labels and options (each cut to 120 characters, never the form description), asks for JSON in a fixed schema with thinking turned off, and allows 5 seconds. Only high-confidence matches count.
1.  Apply the filling rules in FORM-6, one page at a time through "Next" until "Submit".

## Submitting

Take the screenshots, submit and wait for the confirmation page as FORM-7 says. The attendance record, with the fields filled (names only in logs), is written to `forms/<formId>/record.json` ([data directory layout](../TRD.md#data-directory-layout)).

## State machine

The form's states and transitions are in [state machines](../TRD.md#state-machines).
