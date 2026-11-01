#!/usr/bin/env python3
"""Regenerates every Universe app icon from one set of glyph definitions (black + orange).

Writes, per app:
  web      <app>/icons/icon.svg, icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png
  android  android/app/src/<flavor>/res/drawable/ic_glyph.xml          (24dp line glyph: widgets + notifications)
           android/app/src/<flavor>/res/drawable/ic_launcher_fg.xml    (adaptive icon foreground, also the themed/monochrome layer)
           android/app/src/<flavor>/res/mipmap-anydpi-v26/ic_launcher.xml
           android/app/src/<flavor>/res/mipmap-xxxhdpi/ic_launcher.png (pre-Android-8 fallback)

Run from the repo root:  python3 scripts/make-icons.py      (needs Pillow: pip install pillow)
"""
import math, os
from PIL import Image, ImageDraw, ImageOps

ORANGE = (255, 107, 26)
HEX = '#FF6B1A'
BG = (10, 10, 10)
SW = 1.8  # stroke width on the 24-unit grid

# Primitives on a 24x24 grid. Modes: S = stroke, D = dim stroke, F = fill, f = dim fill.
def poly(pts, closed=False, mode='S'): return ('poly', pts, closed, mode)
def circle(cx, cy, r, mode='F'): return ('ellipse', cx, cy, r, r, 0, mode)
def ellipse(cx, cy, rx, ry, rot, mode='D'): return ('ellipse', cx, cy, rx, ry, rot, mode)
def rrect(x, y, w, h, r, mode='S'): return ('rrect', x, y, w, h, r, mode)

GLYPHS = {
    # Jupiter: music. A note orbiting like a planet ring.
    'jupiter': [ellipse(12, 12, 10.5, 3.6, -20, 'D'),
                poly([(10, 17), (10, 6.2), (18.5, 4.5), (18.5, 15)], False, 'S'),
                circle(7.8, 17.2, 2.7), circle(16.3, 15.2, 2.7)],
    # Inventory: a box.
    'inventory': [poly([(3.5, 7.2), (12, 12), (20.5, 7.2), (12, 2.5)], True, 'f'),
                  poly([(12, 2.5), (20.5, 7.2), (20.5, 16.8), (12, 21.5), (3.5, 16.8), (3.5, 7.2)], True, 'S'),
                  poly([(3.5, 7.2), (12, 12), (20.5, 7.2)], False, 'S'),
                  poly([(12, 12), (12, 21.5)], False, 'S'),
                  poly([(7.6, 4.9), (16.2, 9.7)], False, 'D')],
    # Nova: tasks and projects. A completed circle with a spark.
    'nova': [circle(10.5, 13.5, 7.5, 'f'), ellipse(10.5, 13.5, 7.5, 7.5, 0, 'S'),
             poly([(7.2, 13.6), (9.8, 16.2), (14.2, 11)], False, 'S'),
             poly([(19.2, 1.6), (20.3, 3.7), (22.4, 4.8), (20.3, 5.9), (19.2, 8), (18.1, 5.9), (16, 4.8), (18.1, 3.7)], True, 'F')],
    # Orbit: money. A wallet with a card peeking out.
    'finance': [rrect(3, 7, 18, 13, 3, 'f'),
                poly([(5.5, 7), (15.5, 3.6), (17.5, 7)], False, 'D'),
                rrect(3, 7, 18, 13, 3, 'S'),
                rrect(14, 12.4, 7, 4.2, 2.1, 'S'), circle(16.9, 14.5, 0.95)],
    # Pulsar: notes and pages with a pulse running through.
    'pulsar': [poly([(5, 3.5), (14.5, 3.5), (19.5, 8.5), (19.5, 20.5), (5, 20.5)], True, 'f'),
               poly([(5, 3.5), (14.5, 3.5), (19.5, 8.5), (19.5, 20.5), (5, 20.5)], True, 'S'),
               poly([(14.5, 3.5), (14.5, 8.5), (19.5, 8.5)], False, 'D'),
               poly([(2.6, 14.2), (7.4, 14.2), (9.2, 10.4), (12, 17.6), (14, 12.6), (15.2, 14.2), (21.4, 14.2)], False, 'S')],
    # Universe: a planet, its ring and a few stars.
    'dashboard': [ellipse(12, 12, 10.5, 3.6, -20, 'D'), circle(12, 12, 4.7),
                  circle(5, 5, 0.95), circle(19.6, 19.2, 1.1), circle(20.6, 5.6, 0.75), circle(3.9, 19.6, 0.75)],
}

