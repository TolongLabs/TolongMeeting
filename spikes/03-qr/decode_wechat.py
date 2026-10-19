#!/usr/bin/env python3
"""Decode stage frames with OpenCV's WeChat QR detector.

Batch: --frames <dir> --rect x,y,w,h --out <csv> [--tag name]  appends `frame,tSec,decoder,mode,ms,texts` rows.
Serve: --serve reads 4-byte big-endian length-prefixed PNGs on stdin (optionally --rect x,y,w,h for the region
pass), writes one JSON line {"texts": [...], "ms": n} per frame on stdout. Length 0 ends the loop.
"""
import argparse
import csv
import json
import os
import struct
import sys
import time

import cv2
import numpy as np

cv2.setNumThreads(1)
MODELS = os.environ.get('WECHAT_MODELS', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models'))


def make_detector():
    m = lambda n: os.path.join(MODELS, n)
    return cv2.wechat_qrcode_WeChatQRCode(m('detect.prototxt'), m('detect.caffemodel'), m('sr.prototxt'), m('sr.caffemodel'))


def decode(det, png, mode, rect):
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    if mode == 'region':
        x, y, w, h = rect
        img = cv2.resize(img[y:y + h, x:x + w], (w * 2, h * 2), interpolation=cv2.INTER_LANCZOS4)
    texts, _ = det.detectAndDecode(img)
    return [t for t in texts if t]


def serve(rect):
    det = make_detector()
    inp, out = sys.stdin.buffer, sys.stdout
    while True:
        head = inp.read(4)
        if len(head) < 4:
            return
        n = struct.unpack('>I', head)[0]
        if n == 0:
            return
        png = inp.read(n)
        t0 = time.perf_counter()
        texts = []
        for mode in ('full', 'region') if rect else ('full',):
            texts = decode(det, png, mode, rect)
            if texts:
                break
        out.write(json.dumps({'texts': texts, 'ms': round((time.perf_counter() - t0) * 1000, 1)}) + '\n')
        out.flush()


def batch(a):
    rect = [int(v) for v in a.rect.split(',')]
    det = make_detector()
    names = sorted(n for n in os.listdir(a.frames) if len(n) == 10 and n.endswith('.png') and n[:6].isdigit())
    new = not os.path.exists(a.out) or os.path.getsize(a.out) == 0
    with open(a.out, 'a', newline='') as f:
        w = csv.writer(f, lineterminator='\n', quoting=csv.QUOTE_MINIMAL)
        if new:
            f.write('frame,tSec,decoder,mode,ms,texts\n')
        with open(os.path.join(a.frames, names[0]), 'rb') as g:
            decode(det, g.read(), 'full', rect)  # warm up
        for name in names[:a.limit or len(names)]:
            with open(os.path.join(a.frames, name), 'rb') as g:
                png = g.read()
            tsec = int(name[:2]) * 3600 + int(name[2:4]) * 60 + int(name[4:6])
            frame = f'{a.tag}/{name}' if a.tag else name
            for mode in ('full', 'region'):
                t0 = time.perf_counter()
                texts = decode(det, png, mode, rect)
                ms = (time.perf_counter() - t0) * 1000
                w.writerow([frame, tsec, 'wechat', mode, f'{ms:.1f}', json.dumps(texts)])


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--frames')
    p.add_argument('--rect')
    p.add_argument('--out')
    p.add_argument('--tag', default='')
    p.add_argument('--limit', type=int, default=0)
    p.add_argument('--serve', action='store_true')
    a = p.parse_args()
    if a.serve:
        serve([int(v) for v in a.rect.split(',')] if a.rect else None)
    elif a.frames and a.rect and a.out:
        batch(a)
    else:
        p.error('need --serve, or --frames, --rect and --out')
