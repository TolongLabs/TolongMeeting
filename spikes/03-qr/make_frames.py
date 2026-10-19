#!/usr/bin/env python3
"""Synthesise Zoom-like 1920x1080 stage frames with QR codes on a shared slide.

Stands in for the live share of plan 00, task 3 (no test meeting exists). Per condition it writes one PNG
every 2 seconds, 30 per slide, named HHMMSS.png, plus frames.csv (truth) and slide-starts.csv.
The shared slide is scaled to the share's sent resolution, encoded and decoded with libx264, then
scaled into the stage like the browser does, so blocking and blur match a real share.
"""
import argparse
import csv
import math
import random
import string
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
import segno
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1920, 1080
FRAMES_PER_SLIDE = 30
FRAME_STEP = 2
SLIDE_SECONDS = FRAMES_PER_SLIDE * FRAME_STEP
START_SEC = 10 * 3600
TOP_BAR, BOTTOM_BAR, CHAT_W = 56, 80, 480
FONT_DIR = '/usr/share/fonts/truetype/dejavu/'
BOLD = FONT_DIR + 'DejaVuSans-Bold.ttf'
REG = FONT_DIR + 'DejaVuSans.ttf'

# send = resolution of the share stream, crf = (base, extra at t=0 that decays, jitter), blur = sigma after decode
CONDITIONS = {
    'A': dict(chat=True, send=(1280, 720), crf=(26, 5, 2.0), blur=0.0, note='chat open, 720p share, typical bitrate'),
    'B': dict(chat=False, send=(1920, 1080), crf=(22, 4, 2.0), blur=0.0, note='no chat, 1080p share, good bitrate'),
    'C': dict(chat=True, send=(960, 540), crf=(34, 4, 2.5), blur=0.6, note='chat open, 540p share, poor bitrate, soft'),
}
THEMES = [
    ((255, 255, 255), (20, 30, 60), (30, 90, 200)),
    ((250, 244, 220), (60, 40, 20), (190, 90, 30)),
    ((22, 40, 90), (240, 240, 250), (250, 190, 40)),
    ((236, 246, 238), (20, 60, 40), (30, 140, 80)),
    ((40, 40, 46), (235, 235, 235), (120, 200, 240)),
    ((255, 255, 255), (0, 0, 0), (200, 30, 30)),
]
TOPICS = [
    ('Week 7: Database Normalisation', ['First normal form and atomic values', 'Functional dependencies', 'Boyce-Codd normal form', 'Worked example: library loans']),
    ('Operating Systems: Scheduling', ['Round robin and time slices', 'Priority inversion', 'Multilevel feedback queues', 'Tutorial 5 due Friday']),
    ('Research Methods Seminar', ['Sampling and bias', 'Writing a literature review', 'Ethics approval checklist', 'Questions from last week']),
    ('Machine Learning: Regularisation', ['Overfitting and variance', 'L1 versus L2 penalties', 'Cross validation folds', 'Assignment 2 hints']),
    ('Software Architecture Review', ['Layered style', 'Event driven design', 'Trade-off analysis', 'Case study discussion']),
    ('Statistics: Hypothesis Tests', ['Null and alternative', 'p-values and effect size', 'Type I and II errors', 'Practice questions']),
]
CHAT = ['Please remember to sign the attendance form today', 'Slides will be shared after the lecture', 'Can you zoom in on the diagram?',
        'Thanks, that is clear', 'Is the quiz open book?', 'Break at 3:15', 'Lecture notes are on the portal']

KINDS = {
    'msforms': ('https://forms.office.com/r/', string.ascii_letters + string.digits, 10, ''),
    'google': ('https://docs.google.com/forms/d/e/1FAIpQLS', string.ascii_letters + string.digits + '_-', 48, '/viewform?usp=sf_link'),
    'gle': ('https://forms.gle/', string.ascii_letters + string.digits, 17, ''),
}


def make_url(rng, kind):
    prefix, alphabet, n, suffix = KINDS[kind]
    return prefix + ''.join(rng.choice(alphabet) for _ in range(n)) + suffix


def build_plan(rng):
    codes = []  # (urlKind, sizePct, position, url)
    for kind in KINDS:
        for pct, pos in ((5, 'br'), (8, 'br'), (12, 'br'), (20, 'centre'), (35, 'centre')):
            codes.append([(kind, pct, pos, make_url(rng, kind))])
    codes.append([('google', 12, 'br', make_url(rng, 'google')), ('msforms', 12, 'bl', make_url(rng, 'msforms'))])
    codes.append([])
    codes.append([])
    rng.shuffle(codes)
    return codes


