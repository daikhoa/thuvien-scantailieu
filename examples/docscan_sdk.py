"""High-level, in-process facade for the packaged Docscan native library."""
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from docscan import Library


@dataclass(frozen=True)
class Page:
    image: bytes
    width: int
    height: int
    warnings: int
    document_detected: bool
    corners: tuple


def _package_directory():
    for parent in Path(__file__).resolve().parents:
        for candidate in (parent, parent / "dist" / "docscan-win-x64"):
            if (candidate / "bin" / "docscan.dll").is_file():
                return candidate
    raise FileNotFoundError("Pass the extracted Docscan native package directory.")


class Scanner:
    """Own models and native engine; callers never construct inference sessions."""
    def __init__(self, package_directory=None):
        root = Path(package_directory).resolve() if package_directory else _package_directory()
        self._lock = RLock()
        self._library = Library(root / "bin" / "docscan.dll")
        self._engine = self._library.engine(self._library.config(root / "share" / "docscan" / "models"))

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.close()

    def close(self):
        with self._lock:
            self._engine.close()

    def process(self, encoded, *, filter=2, crop_mode=0):
        """Encoded image -> auto corners, perspective, selective shadow model, enhanced JPEG."""
        with self._lock, self._engine.document() as document:
            index = document.add(encoded, self._library.options(filter, crop_mode))
            info, image = document.page(index)
            return Page(image, info.width, info.height, info.warnings,
                        bool(info.document_detected), tuple(info.corners))

    def process_pdf(self, images, *, filter=2, crop_mode=0):
        """Encoded images -> complete PDF, preserving page order and natural ratios."""
        with self._lock, self._engine.document() as document:
            count = 0
            for encoded in images:
                document.add(encoded, self._library.options(filter, crop_mode))
                count += 1
            if count == 0:
                raise ValueError("At least one image is required")
            return document.pdf()
