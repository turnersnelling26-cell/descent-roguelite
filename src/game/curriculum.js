/**
 * Floor curriculum — pure data + helpers (no Three.js).
 * Depth is composition (who shows up) more than hit-point sponge.
 * HP multiplier caps at 1.6× on floor 5 (was 2.2×).
 */

/** Mix weights g/c/ch/bo/wa/su as percentages (sum ~100). */
export const FLOOR_TABLE = {
  1: {
    mix: { grunt:70, caster:30, charger:0, bomber:0, warden:0, summoner:0 },
    elite: 0, hpMul: 1.00, ward: 0.40,
    tease: null,
    themeHazards: false,
  },
  2: {
    mix: { grunt:55, caster:30, charger:15, bomber:0, warden:0, summoner:0 },
    elite: 0, hpMul: 1.15, ward: 0.45,
    tease: 'New: Chargers — they wind up, then dash',
    themeHazards: true,
  },
  3: {
    mix: { grunt:45, caster:25, charger:15, bomber:15, warden:0, summoner:0 },
    elite: 0.08, hpMul: 1.30, ward: 0.50,
    tease: 'New: Bombers swell and explode · elites appear',
    themeHazards: true,
  },
  4: {
    mix: { grunt:35, caster:20, charger:15, bomber:10, warden:12, summoner:8 },
    elite: 0.12, hpMul: 1.45, ward: 0.55,
    tease: 'New: Wardens block the front · Summoners raise grunts',
    themeHazards: true,
  },
  5: {
    mix: { grunt:30, caster:20, charger:15, bomber:10, warden:15, summoner:10 },
    elite: 0.15, hpMul: 1.60, ward: 0.55,
    tease: 'The Tyrant remembers every theme you faced',
    themeHazards: true,
  },
};

const ARCH_ORDER = ['grunt', 'caster', 'charger', 'bomber', 'warden', 'summoner'];

export function clampFloor(floor){
  const f = floor | 0;
  return Math.max(1, Math.min(5, f || 1));
}

export function floorSpec(floor){
  return FLOOR_TABLE[clampFloor(floor)];
}

export function floorHpMul(floor){
  return floorSpec(floor).hpMul;
}

export function floorWardFrac(floor){
  return floorSpec(floor).ward;
}

export function floorEliteChance(floor){
  return floorSpec(floor).elite;
}

export function floorTease(floor){
  return floorSpec(floor).tease;
}

export function floorThemeHazards(floor){
  return !!floorSpec(floor).themeHazards;
}

/**
 * Weighted archetype roll from a mix table + raw ∈ [0,1).
 * Pure — same raw → same type (used by spawn + headless bounds tests).
 */
export function rollArchetype(mix, raw01){
  const r = Math.max(0, Math.min(0.999999, raw01));
  let total = 0;
  for(const k of ARCH_ORDER) total += mix[k] || 0;
  if(total <= 0) return 'grunt';
  let acc = 0;
  for(const k of ARCH_ORDER){
    acc += (mix[k] || 0) / total;
    if(r < acc) return k;
  }
  return 'grunt';
}

export function rollArchetypeForFloor(floor, raw01){
  return rollArchetype(floorSpec(floor).mix, raw01);
}

/** Elite affix keys (exactly one per elite). */
export const ELITE_AFFIXES = ['swift', 'stony', 'vampiric', 'volatile'];

export function rollEliteAffix(raw01){
  const i = Math.min(ELITE_AFFIXES.length - 1, Math.floor(raw01 * ELITE_AFFIXES.length));
  return ELITE_AFFIXES[i];
}

/**
 * Sample many rolls; return counts per archetype.
 * For headless: floor 1 must never produce charger/bomber/warden/summoner.
 */
export function sampleMix(floor, n, rngRaw){
  const mix = floorSpec(floor).mix;
  const counts = Object.fromEntries(ARCH_ORDER.map(k => [k, 0]));
  for(let i = 0; i < n; i++){
    const t = rollArchetype(mix, rngRaw());
    counts[t]++;
  }
  return counts;
}
