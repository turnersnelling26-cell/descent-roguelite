/**
 * Headless proof that the generation core is engine-agnostic: generate a
 * dungeon in plain Node (no Three.js, no browser), print it as ASCII, and
 * assert determinism + a pinned regression case.
 *
 *   node scripts/headless-demo.js [seed]
 */
import { strict as assert } from 'node:assert';
import { generateDungeon, themeFromSeed, VOID, FLOOR, WALL, POOL } from '../src/gen/dungeon.js';

const seed = process.argv[2] ? parseInt(process.argv[2], 10) : 1337;

// same defaults as the demo UI (rooms 42, loopiness 15%, decor 60%, AUTO theme)
const params = {
  seed,
  roomCount: 42,
  loopChance: 0.15,
  decorDensity: 0.6,
  themeKey: themeFromSeed(seed),
};

const d = generateDungeon(params);

/* ---- ASCII render ---- */
const CH = { [VOID]: ' ', [FLOOR]: '.', [WALL]: '#', [POOL]: '~' };
const mark = new Map(); // overlay entrance/boss room centers
mark.set(d.rooms[d.entrance].cy * d.W + d.rooms[d.entrance].cx, 'E');
mark.set(d.rooms[d.boss].cy * d.W + d.rooms[d.boss].cx, 'B');
let out = '';
for (let y = 0; y < d.H; y++) {
  let row = '';
  for (let x = 0; x < d.W; x++) {
    const i = y * d.W + x;
    row += mark.get(i) ?? CH[d.grid[i]];
  }
  out += row + '\n';
}
console.log(out);

console.log(`"${d.name}"`);
console.log(`seed ${d.seed} · theme ${params.themeKey} · ${d.W}x${d.H} tiles`);
console.log(`rooms ${d.stats.rooms} · edges ${d.stats.edges} (${d.stats.loops} loops) · critical path ${d.stats.critLen}`);
console.log(`floor tiles ${d.stats.floorTiles} (reach ${d.stats.reach}) · props ${d.props.length} · torches ${d.torches.length} · spawns ${d.spawns.length}`);
console.log(`generated in ${d.stats.genMs.toFixed(1)}ms (${d.stats.attempts} attempt${d.stats.attempts > 1 ? 's' : ''})`);

const roles = {};
for (const r of d.rooms) roles[r.type] = (roles[r.type] ?? 0) + 1;
console.log('room roles:', Object.entries(roles).map(([k, v]) => `${k} ${v}`).join(' · '));

/* ---- assertions ---- */
assert.equal(d.valid, true, 'dungeon must be fully connected');
assert.equal(d.stats.reach, d.stats.floorTiles, 'BFS must reach every floor tile');

const d2 = generateDungeon(params);
assert.deepEqual(Buffer.from(d2.grid), Buffer.from(d.grid), 'same seed must give byte-identical grid');
assert.equal(d2.name, d.name, 'same seed must give same name');

if (seed === 1337) {
  // pinned generator behaviour. theme/critLen/floorTiles are stable across the
  // enemy-density retune; the NAME shifted because dungeonName() draws from the
  // shared deterministic RNG after spawn placement, and the floor now places
  // fewer spawns (see the SPAWN_CAP budget in dungeon.js). Determinism itself is
  // still asserted above (two runs are byte-identical) — this just re-pins the
  // value for the current generator version.
  assert.equal(d.name, 'The Wintered Caverns of Ash’uzek');
  assert.equal(params.themeKey, 'frost');
  assert.equal(d.stats.critLen, 11);
  assert.equal(d.stats.floorTiles, 4590);
}

console.log('\nall assertions passed ✓ (pure Node, no Three.js / DOM)');
