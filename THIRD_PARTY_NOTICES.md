# Third-party notices

## Coopanion runtime (AGPL-3.0-or-later)

This application includes and adapts code from [Pal-AI-Lab/Coopanion](https://github.com/Pal-AI-Lab/Coopanion), commit `d7b1a0026fed3eb1975a6e0387527d806192cdbf`, package `packages/cortico-world-desktop-pet`. The vendored body, mesh rig, whale figure/model, sandbox protocol and synthesized sounds are under `web/upstream/`; its manifest reader is adapted in `src/upstream/packs.ts`. Speech timing and bubble styles are adapted in `web/speech.js` and `web/style.css`.

The combined program is distributed under **AGPL-3.0-or-later**, with the full license in `LICENSE`. Original dsh-coopanion code's MIT notice is retained in `LICENSE-MIT`. The exact imported version and modifications made on 2026-10-09 are documented in `web/upstream/UPSTREAM.md`. The installed program offers its corresponding source through **菜单 → 下载本版本源码**, including all source, vendored files, build scripts and the dependency lockfile; the npm archive also includes these files.

## DeepSeek Whale artwork and marks

The textures and thumbnails in `web/upstream/whale/`, and the generated tray icon `desktop/icon.png`, are excluded from upstream's AGPL grant. Original character: 溟月（上善无形）; DeepSeek maid reinterpretation: ZipZipPipe; generated/split artwork: Pal-AI-Lab using OpenAI's image model. Vendor marks belong to their respective owners and do not imply endorsement.

This integration follows the project user's existing statement that the community character is reusable. AGPL does not relicense these textures. The complete original upstream rights notice is preserved verbatim in [web/upstream/THIRD_PARTY_NOTICES.md](web/upstream/THIRD_PARTY_NOTICES.md). Its sections on speech-recognition libraries/models describe the upstream package; this plugin does not bundle those components.

## Electron

Electron 44.7.0 is installed as a dependency and retains its MIT license and Chromium's accompanying notices. Runtime download and verification remain unchanged.

## Marked 18.1.1 and DOMPurify 3.4.17

The full-reply reader bundles [Marked](https://github.com/markedjs/marked) and [DOMPurify](https://github.com/cure53/DOMPurify) into `web/markdown-runtime.js` at build time. Marked is distributed under the MIT license; DOMPurify is used under its Apache-2.0 license option. Their complete upstream license and copyright notices are retained in [docs/licenses/marked.txt](docs/licenses/marked.txt) and [docs/licenses/dompurify.txt](docs/licenses/dompurify.txt). Neither dependency is modified.

## fflate 0.8.3

MIT License

Copyright (c) 2026 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## zod 4.6.5

MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Compatibility monitor

The discovery, Issue-state, retry and proposal lifecycle in `scripts/compatibility/` adapts takboo/dsh-session-bin and takboo/dsh-usage-state. Copyright (c) 2026 takboo; the MIT notice is preserved in [scripts/compatibility/LICENSE](scripts/compatibility/LICENSE). Project-specific candidate packaging, companion installation and Desktop integration are maintained here.