def qr_image(url, size_px):
    big = segno.make(url, error='m', boost_error=False)
    buf = Path(tempfile.mkstemp(suffix='.png')[1])
    big.save(buf, kind='png', scale=20, border=4, dark='black', light='white')
    im = Image.open(buf).convert('RGB')
    buf.unlink()
    # step 1 check: the source image must decode to its URL with an independent decoder (stands in for zbarimg)
    decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(np.asarray(im)[:, :, ::-1])
    if decoded != url:
        raise SystemExit(f'source QR does not decode to its URL: {url!r} -> {decoded!r}')
    return im.resize((size_px, size_px), Image.LANCZOS), big.version


def render_slide(idx, codes, rng):
    bg, fg, accent = THEMES[idx % len(THEMES)]
    im = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(im)
    title, bullets = TOPICS[(idx * 5 + 1) % len(TOPICS)]
    d.rectangle([0, 0, 24, H], fill=accent)
    d.text((110, 90), title, font=ImageFont.truetype(BOLD, 74), fill=fg)
    d.rectangle([110, 190, 560, 198], fill=accent)
    f = ImageFont.truetype(REG, 46)
    for i, b in enumerate(bullets):
        y = 260 + i * 92
        d.ellipse([110, y + 16, 130, y + 36], fill=accent)
        d.text((160, y), b, font=f, fill=fg)
    d.text((W - 160, 40), f'{idx + 1}', font=ImageFont.truetype(BOLD, 40), fill=accent)
    versions = []
    for kind, pct, pos, url in codes:
        s = round(pct / 100 * H)
        qr, ver = qr_image(url, s)
        versions.append(ver)
        if pos == 'br':
            x, y = W - s - round(0.03 * W), H - s - round(0.04 * H)
        elif pos == 'bl':
            x, y = round(0.03 * W), H - s - round(0.04 * H)
        else:
            x, y = (W - s) // 2, (H - s) // 2 + 40
        im.paste(qr, (x, y))
    return im, versions


def chrome_base(chat, rng):
    im = Image.new('RGB', (W, H), (28, 28, 30))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, TOP_BAR], fill=(35, 35, 38))
    d.rounded_rectangle([20, 12, 380, 44], radius=8, fill=(30, 110, 60))
    d.text((34, 17), "You are viewing Lecturer's screen", font=ImageFont.truetype(REG, 18), fill=(235, 245, 235))
    d.text((W // 2 - 120, 16), 'Lecture room 3 (online)', font=ImageFont.truetype(REG, 22), fill=(220, 220, 220))
    d.rectangle([0, H - BOTTOM_BAR, W, H], fill=(35, 35, 38))
    for i in range(7):
        x = W // 2 - 330 + i * 100
        d.ellipse([x, H - BOTTOM_BAR + 14, x + 52, H - BOTTOM_BAR + 66], fill=(60, 60, 66))
    d.rounded_rectangle([W - 190, H - BOTTOM_BAR + 20, W - 30, H - BOTTOM_BAR + 62], radius=8, fill=(190, 40, 40))
    if chat:
        x0 = W - CHAT_W
        d.rectangle([x0, TOP_BAR, W, H - BOTTOM_BAR], fill=(43, 43, 46))
        d.text((x0 + 24, TOP_BAR + 18), 'Chat', font=ImageFont.truetype(BOLD, 26), fill=(240, 240, 240))
        fm = ImageFont.truetype(REG, 20)
        y = TOP_BAR + 80
        for m in rng.sample(CHAT, 5):
            d.text((x0 + 24, y), 'Participant to Everyone', font=ImageFont.truetype(REG, 15), fill=(150, 150, 160))
            d.text((x0 + 24, y + 22), m[:34], font=fm, fill=(225, 225, 225))
            if len(m) > 34:
                d.text((x0 + 24, y + 46), m[34:], font=fm, fill=(225, 225, 225))
            y += 100
        d.rounded_rectangle([x0 + 20, H - BOTTOM_BAR - 70, W - 20, H - BOTTOM_BAR - 20], radius=8, fill=(30, 30, 33))
        d.text((x0 + 36, H - BOTTOM_BAR - 56), 'Type message here...', font=fm, fill=(120, 120, 128))
    return im


def share_rect(chat):
    area_w = W - CHAT_W if chat else W
    area_h = H - TOP_BAR - BOTTOM_BAR
    scale = min(area_w / W, area_h / H)
    w, h = round(W * scale), round(H * scale)
    return ((area_w - w) // 2, TOP_BAR + (area_h - h) // 2, w, h)


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def x264_roundtrip(img, send, crf, tmp, tag):
    src, mp4, dec = tmp / f'{tag}.png', tmp / f'{tag}.mp4', tmp / f'{tag}-d.png'
    img.resize(send, Image.BICUBIC).save(src, compress_level=1)
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(src), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', f'{crf:.1f}',
         '-pix_fmt', 'yuv420p', '-frames:v', '1', str(mp4)])
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(mp4), '-frames:v', '1', str(dec)])
    out = Image.open(dec).convert('RGB')
    out.load()
    for p in (src, mp4, dec):
        p.unlink()
    return out


