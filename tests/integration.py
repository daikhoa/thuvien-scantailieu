"""Independent encoded-image and PDF contract tests. Test-only Pillow/pypdf/PDFium."""
import ctypes as C
import io
import json
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps, ImageDraw
from pypdf import PdfReader
import pypdfium2 as pdfium
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples"))
from docscan import Library, DocscanError, Bytes, Info
LIBRARY = Path(sys.argv.pop(1)).resolve()

class Integration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lib = Library(LIBRARY)
        cls.image = Image.new("RGB", (320, 240), (240, 225, 210))
        draw = ImageDraw.Draw(cls.image)
        draw.rectangle((0, 0, 100, 90), fill=(220, 30, 20))
        draw.rectangle((210, 130, 319, 239), fill=(20, 60, 230))
        draw.text((110, 105), "Document 123", fill=(20, 20, 20))
    def encoded(self, image=None, format="PNG", **kwargs):
        out = io.BytesIO()
        (image or self.image).save(out, format, **kwargs)
        return out.getvalue()
    def original(self):
        return self.lib.options(filter=0, crop_mode=1)
    def test_binding_checks_abi_before_writing_structures(self):
        fake = SimpleNamespace(ds_abi_version=lambda:2)
        with patch("docscan.C.CDLL",return_value=fake):
            with self.assertRaisesRegex(RuntimeError,"ABI"):
                Library(LIBRARY)
    def test_default_filter_is_enhanced_but_can_be_overridden(self):
        defaults = self.lib.options()
        self.assertEqual(defaults.filter, 2)
        with self.lib.document(self.lib.config()) as doc:
            defaults.crop_mode = 1
            first = doc.add(self.encoded(), defaults)
            explicit = self.lib.options(filter=2, crop_mode=1)
            second = doc.add(self.encoded(), explicit)
            self.assertEqual(doc.page(first)[1], doc.page(second)[1])
            self.assertEqual(self.lib.options(filter=1).filter, 1)
            self.assertEqual(self.lib.options(filter=0).filter, 0)
    def test_formats_alpha_and_filters(self):
        for format in ("PNG", "JPEG", "WEBP"):
            with self.subTest(format=format), self.lib.document(self.lib.config()) as doc:
                for mode in range(5):
                    options = self.original()
                    options.filter = mode
                    index = doc.add(self.encoded(format=format), options)
                    info, jpeg = doc.page(index)
                    self.assertEqual((info.width, info.height), (320, 240))
                    out = np.array(Image.open(io.BytesIO(jpeg)))
                    if mode >= 3:
                        self.assertLessEqual(int(np.abs(out[:,:,0].astype(int)-out[:,:,1]).max()), 1)
                    if mode == 4:
                        self.assertGreater(float(((out[:,:,0]<10)|(out[:,:,0]>245)).mean()), .99)
        transparent = Image.new("RGBA", (64, 64), (0,0,0,0))
        with self.lib.document(self.lib.config()) as doc:
            info, jpeg = doc.page(doc.add(self.encoded(transparent), self.original()))
            self.assertEqual(Image.open(io.BytesIO(jpeg)).getpixel((20,20)), (255,255,255))
    def test_low_bit_depth_png_documents(self):
        for mode, bits in (("1",1),("P",1),("P",2),("P",4),("L",8)):
            image = self.image.convert(mode)
            with self.subTest(mode=mode,bits=bits), self.lib.document(self.lib.config()) as doc:
                info, jpeg = doc.page(doc.add(self.encoded(image, bits=bits), self.original()))
                self.assertEqual((info.width,info.height),(320,240))
                self.assertTrue(jpeg)
    def test_png_16bit_sdr_conversion(self):
        pixels = np.tile(np.arange(0,65536,1024,dtype=np.uint16), (64,1))
        image = Image.fromarray(pixels)
        with self.lib.document(self.lib.config()) as doc:
            info, jpeg = doc.page(doc.add(self.encoded(image), self.original()))
            result = np.array(Image.open(io.BytesIO(jpeg)))[:,:,0]
            self.assertLess(float(np.abs(result.astype(float)-pixels/257).mean()), 1)
    def test_phone_exif_orientation(self):
        for orientation in range(1, 9):
            exif = Image.Exif()
            exif[274] = orientation
            source = self.encoded(format="JPEG", quality=100, subsampling=0, exif=exif)
            expected = np.array(ImageOps.exif_transpose(Image.open(io.BytesIO(source))))
            with self.subTest(orientation=orientation), self.lib.document(self.lib.config()) as doc:
                info, jpeg = doc.page(doc.add(source, self.original()))
                actual = np.array(Image.open(io.BytesIO(jpeg)))
                self.assertEqual((info.source_width, info.source_height), (expected.shape[1], expected.shape[0]))
                self.assertEqual(actual.shape, expected.shape)
                self.assertLess(float(np.abs(actual.astype(float)-expected).mean()), 1.5)
    def test_pdf_order_bytes_geometry_and_lifetime(self):
        doc = self.lib.document(self.lib.config())
        options = self.original()
        doc.add(self.encoded(), options)
        first_info, first = doc.page(0)
        options.rotation = 90
        doc.add(self.encoded(), options)
        second_info, second = doc.page(1)
        self.assertEqual(doc.page(0)[1], first)
        pdf = doc.pdf()
        doc.close()
        reader = PdfReader(io.BytesIO(pdf), strict=True)
        self.assertEqual(len(reader.pages), 2)
        for page, info, expected in zip(reader.pages, (first_info,second_info), (first,second)):
            image = page["/Resources"]["/XObject"]["/Im0"].get_object()
            self.assertEqual(image._data, expected)
            self.assertAlmostEqual(float(page.mediabox.width), info.width*72/300, places=6)
        with pdfium.PdfDocument(pdf) as rendered:
            self.assertEqual(len(rendered), 2)
            for i, info in enumerate((first_info,second_info)):
                page = rendered[i]
                bitmap = page.render(scale=300/72)
                actual = bitmap.to_pil()
                self.assertLessEqual(abs(actual.width-info.width), 1)
                bitmap.close()
                page.close()
    def test_pdf_includes_overhead_in_limit(self):
        with self.lib.document(self.lib.config()) as doc:
            doc.add(self.encoded(), self.original())
            jpeg_size = len(doc.page(0)[1])
        config = self.lib.config()
        config.max_document_bytes = jpeg_size + 1
        with self.lib.document(config) as doc:
            doc.add(self.encoded(), self.original())
            with self.assertRaises(DocscanError) as error:
                doc.pdf()
            self.assertEqual(error.exception.status, 3)
    def test_limits_fail_atomically_and_can_reuse(self):
        config = self.lib.config()
        config.max_pages = 1
        with self.lib.document(config) as doc:
            options = self.original()
            options.crop_mode = 2
            options.corners[:] = [0,0, 1,1, 1,0, 0,1]
            with self.assertRaises(DocscanError):
                doc.add(self.encoded(), options)
            self.assertEqual(self.lib.api.ds_document_page_count(doc.handle), 0)
            doc.add(self.encoded(), self.original())
            with self.assertRaises(DocscanError) as error:
                doc.add(self.encoded(), self.original())
            self.assertEqual(error.exception.status, 3)
            self.lib.api.ds_document_cancel(doc.handle)
            with self.assertRaises(DocscanError) as error:
                doc.pdf()
            self.assertEqual(error.exception.status, 6)
            self.lib.check(self.lib.api.ds_document_reset_cancel(doc.handle))
            self.assertTrue(doc.pdf().startswith(b"%PDF-"))
        for field, limit in (("max_input_bytes",10), ("max_input_pixels",100), ("working_memory_bytes",1048576)):
            config = self.lib.config()
            setattr(config, field, limit)
            with self.subTest(field=field), self.lib.document(config) as doc:
                with self.assertRaises(DocscanError) as error:
                    doc.add(self.encoded(), self.original())
                self.assertEqual(error.exception.status, 3)
    def test_detect_document_and_keep_no_document_full_frame(self):
        files = sorted((ROOT/"tests/fixtures/synthetic").glob("*.png"))
        files += sorted((ROOT/"tests/fixtures/smartdoc15/development/images").glob("*.png"))
        files += sorted((ROOT/"tests/fixtures/smartdoc15/holdout/images").glob("*.png"))
        self.assertEqual(len(files),19)
        with self.lib.engine(self.lib.config(ROOT/"models")) as engine:
            for path in files:
                with self.subTest(image=path.name), engine.document() as doc:
                    info, _ = doc.page(doc.add(path.read_bytes(),self.lib.options(filter=1)))
                    expected = not path.name.startswith("no-document")
                    self.assertEqual(bool(info.document_detected),expected)
                    self.assertFalse(info.warnings & 32)
                    if not expected:
                        self.assertTrue(info.warnings & 1)
                        self.assertEqual(list(info.corners),[0,0,1,0,1,1,0,1])
    def test_model_crop_covers_labeled_document(self):
        with self.lib.engine(self.lib.config(ROOT/"models")) as engine:
            for split in ("development","holdout"):
                root = ROOT/"tests/fixtures/smartdoc15"/split
                manifest = json.loads((root/"manifest.json").read_text())
                for fixture in manifest["fixtures"]:
                    with self.subTest(image=fixture["id"]), engine.document() as doc:
                        options = self.original()
                        options.crop_mode = 0
                        info, _ = doc.page(doc.add((root/fixture["image"]["path"]).read_bytes(),options))
                        self.assertTrue(info.document_detected)
                        size = (info.source_width,info.source_height)
                        predicted = Image.new("1",size)
                        truth = Image.new("1",size)
                        points = [(info.corners[i]*size[0],info.corners[i+1]*size[1]) for i in range(0,8,2)]
                        ImageDraw.Draw(predicted).polygon(points,fill=1)
                        ImageDraw.Draw(truth).polygon([(p["x"],p["y"]) for p in fixture["label"]["corners"]],fill=1)
                        a,b = np.asarray(predicted), np.asarray(truth)
                        iou = float(np.logical_and(a,b).sum()/np.logical_or(a,b).sum())
                        self.assertGreater(iou,.70)
    def test_borrowed_page_and_owned_pdf_lifetimes(self):
        doc = self.lib.document(self.lib.config())
        doc.add(self.encoded(),self.original())
        pointer = C.POINTER(Info)()
        borrowed = Bytes()
        self.lib.check(self.lib.api.ds_document_get_page(doc.handle,0,C.byref(pointer),C.byref(borrowed)))
        address, data = C.addressof(pointer.contents), C.string_at(borrowed.data,borrowed.size)
        for i in range(24):
            doc.add(self.encoded(),self.original())
        again = C.POINTER(Info)()
        jpeg = Bytes()
        self.lib.check(self.lib.api.ds_document_get_page(doc.handle,0,C.byref(again),C.byref(jpeg)))
        self.assertEqual(C.addressof(again.contents),address)
        self.assertEqual(C.string_at(borrowed.data,borrowed.size),data)
        owned = C.c_void_p()
        self.lib.check(self.lib.api.ds_document_pdf(doc.handle,C.byref(owned)))
        doc.close()
        try:
            pdf = Bytes()
            self.lib.check(self.lib.api.ds_buffer_bytes(owned,C.byref(pdf)))
            self.assertEqual(len(PdfReader(io.BytesIO(C.string_at(pdf.data,pdf.size))).pages),25)
        finally:
            self.lib.api.ds_buffer_destroy(owned)
    def test_input_above_64_mib_and_large_resolution(self):
        encoded = self.encoded(format="JPEG")
        encoded += bytes(64*1024*1024+1-len(encoded))
        with self.lib.document(self.lib.config()) as doc:
            doc.add(encoded,self.original())
            self.assertEqual(doc.page(0)[0].width,320)
        del encoded
        high = Image.new("RGB",(8000,6000),(240,235,225))
        source = self.encoded(high,format="JPEG",quality=98)
        options = self.original()
        options.maximum_output_side = 4096
        with self.lib.document(self.lib.config()) as doc:
            info, _ = doc.page(doc.add(source,options))
            self.assertEqual((info.source_width,info.source_height),(8000,6000))
            self.assertEqual((info.width,info.height),(4096,3072))
    def test_malformed_input_is_atomic(self):
        source = self.encoded()
        cases = [source[:n] for n in (1,7,16,24,33,60)]
        cases += [b"RIFF"+bytes(4)+b"WEBPVP8X"+bytes(20),b"\xff\xd8\xff\xe1\xff\xff"]
        with self.lib.document(self.lib.config()) as doc:
            for data in cases:
                with self.assertRaises(DocscanError):
                    doc.add(data,self.original())
                self.assertEqual(self.lib.api.ds_document_page_count(doc.handle),0)
            doc.add(source,self.original())
    def test_native_models_load_and_run(self):
        with self.lib.document(self.lib.config(ROOT / "models")) as doc:
            options = self.lib.options(filter=1)
            index = doc.add(self.encoded(), options)
            info, jpeg = doc.page(index)
            self.assertGreaterEqual(info.confidence, 0)
            self.assertLessEqual(info.confidence, 1)
            self.assertFalse(info.warnings & 32, "Classifier must actually run")
            self.assertTrue(jpeg)

if __name__ == "__main__":
    unittest.main(verbosity=2)
