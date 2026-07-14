/**
 * Headless proof that the generation core is engine-agnostic: generate a
 * dungeon in plain Node (no Three.js, no browser), print it as ASCII, and
 * assert determinism + a pinned regression case.
 *
 * Also covers Phase 1: gameplay PRNG determinism + save profile behavior
 * (mock localStorage).
 *
 *   node scripts/headless-demo.js [seed]
 */
import { strict as assert } from 'node:assert';
import { generateDungeon, themeFromSeed, VOID, FLOOR, WALL, POOL } from '../src/gen/dungeon.js';
import { floorSeed, reseedGameplay, gRaw, gChance, gShuffle } from '../src/game/rng.js';
import {
  clearSave, load, getSave, recordRunEnd, noteFloorReached,
  nextUnlockTease, snapshot as saveSnapshot,
  encodeShare, parseShare, dailySeedFor, markHint,
} from '../src/game/save.js';
import {
  floorHpMul, floorThemeHazards, floorWardFrac, floorEliteChance,
  rollArchetypeForFloor, sampleMix, FLOOR_TABLE,
} from '../src/game/curriculum.js';
import { mulberry32 } from '../src/gen/dungeon.js';
import { WEAPONS, droppableWeapons } from '../src/game/weapons.js';
import { RELIC_KEYS, CURSE_KEYS, ALL_RELIC_KEYS } from '../src/game/relics.js';

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

/* ---- dungeon assertions ---- */
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

/* ---- Phase 1: gameplay PRNG determinism (F9) ---- */
function rollFloorContent(floorSeedValue, nArchetypes = 24){
  reseedGameplay(floorSeedValue);
  const archetypes = [];
  for (let i = 0; i < nArchetypes; i++) {
    const r = gRaw();
    archetypes.push(r < 0.6 ? 'grunt' : r < 0.85 ? 'caster' : 'charger');
  }
  const mimics = [];
  for (let i = 0; i < 6; i++) mimics.push(gChance(0.2));
  const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  gShuffle(pool);
  const shrineOffers = [pool.slice(0, 2), pool.slice(2, 4)];
  return { archetypes, mimics, shrineOffers };
}

const fs1 = floorSeed(seed, 1);
const fs2 = floorSeed(seed, 1);
assert.equal(fs1, fs2, 'floorSeed must be pure');

const contentA = rollFloorContent(fs1);
const contentB = rollFloorContent(fs1);
assert.deepEqual(contentA, contentB, 'same floor seed → same archetypes, mimics, shrine offers');

const contentOther = rollFloorContent(floorSeed(seed, 2));
assert.notEqual(fs1, floorSeed(seed, 2), 'floors must derive distinct seeds');
assert.notDeepEqual(
  contentA,
  contentOther,
  'different floors must produce different gameplay rolls'
);
console.log('gameplay PRNG: same floor seed → identical archetype/mimic/shrine rolls ✓');

/* ---- Phase 1: save profile (mock localStorage) ---- */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};

clearSave();
load();
assert.equal(getSave().runs, 0, 'fresh profile has 0 runs');
assert.equal(getSave().unlocks.fangs, false, 'fresh profile: fangs locked');
const tease = nextUnlockTease();
assert.match(tease, /Floor 2|Twin Fangs/i, 'fresh profile shows start tease');

/* first death on floor 1 — no unlock yet */
const r1 = recordRunEnd({
  seed: 42, floor: 1, level: 2, kills: 5, gold: 10, timeSec: 90, deathBy: 'a grunt', won: false,
});
assert.equal(r1.profile.runs, 1);
assert.equal(r1.profile.best.floor, 1);
assert.equal(r1.newBest, true);
assert.ok(r1.gainedUnlocks.length === 0 || !r1.gainedUnlocks.includes('fangs'));

/* reach floor 2 via noteFloorReached (as forge does on descent) */
const gained = noteFloorReached(2);
assert.ok(gained.includes('fangs'), 'reaching floor 2 unlocks Twin Fangs');
assert.equal(getSave().unlocks.fangs, true);

/* second death on floor 2 — record + history grows */
const r2 = recordRunEnd({
  seed: 42, floor: 2, level: 3, kills: 12, gold: 40, timeSec: 180, deathBy: 'a charger', won: false,
});
assert.equal(r2.profile.runs, 2);
assert.equal(r2.profile.best.floor, 2);
assert.equal(r2.profile.history.length, 2);
assert.equal(r2.profile.history[0].floor, 2);

/* history caps at 25 */
for (let i = 0; i < 30; i++) {
  recordRunEnd({ seed: i, floor: 1, level: 1, kills: 0, gold: 0, timeSec: 10, deathBy: 'test', won: false });
}
assert.equal(getSave().history.length, 25, 'history caps at 25');

