"""Small ctypes binding: calls docscan directly in this Python process (no service)."""
import ctypes as C
import os
from pathlib import Path

class Bytes(C.Structure):
    _fields_ = [("data", C.POINTER(C.c_uint8)), ("size", C.c_uint64)]
class Config(C.Structure):
    _fields_ = [("struct_size", C.c_uint32), ("abi_version", C.c_uint32),
                ("model_directory", C.c_char_p), ("max_input_bytes", C.c_uint64),
                ("max_input_pixels", C.c_uint64), ("working_memory_bytes", C.c_uint64),
                ("max_document_bytes", C.c_uint64), ("max_pages", C.c_uint32), ("reserved", C.c_uint32)]
class Options(C.Structure):
    _fields_ = [("struct_size", C.c_uint32), ("abi_version", C.c_uint32),
                ("filter", C.c_int32), ("crop_mode", C.c_int32),
                ("maximum_output_side", C.c_uint32), ("rotation", C.c_uint32),
                ("jpeg_quality", C.c_uint32), ("analysis_side", C.c_uint32), ("corners", C.c_double * 8)]
class Info(C.Structure):
    _fields_ = [(n, C.c_uint32) for n in ("struct_size", "abi_version", "source_width", "source_height",
                 "width", "height", "warnings", "document_detected")] + [
                 ("confidence", C.c_double), ("corners", C.c_double * 8)] + [
                 (n, C.c_double) for n in ("decode_ms", "detect_ms", "analyze_ms", "warp_ms", "filter_ms", "encode_ms")]

class DocscanError(RuntimeError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)

class Library:
    def __init__(self, path):
        path = Path(path).resolve()
        self._dll_directory = os.add_dll_directory(str(path.parent)) if os.name == "nt" else None
        self.api = C.CDLL(str(path))
        self.api.ds_abi_version.argtypes = []
        self.api.ds_abi_version.restype = C.c_uint32
        if self.api.ds_abi_version() != 1:
            raise RuntimeError("Unsupported docscan ABI; this binding requires version 1")
        ptr = C.c_void_p
        declarations = {
            "ds_status_message": ([C.c_int], C.c_char_p),
            "ds_engine_config_init": ([C.POINTER(Config)], None),
            "ds_page_options_init": ([C.POINTER(Options)], None),
            "ds_engine_create": ([C.POINTER(Config), C.POINTER(ptr)], C.c_int),
            "ds_engine_destroy": ([ptr], None),
            "ds_engine_capabilities": ([ptr], C.c_uint32),
            "ds_document_create": ([ptr, C.POINTER(ptr)], C.c_int),
            "ds_document_destroy": ([ptr], None),
            "ds_document_cancel": ([ptr], None),
            "ds_document_reset_cancel": ([ptr], C.c_int),
            "ds_document_page_count": ([ptr], C.c_uint32),
            "ds_document_add_image": ([ptr, Bytes, C.POINTER(Options), C.POINTER(C.c_uint32)], C.c_int),
            "ds_document_get_page": ([ptr, C.c_uint32, C.POINTER(C.POINTER(Info)), C.POINTER(Bytes)], C.c_int),
            "ds_document_pdf": ([ptr, C.POINTER(ptr)], C.c_int),
            "ds_buffer_bytes": ([ptr, C.POINTER(Bytes)], C.c_int),
            "ds_buffer_destroy": ([ptr], None),
        }
        for name, (args, result) in declarations.items():
            function = getattr(self.api, name)
            function.argtypes, function.restype = args, result
    def check(self, status):
        if status:
            raise DocscanError(status, self.api.ds_status_message(status).decode())
    def config(self, models=None):
        config = Config()
        self.api.ds_engine_config_init(C.byref(config))
        config.model_directory = str(Path(models).resolve()).encode("utf-8") if models else None
        return config
    def options(self, filter=None, crop_mode=0):
        options = Options()
        self.api.ds_page_options_init(C.byref(options))
        if filter is not None:
            options.filter = filter
        options.crop_mode = crop_mode
        return options
    def document(self, config):
        return Document(self, config)
    def engine(self, config):
        return Engine(self, config)

class Engine:
    """Reuse this engine across documents so ML sessions load once."""
    def __init__(self, library, config):
        self.library, self.handle = library, C.c_void_p()
        library.check(library.api.ds_engine_create(C.byref(config), C.byref(self.handle)))
    def __enter__(self):
        return self
    def __exit__(self, *unused):
        self.close()
    def close(self):
        if self.handle:
            self.library.api.ds_engine_destroy(self.handle)
            self.handle = C.c_void_p()
    def document(self):
        if not self.handle:
            raise ValueError("Engine is closed")
        return Document(self.library, None, self.handle)

class Document:
    def __init__(self, library, config, existing_engine=None):
        self.library = library
        self.handle = C.c_void_p()
        if existing_engine is not None:
            library.check(library.api.ds_document_create(existing_engine, C.byref(self.handle)))
            return
        engine = C.c_void_p()
        library.check(library.api.ds_engine_create(C.byref(config), C.byref(engine)))
        try:
            library.check(library.api.ds_document_create(engine, C.byref(self.handle)))
        finally:
            library.api.ds_engine_destroy(engine)
    def __enter__(self):
        return self
    def __exit__(self, *unused):
        self.close()
    def close(self):
        if self.handle:
            self.library.api.ds_document_destroy(self.handle)
            self.handle = C.c_void_p()
    def add(self, encoded, options):
        data = (C.c_uint8 * len(encoded)).from_buffer_copy(encoded)
        index = C.c_uint32()
        self.library.check(self.library.api.ds_document_add_image(
            self.handle, Bytes(data, len(data)), C.byref(options), C.byref(index)))
        return index.value
    def page(self, index):
        info = C.POINTER(Info)()
        data = Bytes()
        self.library.check(self.library.api.ds_document_get_page(self.handle, index, C.byref(info), C.byref(data)))
        return Info.from_buffer_copy(info.contents), C.string_at(data.data, data.size)
    def pdf(self):
        buffer = C.c_void_p()
        self.library.check(self.library.api.ds_document_pdf(self.handle, C.byref(buffer)))
        try:
            data = Bytes()
            self.library.check(self.library.api.ds_buffer_bytes(buffer, C.byref(data)))
            return C.string_at(data.data, data.size)
        finally:
            self.library.api.ds_buffer_destroy(buffer)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Images to PDF, in process")
    parser.add_argument("--library", required=True)
    parser.add_argument("--models", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("images", nargs="+")
    args = parser.parse_args()
    library = Library(args.library)
    with library.document(library.config(args.models)) as document:
        for image in args.images:
            index = document.add(Path(image).read_bytes(), library.options())
            info, _ = document.page(index)
            print(f"Page {index + 1}: {info.width} x {info.height}, warnings={info.warnings}")
        Path(args.output).write_bytes(document.pdf())
