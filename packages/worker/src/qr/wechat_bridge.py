#!/usr/bin/env python3
"""Long-lived OpenCV WeChat QR decoder for the worker (src/qr/wechat.ts starts it once and talks to it).

Protocol: newline-delimited JSON. On stdout the bridge first writes {"ready": true} once the models are loaded,
then one line per request: {"id": n, "texts": [...]} or {"id": n, "error": "..."}.
On stdin each line is {"id": n, "png": "<base64 PNG>"}. End of input ends the process.
Models are read from the directory in TM_WECHAT_MODELS_DIR (detect.* and sr.* prototxt and caffemodel files).
A missing variable or model file ends the process with a traceback on stderr: the caller treats that as a failure.
"""
import base64
import json
import os
import sys

import cv2
import numpy as np

cv2.setNumThreads(1)


def make_detector(models):
    path = lambda name: os.path.join(models, name)
    return cv2.wechat_qrcode_WeChatQRCode(
        path('detect.prototxt'), path('detect.caffemodel'), path('sr.prototxt'), path('sr.caffemodel')
    )


def decode(det, png):
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('not a decodable image')
    texts, _ = det.detectAndDecode(img)
    return [t for t in texts if t]


def reply(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def main():
    det = make_detector(os.environ['TM_WECHAT_MODELS_DIR'])
    reply({'ready': True})
    for line in sys.stdin.buffer:
        if not line.strip():
            continue
        req = json.loads(line)
        try:
            reply({'id': req['id'], 'texts': decode(det, base64.b64decode(req['png']))})
        except Exception as e:  # reported to the caller, which decides; the bridge keeps serving
            reply({'id': req.get('id'), 'error': f'{type(e).__name__}: {e}'})


if __name__ == '__main__':
    main()