# app key -> (web folder, android flavor)
APPS = {
    'dashboard': ('dashboard', 'dashboard'),
    'nova': ('apps/nova', 'nova'),
    'finance': ('apps/finance', 'finance'),
    'pulsar': ('apps/pulsar', 'pulsar'),
    'jupiter': ('apps/jupiter', 'jupiter'),
    'inventory': ('apps/inventory', 'inventory'),
}

def f(n): return ('%.3f' % n).rstrip('0').rstrip('.')

def sample(prim, n=120):
    """Returns (points, closed) for drawing with Pillow."""
    k = prim[0]
    if k == 'poly': return list(prim[1]), prim[2]
    if k == 'ellipse':
        _, cx, cy, rx, ry, rot, _m = prim
        t = math.radians(rot); c, s = math.cos(t), math.sin(t)
        pts = []
        for i in range(n):
            a = 2 * math.pi * i / n
            x, y = rx * math.cos(a), ry * math.sin(a)
            pts.append((cx + x * c - y * s, cy + x * s + y * c))
        return pts, True
    _, x, y, w, h, r, _m = prim
    pts = []
    for (ox, oy, a0) in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
        for i in range(0, 17):
            a = math.radians(a0 + 90 * i / 16)
            pts.append((ox + r * math.cos(a), oy + r * math.sin(a)))
    return pts, True

def path_d(prim):
    """SVG / Android pathData for a primitive."""
    k = prim[0]
    if k == 'poly':
        d = 'M' + ' L'.join('%s,%s' % (f(x), f(y)) for x, y in prim[1])
        return d + (' Z' if prim[2] else '')
    if k == 'ellipse':
        _, cx, cy, rx, ry, rot, _m = prim
        t = math.radians(rot); dx, dy = rx * math.cos(t), rx * math.sin(t)
        x1, y1, x2, y2 = cx - dx, cy - dy, cx + dx, cy + dy
        return 'M%s,%s A%s,%s %s 1 0 %s,%s A%s,%s %s 1 0 %s,%s Z' % (f(x1), f(y1), f(rx), f(ry), f(rot), f(x2), f(y2), f(rx), f(ry), f(rot), f(x1), f(y1))
    _, x, y, w, h, r, _m = prim
    return ('M%s,%s H%s A%s,%s 0 0 1 %s,%s V%s A%s,%s 0 0 1 %s,%s H%s A%s,%s 0 0 1 %s,%s V%s A%s,%s 0 0 1 %s,%s Z' % (
        f(x + r), f(y), f(x + w - r), f(r), f(r), f(x + w), f(y + r), f(y + h - r), f(r), f(r), f(x + w - r), f(y + h),
        f(x + r), f(r), f(r), f(x), f(y + h - r), f(y + r), f(r), f(r), f(x + r), f(y)))

def mode_of(prim): return prim[-1]

# ---------- Pillow rendering ----------
def draw_glyph(img, prims, ox, oy, scale, ss):
    for prim in prims:
        pts, closed = sample(prim)
        pts = [(ox + x * scale, oy + y * scale) for x, y in pts]
        mode = mode_of(prim)
        alpha = {'S': 255, 'F': 255, 'D': int(255 * .45), 'f': int(255 * .22)}[mode]
        layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        col = ORANGE + (alpha,)
        if mode in ('S', 'D'):
            w = max(1, int(round(SW * scale)))
            seq = pts + [pts[0]] if closed else pts
            d.line(seq, fill=col, width=w, joint='curve')
            r = w / 2
            for (x, y) in (pts if closed else (pts[0], pts[-1]) if len(pts) > 1 else pts):
                d.ellipse((x - r, y - r, x + r, y + r), fill=col)
            if closed or prim[0] == 'poly':
                for (x, y) in pts: d.ellipse((x - r, y - r, x + r, y + r), fill=col)
        else:
            d.polygon(pts, fill=col)
        img.alpha_composite(layer)

def render(prims, size, style):
    """style: 'rounded' (web/legacy icon), 'full' (maskable / apple-touch: no rounding), with glyph fraction."""
    ss = 4; S = size * ss
    frac = {'rounded': 0.60, 'full': 0.52}[style]
    img = Image.new('RGBA', (S, S), BG + (255,))
    glow = ImageOps.invert(Image.radial_gradient('L')).resize((S, S)).point(lambda v: int(v * 0.34))
    orange = Image.new('RGBA', (S, S), ORANGE + (255,)); orange.putalpha(glow)
    img.alpha_composite(orange)
    scale = S * frac / 24
    off = (S - 24 * scale) / 2
    draw_glyph(img, prims, off, off, scale, ss)
    if style == 'rounded':
        mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=255)
        img.putalpha(mask)
    return img.resize((size, size), Image.LANCZOS)

