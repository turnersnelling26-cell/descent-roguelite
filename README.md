# ⚔️ Descent

**A five-floor action roguelite built on top of [Dungeon Forge](#-credits) — a deterministic procedural dungeon generator.**

Every floor is a freshly generated dungeon with its own name and theme. Fight through the fog toward a warded boss lair — the seal only shatters once you've slain enough of the floor's foes — fell the boss, spend your gold at the Wayshop inside the portal, and descend. Five floors down, the **Tyrant of the Depths** waits. Die anywhere along the way and the run is over.

Rendered live with [Three.js](https://threejs.org/); every sound effect is synthesized at runtime; nothing is loaded from disk.

![Descent — character sheet, fog-of-war minimap, and a warded frost dungeon](docs/descent.png)

---

## ▶ Play locally

```bash
npm install
npm run dev        # then open http://localhost:5173
```

Let the dungeon build itself (or press **Space** to skip the animation), then **WASD** to move. Press **`` ` ``** any time for the generator / dev drawer.

Other scripts:

```bash
npm run build          # production build
npm run preview        # serve the build
npm run demo:headless  # pure-Node generator demo + determinism/regression checks
```

## 🎮 Controls

| Action | Key |
| --- | --- |
| Move | **W A S D** |
| Attack *(wand: 1 mana, seeks the nearest foe)* | **Space** |
| Dash — dodge with brief invulnerability (1 mana) | **Shift** |
| Jump — clears pits and parkour blocks | **C** |
| Choose a shrine boon / shop item | **1 – 4** |
| Descend from the Wayshop | **Enter** |
| Pause | **Esc** |
| Abandon run (press twice) | **R R** |
| Lift the fog *(requires the Scrying Orb relic)* | **F** |
| Sound | **M** |
| Pan · zoom · orbit camera | drag · wheel · right-drag |
| Generator & dev tools | **`` ` ``** |

## ✨ The game

- **A run is five floors.** Each is a deterministic, generated dungeon (per-floor seeds derive from the run seed). Difficulty, enemy count, and hazard density scale with depth. Floor five holds a towering, minion-summoning **mega boss** — fell it and the depths are conquered.
- **Warded boss lairs.** No b-lining: rune barriers seal every lair entrance until half the floor's foes are slain.
- **Three enemy archetypes**, each with its own silhouette and habits: horned **grunts** swarm, hooded **casters** hover and snipe, ram-headed **chargers** telegraph then dash. Bosses fight in three escalating phases (stalk → volleys → radial bursts) under a boss HP bar.
- **A dungeon that fights back.** Self-concealing spike traps skewer players *and* enemies; pits swallow the careless; and every theme has its own menace — rune snares (ancient), fire vents (molten), falling icicles (frost), mana-drinking wisps (grim), spore pods (verdant). Frozen lakes are treacherously slick.
- **Parkour rooms.** Well-connected junction rooms are fitted with bar-block courses — jump the gaps (or land on top and walk the beams) to claim a vaulter's gold prize.
- **Weapons & relics.** Find the fast blade, heavy hammer, or mana-fueled wand; attune up to nine stacking relics at shrines (lifesteal, thorns, +damage, faster dash, the fog-lifting Scrying Orb…). A relic codex in the panel tracks what everything does.
- **The Wayshop.** The descent portal opens a between-floors shop: mend, +max health, +damage, or gamble on a mystery relic.
- **Juice.** Fog-of-war pixel minimap, floating damage numbers, 10% critical hits, combo-kill gold multipliers, heart drops, mimic chests (1 in 5 bites), dash trails, boss intro splashes, and a low-HP heartbeat you'll learn to dread.
- **Procedural audio.** Every sound — swings, crits, heartbeats, fanfares — is built from oscillators and filtered noise via the Web Audio API at runtime. No audio files.

## 🗂 Project layout

- **`src/gen/dungeon.js`** — the procedural generator, a **pure, engine-agnostic module** (zero imports, runs in plain Node): scatter → separate → Delaunay → MST + loops → semantics → carve → decorate, all threaded through one seeded PRNG. This is the reusable core for future games.
- **`src/game/*.js`** — the game systems layered on top: `state` (run/character), `player` (move/dash/jump), `enemies` (archetypes, bosses, projectiles), `weapons`, `relics`, `loot`, `shrines`, `shop`, `seal` (boss ward), `hazards` (traps/pits/theme hazards), `parkour`, `fog`, `audio`.
- **`src/main.js`** — the Three.js renderer, post-processing, minimap, and the game loop that wires it all together.
- **`scripts/headless-demo.js`** — a pure-Node demo that prints an ASCII map and asserts determinism + pinned regression values (`npm run demo:headless`).

## 🌱 Branches

- **`main` / `v1-foundation` / tag `v1.0-foundation`** — the protected v1 foundation: generator + core roguelite loop, kept pristine as a base for future games.
- **`descent-2`** — the current game described above.

## 🙏 Credits

Built on **Dungeon Forge** by **[@majidmanzarpour](https://github.com/majidmanzarpour)** ([live demo](https://procedural-dungeon.netlify.app)) — the deterministic procedural dungeon generator and its painterly Three.js renderer, themes, props, liquids, lights, and particles are his work. Descent adds the game on top: player, combat, enemies, progression, hazards, shops, relics, UI, and audio.

## 📄 License

MIT — see [`LICENSE`](LICENSE). Original generator © Majid Manzarpour.
