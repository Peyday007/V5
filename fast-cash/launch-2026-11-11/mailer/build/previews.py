"""Small JPG previews of the card (for email and the rate card) and a 2-page print PDF.
Run: python3 -I build/previews.py  (from the mailer directory)"""
import os
from PIL import Image
from pypdf import PdfWriter

M = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mockup")
for side in ("front", "back"):
    im = Image.open(os.path.join(M, f"card-{side}.png")).convert("RGB")
    im.thumbnail((1600, 1600))
    im.save(os.path.join(M, f"card-{side}-preview.jpg"), quality=85)
mp = Image.open(os.path.join(M, "route-map.png")).convert("RGB")
mp.thumbnail((1400, 1400))
mp.save(os.path.join(M, "route-map-preview.jpg"), quality=85)
w = PdfWriter()
for side in ("front", "back"):
    w.append(os.path.join(M, f"card-{side}.pdf"))
w.write(os.path.join(M, "card-mockup-2-sides.pdf"))
print("previews + 2-page PDF written")
