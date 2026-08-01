---
'@be-music/player-tui': minor
---

Add parallel Bun build paths for standalone macOS x64 and arm64 player executables. Each Bun binary embeds the
target-matching `node-web-audio-api` addon, libav.js WASM, and the player worker entrypoints while leaving the
existing Node SEA build unchanged.
