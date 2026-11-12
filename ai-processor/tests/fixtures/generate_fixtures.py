"""Generate the deterministic OCR/evaluation fixtures for the ai-processor tests.

These fixtures are tiny, synthetic, non-confidential videos with a KNOWN caption
burned in, so OCR and frame-sampling behavior can be checked deterministically
without any real media, network, or LLM call.

Reproducibility
---------------
Generation is byte-deterministic: `-fflags +bitexact -flags +bitexact` plus a
fixed input/encoding parameter set produce identical output bytes for the same
ffmpeg build. The committed `.mp4` files are the source of truth for the tests;
this script exists so they can be regenerated and reviewed.

Usage
-----
    python generate_fixtures.py [--out DIR] [--ffmpeg PATH] [--font PATH]

The font must be a TrueType file. The default search covers the ai-processor
container (`/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`) and common
Windows/Linux locations; pass `--font` if none is found.

The generated files are small (well under 100 KB) and safe to commit
(TESTING.md §33: small, non-confidential, legally usable, stable).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

# Caption text burned into each fixture. Kept short and unambiguous so OCR reads
# it reliably; the harness compares a normalised token, not exact spacing.
CAPTION_ALWAYS = "TMIPCAPTION"
CAPTION_WINDOW = "TMIPLOWERTHIRD"

FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
)


def find_font(explicit: str | None) -> str:
    if explicit:
        if not os.path.exists(explicit):
            raise SystemExit(f"--font does not exist: {explicit}")
        return explicit
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    raise SystemExit(
        "No TrueType font found. Pass --font PATH (a .ttf file)."
    )


def _drawtext(caption: str, font: str, y: str = "h-90", enable: str | None = None) -> str:
    # The font path must be single-quoted with the drive colon escaped so it is
    # safe on Windows (e.g. 'C\:/Windows/Fonts/arialbd.ttf') as well as POSIX
    # paths used inside the ai-processor container. `enable` expressions already
    # carry their own escaped commas, so it is appended verbatim.
    font_escaped = font.replace("\\", "/").replace(":", r"\:")
    parts = [
        f"fontfile='{font_escaped}'",
        f"text={caption}",
        "fontcolor=white",
        "fontsize=56",
        "x=(w-text_w)/2",
        f"y={y}",
    ]
    if enable is not None:
        parts.append(f"enable={enable}")
    return "drawtext=" + ":".join(parts)


def build(ffmpeg: str, out_dir: str, font: str) -> list[str]:
    os.makedirs(out_dir, exist_ok=True)
    written: list[str] = []

    common = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-fflags", "+bitexact", "-flags", "+bitexact",
    ]
    encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast"]

    # Fixture 1: caption visible for the whole clip (6 s, 10 fps).
    f1 = os.path.join(out_dir, "caption_always.mp4")
    subprocess.run(
        common + [
            "-f", "lavfi", "-i", "color=c=navy:s=640x360:d=6:r=10",
            "-vf", _drawtext(CAPTION_ALWAYS, font),
        ] + encode + ["-t", "6", f1],
        check=True,
    )
    written.append(f1)

    # Fixture 2: caption visible ONLY between t=4 and t=6 (10 s, 10 fps).
    # Used to check that sampling reads the caption when a sample lands inside
    # the window, and reads nothing outside it.
    f2 = os.path.join(out_dir, "caption_window.mp4")
    subprocess.run(
        common + [
            "-f", "lavfi", "-i", "color=c=navy:s=640x360:d=10:r=10",
            "-vf", _drawtext(CAPTION_WINDOW, font, enable="between(t\\,4\\,6)"),
        ] + encode + ["-t", "10", f2],
        check=True,
    )
    written.append(f2)

    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--font", default=None)
    args = parser.parse_args(argv)

    font = find_font(args.font)
    print(f"using font: {font}")
    for path in build(args.ffmpeg, args.out, font):
        size = os.path.getsize(path)
        print(f"wrote {path} ({size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
