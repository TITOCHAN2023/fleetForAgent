from pathlib import Path
import shutil
import base64

root = Path(__file__).resolve().parents[1]
brand = root / "docs" / "media" / "brand"
pub = root / "public"
wpub = root / "packages" / "fleet-worker" / "public"
ui = root / "packages" / "fleet-agent" / "ui"

shutil.copy(brand / "favicon.ico", pub / "favicon.ico")
shutil.copy(brand / "favicon.ico", wpub / "favicon.ico")
shutil.copy(brand / "logo-32.png", pub / "favicon-32.png")
shutil.copy(brand / "logo-32.png", wpub / "favicon-32.png")
shutil.copy(brand / "logo-180.png", pub / "apple-touch-icon.png")
shutil.copy(brand / "logo-180.png", wpub / "apple-touch-icon.png")
shutil.copy(brand / "logo-192.png", pub / "logo.png")
shutil.copy(brand / "logo-192.png", wpub / "logo.png")
shutil.copy(brand / "logo-512.png", pub / "icon-512.png")
shutil.copy(brand / "logo-512.png", wpub / "icon-512.png")
shutil.copy(brand / "logo-64.png", ui / "logo.png")
shutil.copy(brand / "logo-32.png", ui / "tray.png")
shutil.copy(brand / "favicon.ico", ui / "tray.ico")

b64 = base64.b64encode((brand / "logo-64.png").read_bytes()).decode("ascii")
(brand / "logo-64.b64.txt").write_text(b64, encoding="utf-8")
svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
    f'  <image href="data:image/png;base64,{b64}" width="64" height="64"/>\n'
    "</svg>\n"
)
(pub / "favicon.svg").write_text(svg, encoding="utf-8")
(wpub / "favicon.svg").write_text(svg, encoding="utf-8")

import struct

def write_icns(path: Path) -> None:
    chunks = []
    mapping = {128: b"ic07", 256: b"ic08", 512: b"ic09", 1024: b"ic10"}
    for size, ostype in mapping.items():
        data = (brand / f"logo-{size}.png").read_bytes()
        chunks.append(ostype + struct.pack(">I", 8 + len(data)) + data)
    payload = b"".join(chunks)
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(payload)) + payload)

write_icns(brand / "AppIcon.icns")
shutil.copy(brand / "AppIcon.icns", ui / "AppIcon.icns")
print("copied, b64", len(b64), "icns", (brand / "AppIcon.icns").stat().st_size)
