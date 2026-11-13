#!/usr/bin/env python3
"""Scan transfer frames from a webcam and save them for qr-decode.

For machines where the browser page (receiver.html) cannot use the camera, such as Tails.

    python3 tools/qr_scan.py [--device 0] [--out-dir .] [--timeout SECONDS] [--preview] [--clipboard]

It reads QR codes from the camera, keeps only text that matches the exact frame format written by
qr-send, locks onto the first transfer it sees, and stops when every frame has arrived. It then writes
received-<kind>-<session>.mqr (one frame per line) and checks the SHA-256. Run
`node dist/qr-decode.js <that file> <output file>` afterwards, which does the final, authoritative check.

With --clipboard it also puts the frames on the clipboard (after the checksum passes), so they can be pasted
into a page that accepts MQR1 text. It uses wl-copy, xclip or xsel if one is installed, otherwise tkinter.

The script does no other parsing of what it reads. The only complex parser involved is OpenCV's QR
decoder, which handles images from the camera; see the README before using it on a machine that holds keys.
"""
import argparse
import base64
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time

FRAME_RE = re.compile(
    r"MQR1:([a-z]{1,12}):([0-9a-f]{6}):([0-9]{1,4}):([0-9]{1,4}):([0-9a-f]{32}):([A-Za-z0-9_-]+)"
)
MAX_FRAMES = 9999  # the frame format stores index and total in at most 4 digits
MAX_TEXT = 4000  # longer text is never a valid frame; do not even run the pattern on it


def parse_frame(text):
    """Return a dict for a valid frame, otherwise None. Mirrors parseFrame in src/mqr.ts."""
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        return None
    raw = text.strip()
    m = FRAME_RE.fullmatch(raw)
    if not m:
        return None
    index, total = int(m.group(3)), int(m.group(4))
    if total < 1 or total > MAX_FRAMES or index < 1 or index > total:
        return None
    return {
        "kind": m.group(1),
        "session": m.group(2),
        "index": index,
        "total": total,
        "hash": m.group(5),
        "data": m.group(6),
        "raw": raw,
    }


class Collector:
    """Gathers the frames of one transfer, in any order, and ignores repeats."""

    def __init__(self):
        self.kind = self.session = self.total = self.hash = None
        self.frames = {}

    def add(self, text):
        """Returns 'ignored', 'other-transfer', 'conflict', 'duplicate' or 'new'."""
        f = parse_frame(text)
        if f is None:
            return "ignored"
        if self.session is None:
            self.kind, self.session, self.total, self.hash = f["kind"], f["session"], f["total"], f["hash"]
        elif (f["session"], f["kind"], f["total"], f["hash"]) != (self.session, self.kind, self.total, self.hash):
            return "other-transfer"
        seen = self.frames.get(f["index"])
        if seen is not None:
            return "duplicate" if seen == f["raw"] else "conflict"
        self.frames[f["index"]] = f["raw"]
        return "new"

    def complete(self):
        return self.total is not None and len(self.frames) == self.total

    def missing(self):
        if self.total is None:
            return []
        return [i for i in range(1, self.total + 1) if i not in self.frames]

    def lines(self):
        return [self.frames[i] for i in range(1, self.total + 1)]

    def checksum_ok(self):
        text = "".join(parse_frame(line)["data"] for line in self.lines())
        compressed = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
        return hashlib.sha256(compressed).hexdigest()[:32] == self.hash


def camera_texts(device, preview):
    """Yield the decoded text of each camera frame (or None when no code was read). Needs OpenCV."""
    try:
        import cv2
    except ImportError:
        sys.exit(
            "OpenCV (cv2) could not be imported. Extract the wheels into a folder and run with "
            "PYTHONPATH pointing at it (see README section 7b)."
        )

    detector = cv2.QRCodeDetectorAruco() if hasattr(cv2, "QRCodeDetectorAruco") else cv2.QRCodeDetector()
    source = int(device) if device.isdigit() else device
    cap = cv2.VideoCapture(source, cv2.CAP_V4L2)
    if not cap.isOpened():
        sys.exit(
            "Could not open the camera %r. Check `ls -l /dev/video*` and that your user may read it." % device
        )
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    show = preview
    try:
        for _ in range(5):  # let the exposure settle
            cap.read()
        while True:
            ok, frame = cap.read()
            if not ok:
                time.sleep(0.05)
                yield None
                continue
            if show:
                try:
                    cv2.imshow("QR scan (press q to quit)", frame)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        return
                except cv2.error:
                    print("This OpenCV build has no window support; continuing without a preview.")
                    show = False
            try:
                text, _points, _straight = detector.detectAndDecode(frame)
            except cv2.error:
                text = ""
            yield text or None
    finally:
        cap.release()


