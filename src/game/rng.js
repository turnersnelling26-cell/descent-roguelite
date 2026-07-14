/**
 * Seeded gameplay PRNG — independent of the dungeon generator stream.
 *
 * Layout uses floorSeed(runSeed, floor) via generateDungeon. Gameplay rolls
 * (archetypes, mimics, shrine offers, hazards, parkour gaps, weapon tokens,
 * shop mystery relic) reseed from the same floor seed with a fixed salt so
 * "same dungeon, same offers, same dangers" holds without coupling to gen
 * call order. Cosmetic jitter, audio noise, and crits stay on Math.random().
 */
import { mulberry32, makeRng } from '../gen/dungeon.js';

/** Salt so gameplay rolls never share the generator's mulberry32 stream. */
const GAMEPLAY_SALT = 0xD15CEA5E;

let rng = null;

/** Per-floor dungeon seed (same derivation main.js used historically). */
export function floorSeed(base, floor){
  const r = mulberry32(((base >>> 0) ^ Math.imul(floor, 0x9e3779b9)) >>> 0);
  return (r() * 4294967296) >>> 0;
}

/** Reseed the gameplay stream for this floor. Call once at forge, before spawns. */
export function reseedGameplay(floorSeedValue){
  rng = makeRng(((floorSeedValue >>> 0) ^ GAMEPLAY_SALT) >>> 0);
  return rng;
}

export function gRng(){
  if(!rng) reseedGameplay(0);
  return rng;
}

export const gRaw    = ()     => gRng().raw();
export const gChance = (p)    => gRng().chance(p);
export const gI      = (a, b) => gRng().i(a, b);
export const gF      = (a, b) => gRng().f(a, b);
export const gPick   = (arr)  => gRng().pick(arr);

/** Fisher–Yates shuffle in place using the gameplay PRNG. */
export function gShuffle(arr){
  const r = gRng();
  for(let j = arr.length - 1; j > 0; j--){
    const k = r.i(0, j);
    [arr[j], arr[k]] = [arr[k], arr[j]];
  }
  return arr;
}
