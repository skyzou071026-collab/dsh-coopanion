# Imported Coopanion runtime

This file records the pinned import and adaptations. For the current plugin's dependencies and notices, read the root [third-party notices](../../THIRD_PARTY_NOTICES.md). The adjacent `THIRD_PARTY_NOTICES.md` is the original upstream notice: its speech-recognition dependencies, model paths and Electron version describe that upstream package. Its relative `LICENSE` link is supported by an identical copy of the root AGPL license here.

Source: https://github.com/Pal-AI-Lab/Coopanion/tree/d7b1a0026fed3eb1975a6e0387527d806192cdbf/packages/cortico-world-desktop-pet

Commit: `d7b1a0026fed3eb1975a6e0387527d806192cdbf` (pinned; no runtime download).

License: AGPL-3.0-or-later for code and model data; whale textures and thumbnails follow the separate notice in `THIRD_PARTY_NOTICES.md`. The combined application retains the license text at the repository root.

Imported unchanged:

- `kit/rig.js`: shared movement, gestures, expressions, particles, WebGL mesh rendering.
- `whale/`: original figure entry, model, all eight schemes and assets.
- `figure-frame.js`: API 2 factory and sandbox message protocol.
- `sound.js`: original Web Audio synthesis and pack sound support.

Harness adaptations, 2026-10-09:

- `body-host.js` locates the sandbox page relative to its module instead of `/figure-frame`. It allows one outstanding animation tick per body and accumulates elapsed time up to 50 ms, preventing slow renderers from queuing frames ahead of input.
- `figure-frame.html` locates its script relatively. The local server supplies the original isolation policy: opaque iframe origin, restricted script/image URLs, no connections, no forms or child frames.
- `src/upstream/packs.ts` retains the upstream manifest reader and types, with the small vocabulary type/limit inline; World registration and bot-specific helpers are omitted.
- `web/speech.js` adapts original `typeText`: adaptive speed (at least 22 characters/second, at most about 3 seconds per preview), punctuation pauses, babble and mouth pulses; Unicode-safe plain text. `web/style.css` adapts the original outlined bubble and tail.
- Harness state mapping, loopback asset server, pack storage, native-window integration, source download and UI are implemented by dsh-coopanion.

No Cortico World service, upstream bot, speech-recognition runtime or independent model credentials are introduced.

Harness refinements, 2026-10-10:

- The host listens to public assistant-stream and lifecycle events. Thinking remains active through the body state; active tasks wake sleeping bodies. Live deltas drive animation only; speech is reserved for confirmed final replies.
- Authenticated upstream touch events drive interaction feedback, with double-click and task-output precedence. Drag feedback closes panels only while the current pointer is held, so a late frame cannot dismiss a later chat. The rig and whale renderer remain unchanged.
- Outlined menus and conversation cards use manifest console hues and thumbnails. Session identity comes from public human prompts, cwd, timestamps and distinct short IDs.
- The native tray projects the same snapshot, selected appearance and acknowledged settings as the desktop page. macOS uses an icon-only template with aggregate attention markers, while menu and tooltip retain state details.

- `kit/body.js` adds optional persistent `set({ expression })` for Harness task faces, without repeating expression sounds or bounces. All other original body behavior is retained.
- Final replies retain complete text and per-result read identity. Bounded previews use the original typewriter, punctuation and mouth pulses; a stable full-text reader and explicit session focus prevent concurrent tasks from interrupting reading or redirecting chat.