/* clear → clean first run */
clearSave();
load();
assert.equal(getSave().runs, 0);
assert.equal(getSave().unlocks.fangs, false);
assert.equal(getSave().history.length, 0);
assert.match(nextUnlockTease(), /Floor 2|Twin Fangs/i);

/* win unlocks heat */
recordRunEnd({ seed: 1, floor: 5, level: 8, kills: 80, gold: 200, timeSec: 600, won: true });
assert.equal(getSave().wins, 1);
assert.equal(getSave().unlocks.heat, true);

const snap = saveSnapshot();
assert.ok(snap.best.floor >= 5);
console.log('save profile: unlocks, best, history cap, clear ✓');

/* ---- Phase 2: floor curriculum ---- */
assert.equal(floorHpMul(1), 1.00);
assert.equal(floorHpMul(5), 1.60);
assert.ok(floorHpMul(5) < 2.2, 'HP mult capped below old 2.2× sponge');
assert.equal(floorThemeHazards(1), false, 'floor 1 suppresses theme hazards');
assert.equal(floorThemeHazards(2), true);
assert.equal(floorEliteChance(1), 0);
assert.equal(floorEliteChance(3), 0.08);
assert.equal(floorWardFrac(1), 0.40);
assert.equal(floorWardFrac(5), 0.55);

/* floor 1 never rolls advanced archetypes */
{
  const rng = mulberry32(0xC011);
  const counts = sampleMix(1, 2000, rng);
  assert.equal(counts.charger, 0, 'floor 1: no chargers');
  assert.equal(counts.bomber, 0, 'floor 1: no bombers');
  assert.equal(counts.warden, 0, 'floor 1: no wardens');
  assert.equal(counts.summoner, 0, 'floor 1: no summoners');
  assert.ok(counts.grunt > counts.caster, 'floor 1: grunts dominate');
  assert.ok(counts.caster > 0, 'floor 1: casters present');
}
/* floor 2 introduces chargers; still no bombers */
{
  const rng = mulberry32(0xC022);
  const counts = sampleMix(2, 3000, rng);
  assert.ok(counts.charger > 0, 'floor 2: chargers appear');
  assert.equal(counts.bomber, 0, 'floor 2: no bombers yet');
}
/* floor 4 has wardens + summoners */
{
  const rng = mulberry32(0xC044);
  const counts = sampleMix(4, 4000, rng);
  assert.ok(counts.warden > 0, 'floor 4: wardens');
  assert.ok(counts.summoner > 0, 'floor 4: summoners');
  assert.ok(counts.bomber > 0, 'floor 4: bombers still in mix');
}
/* mix percentages roughly match table (±8pp on 5k samples) */
{
  const rng = mulberry32(0xBEEF);
  const n = 5000;
  const counts = sampleMix(3, n, rng);
  const mix = FLOOR_TABLE[3].mix;
  for (const k of Object.keys(mix)) {
    const pct = (counts[k] / n) * 100;
    assert.ok(Math.abs(pct - mix[k]) < 8, `floor 3 ${k} ~${mix[k]}% got ${pct.toFixed(1)}%`);
  }
}
/* same raw → same archetype */
assert.equal(rollArchetypeForFloor(3, 0.1), rollArchetypeForFloor(3, 0.1));
console.log('curriculum: HP cap, floor-1 teaching mix, progressive unlocks ✓');

/* ---- Phase 3–5: weapons, relics, share codes ---- */
assert.ok(WEAPONS.fangs && WEAPONS.spear && WEAPONS.rod, 'unlockable weapons registered');
assert.equal(WEAPONS.blade.crit, 0.20);
assert.equal(droppableWeapons({ fangs:true, spear:false, rod:false }).includes('fangs'), true);
assert.equal(droppableWeapons({}).includes('fangs'), false);
assert.ok(RELIC_KEYS.length >= 20, 'relic pool expanded (got ' + RELIC_KEYS.length + ')');
assert.equal(CURSE_KEYS.length, 4);
assert.ok(ALL_RELIC_KEYS.length >= 24);
assert.equal(encodeShare(1337, 3), 'DSC-1337-3');
assert.deepEqual(parseShare('DSC-42-2'), { seed:42, heat:2 });
assert.equal(parseShare('nope'), null);
assert.equal(dailySeedFor('2026-07-14'), dailySeedFor('2026-07-14'));
assert.notEqual(dailySeedFor('2026-07-14'), dailySeedFor('2026-07-15'));
clearSave(); load();
assert.equal(markHint('pit'), true);
assert.equal(markHint('pit'), false, 'hints fire once');
console.log('weapons/relics/share/daily/hints ✓');

console.log('\nall assertions passed ✓ (pure Node, no Three.js / DOM)');