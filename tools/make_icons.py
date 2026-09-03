"""Generate TabTV icons: a gold-bezel TV screen with a teal glow."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(OUT, exist_ok=True)

def make(size):
    s = size * 8  # supersample
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = s * 0.06
    r = s * 0.18
    d.rounded_rectangle([pad, pad * 1.6, s - pad, s - pad * 1.6], radius=r, fill=(242, 193, 78, 255))
    inner = s * 0.16
    d.rounded_rectangle([inner, inner * 1.15, s - inner, s - inner * 1.15], radius=r * 0.6, fill=(6, 40, 52, 255))
    # glow band across the screen
    d.rounded_rectangle([inner * 1.25, inner * 1.5, s - inner * 1.25, s * 0.5], radius=r * 0.4, fill=(28, 120, 140, 255))
    # cursor box, yellow
    cw = s * 0.34
    cx0 = s / 2 - cw / 2
    cy0 = s * 0.52
    d.rounded_rectangle([cx0, cy0, cx0 + cw, cy0 + s * 0.2], radius=r * 0.3, outline=(255, 226, 122, 255), width=int(s * 0.045))
    im = im.resize((size, size), Image.LANCZOS)
    im.save(os.path.join(OUT, f'icon{size}.png'))

for n in (16, 48, 128):
    make(n)
print('icons written')
