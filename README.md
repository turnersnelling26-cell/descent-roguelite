# ⚔️ Descent

**A five-floor action roguelite.** Fog of war. Warded boss lairs. Permadeath. Every floor is a named, themed dungeon rolled from a seed — and the game remembers what you did after the run ends.

Fight through the mist toward a sealed lair. The ward only shatters once you've slain enough of the floor's foes. Fell the boss, spend gold at the **Wayshop** inside the portal, and descend. Five floors down, the **Tyrant of the Depths** waits — and it remembers the themes of *your* run.

Die anywhere and the run is over. Rise again with a better goal: best floor, unlocks, and the next tease on the death screen.

Rendered live with [Three.js](https://threejs.org/). Every sound is synthesized at runtime. No textures, no models, no audio files — **zero assets**.

![Descent gameplay preview](docs/preview.jpg)

---

## ▶ Play locally

```bash
npm install
npm run dev        # then open http://localhost:5173
```

Let the dungeon build itself (or press **Space** to skip the animation), then **WASD** to move. Press **`` ` ``** any time for the generator / dev drawer.

```bash
npm run build          # production build
npm run preview        # serve the build
npm run demo:headless  # pure-Node generator demo + determinism / save checks
```

---

## 🎮 Controls

| Action | Key |
| --- | --- |
| Move | **W A S D** |
| Attack *(wand / rod: 1 mana)* | **Space** |
| Dash — dodge with brief invulnerability (1 mana) | **Shift** |
| Jump — clears pits and parkour blocks | **C** |
| Take a weapon / shrine / boon / altar / shop | **1 – 4** |
| Descend from the Wayshop | **Enter** |
| Pause | **Esc** |
| Abandon run (press twice) | **R R** |
| Map pulse *(Cartographer's Orb)* | **F** |
| Sound | **M** |
| Pan · zoom · orbit camera | drag · wheel · right-drag |
| Generator & dev tools | **`` ` ``** |

---

## ✨ What's in the game

### The run
- **Five floors.** Per-floor seeds derive from the run seed — same seed, same layout and dangers.
- **Warded boss lairs.** Rune barriers hold until you meet the floor's kill quota (40–55% by depth; Heat can raise it).
- **Curriculum by floor.** Floor 1 teaches grunts and casters only (spikes + pits). Chargers, bombers, elites, wardens, and summoners unlock deeper. HP scales to a **1.6×** cap — composition carries difficulty, not sponge.
- **Theme hazards.** Ancient snares, molten vents, frost icicles, grim wisps, verdant spores (off on the teaching floor). Bosses borrow their theme; the **Tyrant** wields two themes from earlier in *your* descent.
- **Parkour rooms.** Jump the gaps (or walk the beams) for a vaulter's gold prize.

### Combat & builds
- **Six weapons.** Rusted Blade (mobile crits), Stone Hammer, Ember Wand, plus unlockable **Twin Fangs**, **Warden Spear** (shield-piercing arc), and **Frost Rod** (slow). Near a token, press **1** to take it — your old weapon drops in place. Swaps are never lost.
- **Level-up boons.** One of three choices (Vitality, Clarity, Swiftness, Precision, Force) instead of invisible +HP only.
- **Relics & curses.** Two dozen shrine relics (Cartographer's Orb pings the map without killing fog) plus four **cursed altar** options for opt-in risk.
- **Elites** (floor 3+): Swift, Stony, Vampiric, Volatile — visible risk, better spoils.

### Meta loop
- **Run memory.** Best floor/time, history (25 runs), unlocks, tallies — one `localStorage` profile (`src/game/save.js` only).
- **Unlock tree.** Floor 2 → Twin Fangs · Floor 3 → Warden Spear + start-weapon choice · Floor 4 → Frost Rod + cursed altars · First win → Heat + seed sharing.
- **Death screen.** Rank, killer + counterplay tip, unlock or next tease.
- **Explorer mode.** −25% damage + free Second Wind per floor; separate best (◎). Unlocks still count.
- **Heat** (after first win). Swift Foes, Scarce Shrines, Hungry Dark, Iron Tyrants, Fickle Fortune.
- **Share codes.** `DSC-<seed>-<heat>` — paste into the panel for the same dungeon, offers, and dangers.
- **Daily seed.** One scored attempt per day.
- **Rest.** Save at the Wayshop and resume later (one slot; cleared on death).

### Feel
- Fog-of-war **minimap**, floating damage numbers, crits, combos, heart drops, **mimic tells** (warm tint + hum), dash trails / Echo Step decoy, boss intros, low-HP heartbeat.
- **Procedural audio** via Web Audio — no sound files.

---

## 🗂 Project layout

| Path | Role |
| --- | --- |
| `src/gen/dungeon.js` | Pure, engine-agnostic dungeon generator (Node-safe) |
| `src/game/*.js` | Systems: `state`, `save`, `rng`, `curriculum`, `player`, `enemies`, `weapons`, `relics`, `loot`, `shrines`, `altars`, `boons`, `shop`, `seal`, `hazards`, `parkour`, `fog`, `hints`, `audio` |
| `src/main.js` | Three.js renderer, post, minimap, game loop, meta UI |
| `scripts/headless-demo.js` | ASCII map + determinism / save / curriculum assertions |
| `docs/preview.jpg` | Gameplay screenshot |

---

## 🌱 Branches

| Branch | Notes |
| --- | --- |
| `main` / `v1-foundation` | Early foundation snapshots |
| `descent-2` | Five-floor roguelite with hazards, parkour, Wayshop |
| `descent-3` | **Current** — meta loop, curriculum, choice, onboarding, heat |

---

## 🙏 Acknowledgments

The procedural dungeon core and painterly presentation lineage began as **Dungeon Forge** by [Majid Manzarpour](https://github.com/majidmanzarpour) ([demo](https://procedural-dungeon.netlify.app)). Descent is a separate game project that incorporates and extends that generator under the MIT license.

## 📄 License

MIT — see [`LICENSE`](LICENSE).
