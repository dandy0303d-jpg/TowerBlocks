# Scripts layout

Each subfolder owns one responsibility. The boundary between layers is enforced
by **only allowing imports in one direction**:

```
main → ui, render, input, audio, storage, core
ui    → core
render → core
input  → core
audio  → core
storage → core
core   → (nothing — pure logic)
```

Anything in `core/` MUST stay engine-agnostic: no `cc.*` imports, no DOM, no
file system. That guarantees the same logic compiles in unit tests and ports
cleanly to other engines / platforms later.

## Folders

| Folder      | Purpose                                                              |
|-------------|----------------------------------------------------------------------|
| `core/`     | Pure game logic. Constants, types, board state, mechanics, props.    |
| `render/`   | Cocos-side rendering. Owns cubes, cylinder projection, particles.    |
| `input/`    | Touch / mouse / keyboard → game commands. Bridges Cocos input → core.|
| `ui/`       | Cocos UI nodes. HUD, overlays, toasts, level select, settings.       |
| `audio/`    | Sound effect playback. Wraps Cocos `AudioSource` + clip preloading.  |
| `storage/`  | Persistent state (`sys.localStorage`). Best score, settings, unlocks.|
| `main/`     | Top-level glue. `GameController` boots everything.                   |

## Naming

- Files: `PascalCase.ts` for components / classes, `camelCase.ts` for helpers.
- Components decorated with `@ccclass('XxxName')` always match filename.
- One default-exported component per Cocos-attached file.
