"""Build the 1400x560 Chrome Web Store marquee tile from the guide screenshot."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

ROOT = os.path.join(os.path.dirname(__file__), '..')
W, H = 1400, 560
img = Image.new('RGB', (W, H), (4, 32, 43))
d = ImageDraw.Draw(img)
# teal glow at the top, darker at the bottom
for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)], fill=(int(8 + 6 * (1 - t)), int(60 - 40 * t), int(75 - 48 * t)))
# scanlines
for y in range(0, H, 3):
    d.line([(0, y), (W, y)], fill=(2, 20, 27))

def font(size, name='HelveticaNeue.ttc', index=1):
    for p in [f'/System/Library/Fonts/{name}', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial Bold.ttf']:
        try:
            return ImageFont.truetype(p, size, index=index)
        except Exception:
            continue
    return ImageFont.load_default()

bold = font(96)
d.text((70, 90), 'Tab', font=bold, fill=(255, 255, 255), stroke_width=3, stroke_fill=(0, 0, 0))
w = d.textlength('Tab', font=bold)
d.text((70 + w, 90), 'TV', font=bold, fill=(242, 193, 78), stroke_width=3, stroke_fill=(0, 0, 0))
tag = font(30)
d.text((74, 215), 'A channel guide for your tabs.', font=tag, fill=(246, 241, 220), stroke_width=2, stroke_fill=(0, 0, 0))
small = font(22)
lines = ['Big picture previews', 'Arrow keys, Enter, done', 'Punch in a channel number', 'Free and open source']
for i, s in enumerate(lines):
    d.rounded_rectangle([74, 290 + i * 46, 96, 312 + i * 46], radius=5, fill=(242, 193, 78), outline=(0, 0, 0), width=2)
    d.text((112, 286 + i * 46), s, font=small, fill=(246, 241, 220), stroke_width=1, stroke_fill=(0, 0, 0))

# the guide, tilted slightly, with a glow
shot = Image.open(os.path.join(ROOT, 'store', 'shot-4-pip.png')).convert('RGB')
shot = shot.resize((880, 550), Image.LANCZOS)
frame = Image.new('RGB', (shot.width + 12, shot.height + 12), (242, 193, 78))
frame.paste(shot, (6, 6))
glow = Image.new('RGBA', (frame.width + 80, frame.height + 80), (0, 0, 0, 0))
ImageDraw.Draw(glow).rounded_rectangle([30, 30, glow.width - 30, glow.height - 30], radius=18, fill=(255, 226, 122, 140))
glow = glow.filter(ImageFilter.GaussianBlur(24))
fr = frame.convert('RGBA').rotate(-3, expand=True, resample=Image.BICUBIC)
gl = glow.rotate(-3, expand=True, resample=Image.BICUBIC)
x, y = 600, 70
img.paste(gl, (x - 40, y - 40), gl)
img.paste(fr, (x, y), fr)
out = os.path.join(ROOT, 'store', 'marquee-1400x560.png')
img.save(out)
print(out)
