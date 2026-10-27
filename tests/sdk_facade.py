import io
import sys
import unittest
from pathlib import Path
from PIL import Image, ImageDraw
from pypdf import PdfReader

sys.path.insert(0, str(Path(sys.argv[1]) / 'share/docscan/examples'))
from docscan_sdk import Scanner
from docscan import DocscanError

PACKAGE = sys.argv.pop(1)


class FacadeContract(unittest.TestCase):
    def test_process_and_pdf_in_process(self):
        image = Image.new('RGB', (500, 700), 'white')
        draw = ImageDraw.Draw(image)
        for y in range(50, 650, 30):
            draw.text((30, y), 'Docscan native SDK contract 123456789', fill='black')
        encoded = io.BytesIO()
        image.save(encoded, format='JPEG')
        with Scanner(PACKAGE) as scanner:
            page = scanner.process(encoded.getvalue())
            self.assertTrue(page.image.startswith(b'\xff\xd8'))
            self.assertGreater(page.width, 0)
            self.assertGreater(page.height, 0)
            self.assertEqual(len(page.corners), 8)
            pdf = scanner.process_pdf([encoded.getvalue(), encoded.getvalue()])
            self.assertEqual(len(PdfReader(io.BytesIO(pdf)).pages), 2)
            with self.assertRaises(ValueError):
                scanner.process_pdf([])
            with self.assertRaises(DocscanError):
                scanner.process(b'not an image')
            self.assertGreater(scanner.process(encoded.getvalue()).width, 0)
        scanner.close()
        with self.assertRaises(ValueError):
            scanner.process(encoded.getvalue())


if __name__ == '__main__':
    unittest.main()
