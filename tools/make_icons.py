#!/usr/bin/env python3
"""Generate Lumen's toolbar icons.

The mark is the classic contrast disc: an amber ring with the right half filled,
which reads at 16px and doubles as the "half the luminance is flipped" idea.
"""
import math
import struct
import zlib
from pathlib import Path

AMBER = (255, 180, 84)
SS = 4  # supersampling factor


def sample(px, py, size):
    """Coverage-antialiased RGBA sample at pixel (px, py)."""
    r_sum = g_sum = b_sum = a_sum = 0.0
    center = size / 2.0
    radius = size * 0.44
    stroke = max(1.0, size * 0.13)

    for sy in range(SS):
        for sx in range(SS):
            x = px + (sx + 0.5) / SS - center
            y = py + (sy + 0.5) / SS - center
            d = math.hypot(x, y)
            if d > radius:
                continue
            if d > radius - stroke or x >= 0:
                r_sum += AMBER[0]
                g_sum += AMBER[1]
                b_sum += AMBER[2]
                a_sum += 255.0

    n = SS * SS
    if a_sum == 0:
        return (0, 0, 0, 0)
    weight = a_sum / 255.0
    return (
        int(r_sum / weight),
        int(g_sum / weight),
        int(b_sum / weight),
        int(a_sum / n),
    )


def chunk(tag, data):
    out = struct.pack(">I", len(data)) + tag + data
    return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            raw.extend(sample(x, y, size))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    return len(png)


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        n = write_png(out / f"icon{size}.png", size)
        print(f"icon{size}.png  {n} bytes")