def scan(texts, collector, timeout=None, out=print, clock=time.monotonic):
    """Feed texts to the collector until it is complete. Returns True on success."""
    started = clock()
    last_hint = started
    warned = set()
    for text in texts:
        now = clock()
        if timeout is not None and now - started > timeout:
            return False
        if text is None:
            if now - last_hint > 3:
                out("No QR code readable yet. Hold the sending screen steady, fill the view, raise its brightness.")
                last_hint = now
            continue
        last_hint = now
        status = collector.add(text)
        if status == "new":
            out("Received %d of %d frames." % (len(collector.frames), collector.total))
        elif status == "ignored":
            key = hash(text)
            if key not in warned:
                warned.add(key)
                out("A QR code was read, but it is not a transfer frame. Ignored.")
        elif status == "other-transfer":
            if "other" not in warned:
                warned.add("other")
                out("A frame from a different transfer was seen and ignored. Restart this script to switch.")
        elif status == "conflict":
            out("A frame was seen twice with different contents. Keeping the first one.")
        if collector.complete():
            return True
    return collector.complete()


def write_frames(collector, out_dir):
    name = "received-%s-%s.mqr" % (collector.kind, collector.session)
    path = os.path.join(out_dir, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write("\n".join(collector.lines()) + "\n")
    return path


# Clipboard tools, tried in order. Each reads the text on stdin and keeps serving the clipboard after we exit.
CLIPBOARD_TOOLS = [
    ("wl-copy", ["wl-copy"], "WAYLAND_DISPLAY"),
    ("xclip", ["xclip", "-selection", "clipboard", "-in"], "DISPLAY"),
    ("xsel", ["xsel", "--clipboard", "--input"], "DISPLAY"),
]


def tk_clipboard(text, out=print):
    """Hold the text on the clipboard with tkinter until the user closes its small window.

    X11 and Wayland clipboards are served by the program that owns them: when this process exits, the text is
    gone. So keep a window open and the Tk event loop running until the user has pasted."""
    import tkinter

    root = tkinter.Tk()
    root.title("QR scan: clipboard")
    root.clipboard_clear()
    root.clipboard_append(text)
    tkinter.Label(root, text="The frames are on the clipboard.\nPaste them into the page, then click Done.",
                  padx=16, pady=12).pack()
    tkinter.Button(root, text="Done", command=root.destroy).pack(pady=(0, 12))
    out("The frames are on the clipboard. Paste them into the page, then click Done in the small window.")
    root.mainloop()


def copy_to_clipboard(text, out=print, which=shutil.which, run=subprocess.run, env=os.environ, tk=tk_clipboard):
    """Put text on the clipboard. Returns the method used, or None if nothing worked."""
    data = text.encode("ascii")  # frames are ASCII by construction
    for name, argv, display_var in CLIPBOARD_TOOLS:
        if not env.get(display_var) or not which(argv[0]):
            continue
        try:
            run(argv, input=data, check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return name
        except (OSError, subprocess.SubprocessError):
            continue
    if not (env.get("DISPLAY") or env.get("WAYLAND_DISPLAY")):
        return None
    try:
        tk(text, out)
        return "tkinter"
    except Exception:  # tkinter missing, or no display it can open
        return None


def main(argv=None, opener=camera_texts, copier=copy_to_clipboard):
    parser = argparse.ArgumentParser(description="Scan transfer frames from a webcam.")
    parser.add_argument("--device", default="0", help="camera index or path, e.g. 0 or /dev/video0 (default 0)")
    parser.add_argument("--out-dir", default=".", help="where to write the received file (default: current folder)")
    parser.add_argument("--timeout", type=float, default=None, help="give up after this many seconds")
    parser.add_argument("--preview", action="store_true", help="show the camera image, if this OpenCV build can")
    parser.add_argument("--clipboard", action="store_true",
                        help="also put the frames on the clipboard, to paste into a page (after the checksum passes)")
    args = parser.parse_args(argv)

    if not os.path.isdir(args.out_dir):
        sys.exit("The output folder %r does not exist." % args.out_dir)

    collector = Collector()
    print("Scanning. Point the camera at the sending screen. Press Ctrl+C to stop.")
    try:
        finished = scan(opener(args.device, args.preview), collector, args.timeout)
    except KeyboardInterrupt:
        finished = False

    if not finished:
        if collector.total is None:
            print("Nothing was received.")
        else:
            miss = collector.missing()
            shown = ", ".join(str(i) for i in miss[:30]) + (", ..." if len(miss) > 30 else "")
            print("Stopped with %d of %d frames. Missing: %s" % (len(collector.frames), collector.total, shown))
        return 2

    ok = collector.checksum_ok()
    path = write_frames(collector, args.out_dir)
    print("All %d frames received (kind=%s, session=%s)." % (collector.total, collector.kind, collector.session))
    print("Checksum: %s" % ("OK" if ok else "MISMATCH, scan again"))
    print("Wrote %s" % path)
    if not ok:
        return 3
    if args.clipboard:
        method = copier("\n".join(collector.lines()) + "\n")
        if method:
            if method != "tkinter":
                print("Copied the frames to the clipboard (%s). Paste them into the page." % method)
        else:
            print("Could not use the clipboard (no wl-copy, xclip, xsel or tkinter with a display). "
                  "Load %s in the page instead." % path)
    print("Next: node dist/qr-decode.js %s <output file>" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
