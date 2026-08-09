---
'@be-music/player': patch
'@be-music/player-tui': patch
---

Reduce player CPU load by removing the gameplay tick scheduler's `setImmediate` tail-spin without changing TUI or
BGA frame rate. Repaint the complete TUI text frame after Kitty image replacement so terminals that invalidate text
cells while deleting the previous image do not leave unchanged rows black during animated BGA playback. Also request
a complete repaint after the loading screen is cleared, preventing its asynchronous clear from erasing the initial
static information and note lanes until the first BGA frame or terminal resize.
The Node Web Audio output now streams Float32 PCM through one AudioWorklet backed by a shared ring buffer instead of
creating more than 170 AudioBufferSourceNodes per second. This prevents CPU growth and audio underruns during longer
playback. Because Bun's worker runtime cannot safely host the dependency's AudioWorklet, its mixer writes
1,024-frame PCM chunks into a ring buffer consumed by one persistent ScriptProcessorNode. This avoids both partially
filled native AudioBuffers and the long-running accumulation of AudioBufferSourceNodes on Bun.
The default Bun macOS x64 build now uses the AVX2 target supported by all officially compatible macOS 13 Intel
Macs, while the baseline target remains available explicitly for patched legacy and restricted virtual machines.
Default Bun build outputs are named `be-music-player-macos-x64` and `be-music-player-macos-arm64`.