def video_tile(rng, t):
    arr = np.zeros((108, 192, 3), np.uint8)
    yy, xx = np.mgrid[0:108, 0:192]
    phase = rng.random() * 6
    for c in range(3):
        arr[..., c] = (128 + 100 * np.sin(xx / 17.0 + yy / 23.0 * (c + 1) + phase + t / 3.0)).astype(np.uint8)
    return Image.fromarray(arr)


def render_frame(job):
    cond, k_slide, k, slide_img, base, rect, out_path, seed, tmp = job
    c = CONDITIONS[cond]
    rng = random.Random(seed)
    t = k * FRAME_STEP
    b, extra, jit = c['crf']
    crf = max(10.0, min(51.0, b + extra * math.exp(-t / 5.0) + rng.gauss(0, jit)))
    dec = x264_roundtrip(slide_img, c['send'], crf, tmp, f'{cond}-{k_slide}-{k}')
    if c['blur']:
        dec = dec.filter(ImageFilter.GaussianBlur(c['blur']))
    x, y, w, h = rect
    stage = base.copy()
    stage.paste(dec.resize((w, h), Image.BILINEAR), (x, y))
    stage.paste(video_tile(rng, t), (x + w - 200, y + 8))
    stage.save(out_path, compress_level=1)
    return crf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='directory for frames (outside the repo)')
    ap.add_argument('--plan', default=str(Path(__file__).with_name('deck-plan.csv')))
    ap.add_argument('--seed', type=int, default=3)
    ap.add_argument('--jobs', type=int, default=6)
    a = ap.parse_args()
    out = Path(a.out)
    rng = random.Random(a.seed)
    deck = build_plan(rng)
    tmp = Path(tempfile.mkdtemp(prefix='qrfr-'))
    rows, slides = [], []
    for i, codes in enumerate(deck):
        im, versions = render_slide(i, codes, rng)
        slides.append(im)
        if not codes:
            rows.append((i + 1, 'none', '', '', ''))
        for (kind, pct, pos, url), ver in zip(codes, versions):
            rows.append((i + 1, kind, pct, pos, url))
    with open(a.plan, 'w', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['slide', 'urlKind', 'sizePct', 'position', 'url'])
        w.writerows(rows)
    jobs, truth, starts = [], [], []
    for cond, c in CONDITIONS.items():
        d = out / cond
        d.mkdir(parents=True, exist_ok=True)
        base = chrome_base(c['chat'], random.Random(a.seed + 1))
        rect = share_rect(c['chat'])
        (out / f'rect-{cond}.txt').write_text(','.join(map(str, rect)))
        for i, im in enumerate(slides):
            for k in range(FRAMES_PER_SLIDE):
                sec = START_SEC + i * SLIDE_SECONDS + k * FRAME_STEP
                name = f'{sec // 3600:02d}{sec // 60 % 60:02d}{sec % 60:02d}.png'
                jobs.append((cond, i, k, im, base, rect, d / name, rng.getrandbits(32), tmp))
                truth.append((cond, name, sec - START_SEC, i + 1))
    with ThreadPoolExecutor(a.jobs) as ex:
        crfs = list(ex.map(render_frame, jobs))
    with open(out / 'frames.csv', 'w', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['cond', 'frame', 'tSec', 'slide', 'crf'])
        for tr, crf in zip(truth, crfs):
            w.writerow([*tr, f'{crf:.1f}'])
    with open(out / 'slide-starts.csv', 'w', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['slide', 'start'])
        for i in range(len(slides)):
            sec = START_SEC + i * SLIDE_SECONDS
            w.writerow([i + 1, f'{sec // 3600:02d}:{sec // 60 % 60:02d}:{sec % 60:02d}'])
    print('frames', len(jobs), 'rects', {c: (out / f'rect-{c}.txt').read_text() for c in CONDITIONS})


if __name__ == '__main__':
    main()
