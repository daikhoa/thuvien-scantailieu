# Browser resource recovery — 2026-10-27

Web commit: 39c6a1528a3016618663bfaee6e55dfe414b6b4b.
SDK: @docscan/browser 0.2.0-cdf5586fa8d7 (source in browser/src).
Site version 18 deployed successfully to the existing public URL.

Root causes addressed: separate import/editor ML realms retained simultaneously;
failed editor engine cached for later edits; decoded bitmap retained during shadow
inference. Web now routes all edits through the SDK processing queue. SDK retires
failed render sessions and closes decoded source/canvas after the final source
patch, before model allocation. No model, sample size, output resolution or pixel
algorithm changes. Native DLL ABI and binaries unchanged.

Verification: 602 tests / 69 files pass; full lint, application and SDK typechecks,
production build, owned asset checksums, emitted worker graph and real native WASM
contracts pass. Regression tests fail before the fixes. Browser verified original
large colored-cover and shadowed-text images, AI shadow mode, rotation, actual
corner drag plus recrop, and classifier filter, with no error alert. Existing
camera teardown tests pass with a single shared processing engine.

Not verified: physical iOS/Android memory, heat, battery or all device RAM budgets.
Actual insufficient-memory failure remains explicit; no fake-success fallback.
AgentMemory unavailable; durable handoff recorded here and web integration docs.
