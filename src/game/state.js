/**
 * Central run + character state — the single source of truth for the
 * roguelite's vitals and progression, plus the renderer for the left-column
 * character sheet. Combat (enemies.js) and pickups (loot.js) mutate this
 * through its methods; main.js reads it for the objective line and exposes a
 * snapshot as window.__state for headless tests.
 *
 * Phase 1 (foundation): every forge starts a fresh run at floor 1. Descending
 * between floors (which will preserve level/gold/relics and only partially
 * heal) arrives with the progression phase — newRun() is the seam for it.
 */

import { weaponOf } from './weapons.js';
import { RELICS } from './relics.js';

/* relic modifiers, read by player.js / enemies.js / tickRegen. Multiplicative
   keys stack by product; the rest add. */
const DEFAULT_MODS = { dmgBonus:0, moveMul:1, dashCdMul:1, atkCdMul:1,
                       lifesteal:0, thorns:0, manaRegenMul:1, iframeBonus:0 };
const MULT = new Set(['moveMul', 'dashCdMul', 'atkCdMul', 'manaRegenMul']);

export const state = {
  hp: 6, maxHp: 6,
  mana: 4, maxMana: 4,                     // mana is a float; the HUD shows it floored
  xp: 0, xpNext: 5, level: 1,
  gold: 0,
  floor: 1,
  kills: 0,
  chests: 0, chestsTotal: 0,
  weaponKey: 'blade', weapon: 'Rusted Blade', weaponDmg: 1, weaponSpeed: 'Fast',
  relics: [],                              // [{key,name}]
  mods: { ...DEFAULT_MODS },
  dead: false,
};

/* -------- DOM refs (looked up lazily; all live in the panel) -------- */
let els = null;
function refs(){
  if(els) return els;
  const $ = id => document.getElementById(id);
  els = {
    hp:$('vHp'), barHp:$('barHp'), mana:$('vMana'), barMana:$('barMana'),
    xp:$('vXp'), barXp:$('barXp'), level:$('vLevel'), gold:$('vGold'),
    weapon:$('vWeapon'), relics:$('vRelics'), floor:$('vFloor'),
  };
  return els;
}
const pct = (n,d) => (d>0 ? Math.max(0, Math.min(100, (n/d)*100)) : 0) + '%';

export function renderHud(){
  const e = refs();
  if(!e.hp) return;                       // panel not present (headless gen tests)
  e.hp.textContent   = state.hp + ' / ' + state.maxHp;
  e.barHp.style.width   = pct(state.hp, state.maxHp);
  e.mana.textContent = Math.floor(state.mana) + ' / ' + state.maxMana;
  e.barMana.style.width = pct(state.mana, state.maxMana);
  e.xp.textContent   = state.xp + ' / ' + state.xpNext;
  e.barXp.style.width   = pct(state.xp, state.xpNext);
  e.level.textContent  = state.level;
  e.gold.textContent   = state.gold;
  e.floor.textContent  = state.floor;
  e.weapon.textContent = state.weapon + ' · ' + state.weaponSpeed;
  e.relics.innerHTML = state.relics.length
    ? state.relics.map(r=>'<span class="pill">'+r.name+'</span>').join('')
    : '<span class="dimpill">none yet</span>';
}

/* -------- lifecycle -------- */
export function newRun(floor = 1){
  state.level = 1; state.xp = 0; state.xpNext = 5;
  state.maxHp = 6; state.hp = 6;
  state.maxMana = 4; state.mana = 4;
  state.gold = 0; state.kills = 0;
  state.chests = 0; state.chestsTotal = 0;
  state.floor = floor;
  const w0 = weaponOf('blade');
  state.weaponKey = w0.key; state.weapon = w0.name; state.weaponDmg = w0.dmg; state.weaponSpeed = w0.speedTag;
  state.relics = [];
  state.mods = { ...DEFAULT_MODS };
  state.dead = false;
  renderHud();
}

/* acquire a relic (from a shrine): apply immediate +max and merge its mods.
   Relics persist across floors within a run; newRun() clears them. */
export function acquireRelic(key){
  const r = RELICS[key];
  if(!r || state.relics.some(x=>x.key === key)) return false;
  state.relics.push({ key, name: r.name });
  if(r.hp){ state.maxHp += r.hp; state.hp += r.hp; }
  if(r.mana){ state.maxMana += r.mana; state.mana += r.mana; }
  if(r.mod) for(const k in r.mod){
    if(MULT.has(k)) state.mods[k] *= r.mod[k];
    else            state.mods[k] += r.mod[k];
  }
  renderHud();
  return true;
}

/* descend to the next floor: keep the character (weapon/gold/level/xp/relics/
   kills), partially heal, refill mana, and reset per-floor chest progress */
export function nextFloor(){
  state.floor++;
  state.hp = Math.min(state.maxHp, state.hp + Math.ceil(state.maxHp * 0.4));
  state.mana = state.maxMana;
  state.chests = 0; state.chestsTotal = 0;
  state.dead = false;
  renderHud();
}

/* -------- mana + weapons -------- */
export function spendMana(n){
  if(state.mana < n) return false;
  state.mana -= n; renderHud();
  return true;
}
export function tickRegen(dt, rate = 0.7){         // per-frame; touches only the mana bar
  if(state.mana >= state.maxMana) return;
  state.mana = Math.min(state.maxMana, state.mana + rate*state.mods.manaRegenMul*dt);
  const e = refs();
  if(e.mana){
    e.barMana.style.width = pct(state.mana, state.maxMana);
    e.mana.textContent = Math.floor(state.mana) + ' / ' + state.maxMana;
  }
}
export function equipWeapon(key){
  const w = weaponOf(key);
  state.weaponKey = w.key; state.weapon = w.name; state.weaponDmg = w.dmg; state.weaponSpeed = w.speedTag;
  renderHud();
}

/* -------- vitals -------- */
export function damage(n){                 // returns true if this blow was fatal
  state.hp = Math.max(0, state.hp - n);
  if(state.hp <= 0) state.dead = true;
  renderHud();
  return state.dead;
}
export function heal(n){
  state.hp = Math.min(state.maxHp, state.hp + n);
  renderHud();
}
export function reviveFloor(){             // Phase 1 death = respawn at full HP
  state.hp = state.maxHp; state.dead = false;
  renderHud();
}

/* -------- progression -------- */
export function addKill(xp = 1, gold = 1){
  state.kills++;
  state.gold += gold;
  state.xp += xp;
  while(state.xp >= state.xpNext){         // level up: sturdier + a little healing
    state.xp -= state.xpNext;
    state.level++;
    state.maxHp += 1;
    state.hp = Math.min(state.maxHp, state.hp + 2);
    state.xpNext = Math.round(state.xpNext * 1.4);
  }
  renderHud();
}

/* -------- loot -------- */
export function setChestTotal(n){ state.chestsTotal = n; renderHud(); }
export function collectChest(healAmount = 2){
  state.chests++;
  heal(healAmount);                        // heal() re-renders
}

export function snapshot(){                 // window.__state for tests
  return {
    hp: state.hp, maxHp: state.maxHp, mana: state.mana, maxMana: state.maxMana,
    xp: state.xp, xpNext: state.xpNext, level: state.level, gold: state.gold,
    floor: state.floor, kills: state.kills,
    chests: state.chests, chestsTotal: state.chestsTotal,
    weapon: state.weapon, weaponKey: state.weaponKey,
    relics: state.relics.map(r=>r.key), mods: { ...state.mods },
  };
}
