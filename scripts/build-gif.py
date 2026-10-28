"""Assemble hardware canvas captures; this does not synthesize sampling results.
Usage: python scripts/build-gif.py CAPTURE_DIRECTORY OUTPUT_GIF
Requires Pillow. Presentation uses selected sample counts, not real-time playback.
"""
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

directory, output = map(Path, sys.argv[1:3])
output.parent.mkdir(parents=True, exist_ok=True)
metadata = json.loads((directory / 'capture.json').read_text())
assert metadata['pass'] and metadata['requestedAdapter']['fallback'] is False
assert metadata['requestedAdapter']['vendor'].lower() in ('amd', 'nvidia', 'intel')
try:
    font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 18)
    small = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 14)
except OSError:
    font, small = ImageFont.load_default(size=18), ImageFont.load_default(size=14)
frames = []
for count in metadata['frames']:
    raw = Image.open(directory / f'frame-{count:03}.png').convert('RGB')
    assert raw.size == tuple(metadata['viewport'])
    picture = raw.resize((768, 480), Image.Resampling.LANCZOS)
    frame = Image.new('RGB', (768, 566), '#122234')
    frame.paste(picture, (0, 48))
    draw = ImageDraw.Draw(frame)
    draw.text((18, 12), 'White noise', fill='white', font=font)
    draw.text((402, 12), 'GSA', fill='#59d3ba', font=font)
    draw.text((605, 12), f'{count:3} samples', fill='white', font=font)
    draw.text((18, 538), 'Spatial blur + temporal average', fill='white', font=small)
    frames.append(frame.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
    if count == 32:
        frame.save(output.with_suffix('.png'))
frames[0].save(output, save_all=True, append_images=frames[1:], loop=0,
               duration=[450 if n <= 4 else 240 if n < 128 else 1800 for n in metadata['frames']],
               disposal=2, optimize=True)
with Image.open(output) as check:
    assert check.n_frames == len(metadata['frames'])
print(f'{output}: {output.stat().st_size:,} bytes, {len(frames)} frames')
