# GCNet illumination stage (GCDRNet)

- Purpose: optional learned three-channel illumination correction for document photos. Does not predict corners, flatten curved paper or produce OCR text.
- Original research/inference: https://github.com/ZZZHANG-jx/GCDRNet (MIT, Jiaxin Zhang 2024).
- ONNX distribution: https://github.com/RapidAI/RapidUnDistort, `unshadow_predictor.py`; checkpoint mirror https://huggingface.co/spaces/Joker1212/RapidUnwrap/tree/d82549af3513c389c3de7fcdfd9d7e84fa98bbb4/models.
- File `gcnet-2eb69a0a.onnx`: 6,078,861 bytes; SHA-256 `2eb69a0aa882069f9f6d874511f019428d814d5f3edfa4881dbd6ca7d5c068f9`.
- Existing trained weights, unchanged. No training, fine-tuning, quantization or precision conversion was performed.
- Contract: float32 `input` / `output`, NCHW `[1,3,H,W]`, BGR channels, input 0..1, H/W divisible by 32. Output is illumination, not restored RGB. The DRNet reconstruction stage is deliberately not included.
- Application policy: bounded <=384-side inference; bilinear field application on original full-resolution pixels, `gain = clamp(0.96 / illumination, 1, 4)` per channel, then contrast/detail computed from corrected pixels. No extra JPEG intermediate or change to final dimensions.
- Loaded only for **Khử bóng AI**, never live camera detection or existing filters. Web uses one-thread ONNX Runtime WASM in the rendering worker/owned fallback iframe. Native uses existing one-thread ONNX Runtime CPU in process. The Web comparison's C++ crop is WASM, but its GCNet/application stage is shared JavaScript/ORT, explicitly recorded in the report implementation string.
- Limitations: can brighten colored paper, gray printed areas or dark artwork; opt-in until representative device/content validation. Does not recover clipped/occluded text or guarantee removal of every hard shadow. A 6 MB checkpoint is not the same as total runtime RAM/download. Web runtime is an additional lazy resource; no claim of reduced phone heat or universal speed.
- Attribution: `/licenses/GCDRNet-MIT.txt`. Source/checkpoint provenance is pinned above; the mirror does not supply a separate model card.
