# WebCraft — browser survival

A Minecraft-style survival game that runs entirely in the browser. Everything —
block textures, item sprites, mob skins, sounds — is generated procedurally at
startup; the game ships with zero binary assets.

## Play

```bash
npm install
npm run dev      # then open the printed URL
```

Create a world from the title screen (multiple worlds are kept in
localStorage), click *Back to Game* and survive.

## Survival features

- **Mining & tools** — vanilla-style hardness/harvest rules: punch a tree,
  craft planks → sticks → wooden pickaxe → stone → iron → diamond. Tools have
  durability; ores require the right pickaxe tier and drop XP.
- **Crafting** — 2x2 inventory grid and 3x3 crafting table with shaped
  (mirrorable) and shapeless recipes: tools, weapons, armor, torches, chests,
  furnace, bow/arrows, bread, TNT and more.
- **Furnace** — fuel + smelting with live fire/arrow progress, banked XP,
  lit/unlit block states. Chests store 27 stacks.
- **Health, hunger, XP** — hearts, drumsticks, air bubbles when diving,
  XP orbs and levels. Food heals via saturation; starvation, drowning, fall
  damage, lava, fire and cactus all hurt. Death drops your inventory,
  vanilla-style, with a *You Died!* screen and respawn.
- **Mobs** — zombies, skeletons (they kite and shoot), creepers (they hiss and
  explode), spiders (neutral in daylight), plus pigs, cows, sheep and chickens.
  Hostiles spawn in darkness and burn at sunrise; animals drop meat you can
  cook — and breed: feed two cows/sheep/pigs wheat (chickens: seeds) and a baby
  pops out with heart particles. Classic box models with walk/attack animations.
- **World** — infinite chunked terrain with biomes, caves, ores, lava lakes,
  day/night cycle (20 min), farming (hoe → farmland → wheat → bread), sugar
  cane along shorelines, saplings regrow trees, grass spreads, leaves decay,
  bone meal works, TNT chains, sand and gravel fall when unsupported.
- **Beds & buckets** — craft a bed (wool + planks) to set your spawn and sleep
  through the night; buckets move water and lava around.
- **UI/UX** — Minecraft-styled title screen, world list, options (render
  distance, sound, sensitivity, FOV), pause menu, inventory with drag/shift-
  click/right-click-split slot handling, tooltips, hotbar with counts and
  durability bars, F3 debug overlay.

### Controls

| Input | Action |
| --- | --- |
| WASD / Space | move / jump |
| double-tap W or Ctrl | sprint |
| Shift | sneak (edge-safe) |
| Left click | mine / attack |
| Right click | place / use / eat / draw bow |
| E | inventory · Q drop item · 1–9/wheel hotbar |
| F3 | debug overlay · Esc pause |

## Development

```bash
npm run typecheck    # strict TS
npm run smoke        # headless engine tests (terrain, lighting, crafting, furnace…)
npm run browsertest  # full e2e via system Chrome: creates a world, crafts, dies, respawns
npm run build        # production bundle
```

The engine lives in `src/world` (chunks, meshing with AO + smooth lighting,
flood-fill light engine, terrain gen), entities in `src/entities`, rendering
helpers in `src/render`, and the DOM UI in `src/ui`.
