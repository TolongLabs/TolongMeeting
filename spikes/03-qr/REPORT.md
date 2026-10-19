# Spike 03: QR decoding

Which QR decoder (zxing-cpp WebAssembly, OpenCV's WeChat detector, or both) finds attendance-form codes on 1080p stage frames fast and reliably enough? Partial: all three pipelines are safe and cheap, none reaches 90% at 8% slide height, and the rule picks `wechat` with codes of 12% or more. This is synthetic evidence. Run on 2026-10-20 on a local workstation (one pinned core of an AMD Ryzen 9 9950X3D), not the Singapore server, with no worker image.

Contents:

1.  [Verdict](#verdict)
1.  [Setup](#setup)
1.  [Procedure](#procedure)
1.  [Measurements](#measurements)
1.  [Decisions](#decisions)
1.  [Design and plan edits](#design-and-plan-edits)
1.  [Surprises](#surprises)
1.  [Data](#data)

## Verdict

Partial. No test meeting or second account existed, so the frames are synthetic: 18 slides imitating a Zoom web client, three share conditions, 540 frames each, 1,620 in all. On the two typical conditions (A: chat open, 720p share; B: no chat, 1080p share) every pipeline passes:

- Q1 (no wrong or blank-slide decodes).
- Q3 (decode rate of 98.8% to 100% at 12% or more).
- Q4 (p95 of 81 to 241 ms against a 1,500 ms limit).
- Q5 (bridge overhead 0.6 ms at p95, start in 188 ms).

No pipeline passes Q2 at 8%. `wechat` misses all three 8% codes in condition A. `zxing` misses the long Google URL code at 8% in A. By the plan's rule the result is `qr.decoder=wechat` with `qr.minSizePct=12`.

Size is the limit, not decoder speed. A Google Forms URL makes a version 7 code of 53 modules including the quiet zone. It needs about 12% of the slide height to reach 1.8 pixels per module when the chat panel is open.

The two decoders are complementary:

- zxing with the 2x region pass finds small Microsoft and `forms.gle` codes that WeChat misses.
- WeChat finds both codes of a two-code slide, where zxing's first-hit stop misses one.

A union of all four stages, which the plan's `both` does not do, is the best configuration measured (see [Surprises](#surprises)). Real captures from Task 2's platforms must confirm this.

## Setup

- **Accounts**: none.
- **Meetings and forms**: none. `make_frames.py` builds frames with random form URLs of each provider's real length. The URLs point nowhere.
- **Versions**: zxing-wasm 3.1.6, sharp 0.35.5, Node v24.21.0, Bun 1.4.0, Python 3.12.13, `opencv-contrib-python-headless` 4.14.0.94, numpy 2.5.4, segno 1.6.6, Pillow 13.0.0, ffmpeg 8.0.1 (libx264).
- **WeChat models** (`WeChatCV/opencv_3rdparty`, branch `wechat_qrcode`, SHA-256 also in `fetch-models.sh`):
  - `detect.prototxt` e8acfc395caf443a47f15686a9b9207b36cb8f7e6ceb8fbaf6466665e68a9466
  - `detect.caffemodel` cc49b8c9babaf45f3037610fe499df38c8819ebda29e90ca9f2e33270f6ef809
  - `sr.prototxt` 8ae41acba97e8b4a8e741ee350481e49b8e01d787193f470a4c95ee1c02d5b61
  - `sr.caffemodel` e5d36889d8e6ef2f1c1f515f807cec03979320ac81792cd8fb927c31fd658ae3
- **Machine**: 8 logical CPUs, shared with other work. Decoders ran under `taskset -c 3` with OpenCV threads set to 1.

## Procedure

1.  Plan and frames. Deviation: no live share. `make-deck.sh <dir>` runs `make_frames.py`, which writes `deck-plan.csv` and the frames.
    - The plan has 18 slides: three URL kinds at 5, 8 and 12% bottom-right and 20 and 35% centre, one slide with two 12% codes, and two blank controls, shuffled with seed 3.
    - Each QR is made with segno (error level M, 4-module quiet zone, scale 20) and scaled onto the slide with Lanczos.
    - Deviation: `qrencode` and `zbarimg` are not installed. OpenCV's `QRCodeDetector` checks every source image against its URL instead, and all 18 passed.
    - Sizes are percentages of the 1080 px slide height, quiet zone included.
1.  Each frame is a 1920x1080 stage with dark chrome, a floating video tile and an optional 480 px chat panel (25% of the width).
    - The slide is scaled to the share's sent resolution, encoded and decoded once with libx264 (`-preset veryfast`, crf set per frame), optionally blurred, then scaled into the stage with bilinear filtering.
    - The crf starts higher at the slide change, eases down over about 5 seconds, and has Gaussian jitter.
    - One frame every 2 seconds, 30 per slide, named `HHMMSS.png` from 10:00:00.

    | Condition | Layout                | Sent resolution | crf (base, extra at t=0, jitter) | Blur  | Shared rect `x,y,w,h` | Role   |
    | --------- | --------------------- | --------------- | -------------------------------- | ----- | --------------------- | ------ |
    | A         | chat open             | 1280x720        | 26, +5, 2.0                      | none  | `0,123,1440,810`      | scored |
    | B         | no chat               | 1920x1080       | 22, +4, 2.0                      | none  | `121,56,1678,944`     | scored |
    | C         | chat open, poor video | 960x540         | 34, +4, 2.5                      | 0.6px | `0,123,1440,810`      | stress |

1.  Install: `uv venv --python 3.12 spikes/03-qr/.venv`, `uv pip install` the pins in `requirements.txt`, `bun add zxing-wasm sharp --exact` in `spikes/03-qr`, then `fetch-models.sh`.
    - Deviation: the Dockerfile and image `tm-spike-qr` were not built (no worker image or server in this run).
    - Deviation: OpenCV 5.0.0.93 was tried first. Its `WeChatQRCode` constructor takes at most 2 arguments, so the pin is the latest 4.x.
1.  Decode: `run-decode.sh $WORK $WORK/results/decodes.csv 3` runs `decode-zxing.mjs` and `decode_wechat.py` per condition, each under `taskset -c 3`. Rows are `frame,tSec,decoder,mode,ms,texts`.
    - `ms` covers PNG decode, crop and 2x Lanczos resize (region only), and the decode call.
    - zxing options: `formats: ['QRCode']`, `tryHarder`, `tryInvert` and `tryDownscale` on, `tryRotate` off, up to 8 symbols.
    - The work directory is `~/.cache/tm-spike-qr`, outside the repo.
1.  Bridge: `taskset -c 3 node bridge-check.mjs --frames samples --rect 0,123,1440,810 --n 100 --out data/bridge.json`, run three times. The committed file is the cold first run.
1.  Score: `bun score.ts --decodes data/decodes.csv --plan deck-plan.csv --slide-starts data/slide-starts.csv --bridge data/bridge.json --out data/summary.json`. The decision uses A and B. C is scored the same way as a stress case.

## Measurements

Scored on A and B: 1,080 frames and 28 code instances of 8% or more. A code counts as accepted when two consecutive frames decode its URL within 10 seconds of its slide appearing. The earliest possible time is 2 seconds.

| Check                     | Threshold                                  | `zxing`             | `wechat`             | `both` (first hit)   | Result                       |
| ------------------------- | ------------------------------------------ | ------------------- | -------------------- | -------------------- | ---------------------------- |
| Q1 No wrong text          | 0 wrong, 0 on blank slides                 | 0 and 0             | 0 and 0              | 0 and 0              | pass, all                    |
| Q2 Accept time, 8% and up | all within 10 s                            | 26 of 28            | 25 of 28             | 26 of 28             | fail, all                    |
| Q3 Frame rate, 12% and up | 90% or more                                | 98.8%               | 100%                 | 98.8%                | pass, all                    |
| Q4 Cost per frame         | p95 of 1,500 ms or less, one vCPU          | p50 20.7, p95 146.5 | p50 15.9, p95 80.8   | p50 20.7, p95 227.3  | pass, all                    |
| Q5 Bridge                 | overhead 100 ms or less, start 5 s or less | not applicable      | 0.6 ms, start 188 ms | 0.6 ms, start 188 ms | pass for `wechat` and `both` |

Notes on these numbers:

- Q4 charges each stage its own PNG decode, so a full-then-region pass is slightly overstated.
- Accept time at 12% and up has a median of 2 s for every pipeline. `zxing` and `both` have one slow code (16 s) on the two-code slide. `wechat` has none (maximum 2 s).
- Q2 failures, `zxing` and `both`: the long Google code at 8% in A, and the Google code of the two-code slide at 12% in A. On most frames zxing's full pass finds only the Microsoft code, and the first-hit stop never tries the other stages.
- Q2 failures, `wechat`: the three 8% codes in A (Microsoft, `forms.gle`, Google). It finds all 8% codes in B on the full frame.

Pixels per QR module on the stage, quiet zone included:

| Kind (QR version, modules)                 | Frame | 5%   | 8%   | 12%  | 20%  | 35%  |
| ------------------------------------------ | ----- | ---- | ---- | ---- | ---- | ---- |
| `forms.office.com` and `forms.gle` (3, 37) | A, C  | 1.09 | 1.75 | 2.63 | 4.38 | 7.66 |
| `forms.office.com` and `forms.gle` (3, 37) | B     | 1.28 | 2.04 | 3.06 | 5.10 | 8.93 |
| Google long URL (7, 53)                    | A, C  | 0.76 | 1.22 | 1.83 | 3.06 | 5.35 |
| Google long URL (7, 53)                    | B     | 0.89 | 1.42 | 2.14 | 3.56 | 6.23 |

Per-frame decode rate by size, single stages, A and B pooled (the two-code slide is included at 12%):

| Size | `zxing` full | `zxing` region | `wechat` full | `wechat` region |
| ---- | ------------ | -------------- | ------------- | --------------- |
| 5%   | 0%           | 18.3%          | 0%            | 0%              |
| 8%   | 72.2%        | 82.2%          | 50.0%         | 13.3%           |
| 12%  | 93.3%        | 99.7%          | 100%          | 100%            |
| 20%  | 100%         | 100%           | 100%          | 100%            |
| 35%  | 100%         | 100%           | 100%          | 100%            |

Codes accepted within 10 s (A and B; 6 instances per size, 10 at 12%):

| Size | `zxing` | `wechat` | `both` | `bothUnion` (all four stages, union, not a plan candidate) |
| ---- | ------- | -------- | ------ | ---------------------------------------------------------- |
| 5%   | 1/6     | 0/6      | 1/6    | 1/6                                                        |
| 8%   | 5/6     | 3/6      | 5/6    | 5/6                                                        |
| 12%  | 9/10    | 10/10    | 9/10   | 10/10                                                      |
| 20%  | 6/6     | 6/6      | 6/6    | 6/6                                                        |
| 35%  | 6/6     | 6/6      | 6/6    | 6/6                                                        |

- **Smallest size from which every code is accepted:** `zxing` 20%, `wechat` 12%, `both` 20%, `bothUnion` 12%.
- **Stage time per frame (p50 and p95 ms, A and B):**
  - `zxing` full: 14.7 and 22.8.
  - `zxing` region: 117.2 and 134.3.
  - `wechat` full: 14.1 and 30.3.
  - `wechat` region: 62.9 and 80.4.
  - `bothUnion`: p50 219.7 and p95 241.2.
- **Stress condition C:** Q1 passes. Q3 fails at 57.6% for `zxing`, 63.6% for `wechat` and 65.5% for `both`. Q2 accepts 5, 6 and 6 of 14 codes. Q4 passes (p95 124, 109 and 229 ms). `minSizePct` is 35 for all three. At 20% only the Microsoft and `forms.gle` codes pass.
- **Q5 over three runs** of 100 round trips of the 8 sample frames (about 223 KB each):
  - Start: 137 to 188 ms (spawn to first answer, including the first decode).
  - Overhead at p95: 0.5 to 0.6 ms.
  - Round-trip at p95: 77 to 90 ms, all of it WeChat's own decode time.

## Decisions

| Key             | Value                                                                             | Read by |
| --------------- | --------------------------------------------------------------------------------- | ------- |
| `qr.decoder`    | `wechat` (rule result; `both` with union is better on this data, see Surprises)   | 01a     |
| `qr.minSizePct` | 12                                                                                | 01a     |
| `qr.p95Ms`      | 81 for `wechat` (146.5 `zxing`, 227.3 `both`, 241.2 `bothUnion`; one pinned core) | 01a     |

Basis: no pipeline passes Q1 to Q5, because Q2 fails at 8% for all three. The rule then takes the pipeline with the smallest passing size among those passing Q1, Q4 and Q5. That is `wechat` at 12%, against 20% for `zxing` and `both`.

## Design and plan edits

None applied. Task 9's rows for this spike would be:

- Row 3.2 (`qr.decoder=wechat`): `decodeQr` talks to `decode_wechat.py --serve`.
- Row 3.4 (`qr.minSizePct` above 8): add "Codes smaller than 12% of the slide height may be missed; links in chat remain the fallback." to the design's "Attendance form handler", QR decoding.

They are held back because the evidence is synthetic. `.prettierignore` gained `spikes/03-qr/.venv/`.

## Surprises

- **First-hit stop.** The stop-at-first-hit rule of `both` decides the outcome on one slide. When two codes are on screen, the first stage that finds any code ends the pipeline, so the second code is missed.
  - This costs `zxing` and `both` the 12% line (20% minimum size), although `both` is a superset of `zxing`.
  - `bothUnion` gives 10 of 10 at 12%, 5 of 6 at 8% (only the long Google code in A fails) and p95 241 ms. That beats every rule candidate.
  - A real attendance slide rarely holds two codes. The union costs about 200 ms more at p50.
- **WeChat region pass.** The 2x region pass does not help WeChat and hurts at 8% (13.3% against 50.0% on the full frame). zxing gains most from it: 72% to 82% at 8%, and the only decodes at 5%.
- **WeChat cliff.** At 8%, WeChat decodes 0% in A (65 px) and 100% in B (76 px) for all three kinds. zxing degrades gradually.
- **Size by provider.** The long Google URL needs about 12% of the slide height with chat open. The two shorter URLs read at 8%. QR size guidance should be per provider, not one number.
- **OpenCV pin.** OpenCV 5.0.0 changed the `WeChatQRCode` constructor, so the pin is 4.14.0.94.
- **Limits of the evidence:**
  - Frames within a slide differ only in encode quality.
  - There is no slide-change latency, cursor or live video under the code.
  - Each slide is rendered once.
  - The CPU is a fast desktop core. The 1,500 ms limit is met with a wide margin, but a server vCPU may be 2 to 3 times slower.
  - Capture is lossless apart from the share encode.
- **`/tmp` tmpfs.** `/tmp` is a 1 GB tmpfs. The first frame run failed with "No space left on device", so frames live in `~/.cache/tm-spike-qr`.

## Data

- **Committed under `spikes/03-qr/data/`:**
  - `decodes.csv`: 6,480 rows.
  - `summary.json`: Q1 to Q5 per pipeline for A and B and for C, stage tables, size curves and the decision.
  - `bridge.json`, `frames.csv` (truth), `slide-starts.csv`.
- **Committed under `spikes/03-qr/samples/`:** 8 synthetic stage frames (blank, 5, 8, 12, 20 and 35% codes, and the two-code slide; conditions A, B and C), 1.8 MB.
- **Not committed:** the 1,620 frames (about 400 MB) in `~/.cache/tm-spike-qr/frames`, `.venv/`, `models/` (fetch with `fetch-models.sh`) and `node_modules/`.
- **Reproduce:** `make-deck.sh $WORK/frames`, then `run-decode.sh $WORK data/decodes.csv 3`, then the Bridge and Score steps above.