# ---------- SVG ----------
def svg_elems(prims):
    out = []
    for p in prims:
        m = mode_of(p); d = path_d(p)
        if m == 'S': out.append('<path d="%s"/>' % d)
        elif m == 'D': out.append('<path d="%s" stroke-opacity=".45"/>' % d)
        elif m == 'F': out.append('<path d="%s" fill="%s" stroke="none"/>' % (d, HEX))
        else: out.append('<path d="%s" fill="%s" fill-opacity=".22" stroke="none"/>' % (d, HEX))
    return ''.join(out)

def web_svg(prims):
    s = 512 * 0.60 / 24; off = (512 - 24 * s) / 2
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><radialGradient id="g" cx=".5" cy=".5" r=".62">'
            '<stop offset="0" stop-color="%s" stop-opacity=".34"/><stop offset="1" stop-color="%s" stop-opacity="0"/></radialGradient></defs>'
            '<rect width="512" height="512" rx="112" fill="#0A0A0A"/><rect width="512" height="512" rx="112" fill="url(#g)"/>'
            '<g transform="translate(%s %s) scale(%s)" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round">%s</g></svg>\n'
            % (HEX, HEX, f(off), f(off), f(s), HEX, SW, svg_elems(prims)))

# ---------- Android vector drawables ----------
def android_paths(prims, indent='    '):
    out = []
    for p in prims:
        m = mode_of(p); d = path_d(p)
        if m in ('S', 'D'):
            a = '' if m == 'S' else '\n' + indent + '    android:strokeAlpha="0.45"'
            out.append('%s<path\n%s    android:pathData="%s"\n%s    android:strokeColor="%s"\n%s    android:strokeWidth="%s"\n%s    android:strokeLineCap="round"\n%s    android:strokeLineJoin="round"%s />'
                       % (indent, indent, d, indent, HEX, indent, SW, indent, indent, a))
        else:
            a = '' if m == 'F' else '\n' + indent + '    android:fillAlpha="0.22"'
            out.append('%s<path\n%s    android:pathData="%s"\n%s    android:fillColor="%s"%s />' % (indent, indent, d, indent, HEX, a))
    return '\n'.join(out)

def glyph_xml(prims):
    return ('<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            '    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">\n%s\n</vector>\n' % android_paths(prims))

def launcher_fg_xml(prims):
    # 108dp adaptive layer; the glyph sits inside the 66dp safe zone (54dp wide, centred).
    return ('<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            '    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">\n'
            '    <group android:translateX="27" android:translateY="27" android:scaleX="2.25" android:scaleY="2.25">\n%s\n    </group>\n</vector>\n' % android_paths(prims, '        '))

ADAPTIVE = ('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@drawable/ic_launcher_bg" />\n    <foreground android:drawable="@drawable/ic_launcher_fg" />\n'
            '    <monochrome android:drawable="@drawable/ic_launcher_fg" />\n</adaptive-icon>\n')

def write(path, data, mode='w'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode) as fh: fh.write(data)

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for key, (web, flavor) in APPS.items():
        prims = GLYPHS[key]
        ic = os.path.join(root, web, 'icons')
        write(os.path.join(ic, 'icon.svg'), web_svg(prims))
        if key == 'jupiter': write(os.path.join(root, web, 'icon.svg'), web_svg(prims))
        big = render(prims, 512, 'rounded')
        big.save(os.path.join(ic, 'icon-512.png')); big.resize((192, 192), Image.LANCZOS).save(os.path.join(ic, 'icon-192.png'))
        render(prims, 512, 'full').convert('RGB').save(os.path.join(ic, 'maskable-512.png'))
        render(prims, 180, 'full').convert('RGB').save(os.path.join(ic, 'apple-touch-icon.png'))
        res = os.path.join(root, 'android/app/src', flavor, 'res')
        write(os.path.join(res, 'drawable/ic_glyph.xml'), glyph_xml(prims))
        write(os.path.join(res, 'drawable/ic_launcher_fg.xml'), launcher_fg_xml(prims))
        write(os.path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml'), ADAPTIVE)
        os.makedirs(os.path.join(res, 'mipmap-xxxhdpi'), exist_ok=True)
        render(prims, 192, 'rounded').save(os.path.join(res, 'mipmap-xxxhdpi/ic_launcher.png'))
        print('icons:', key)

if __name__ == '__main__':
    main()
