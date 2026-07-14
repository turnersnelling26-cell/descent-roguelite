/**
 * Central run + character state — vitals, mods, progression.
 * Permadeath: death ends the run (meta memory in save.js).
 */
import { weaponOf } from './weapons.js';
import { RELICS } from './relics.js';
import { sfx } from './audio.js';
import { noteWeapon, getSave } from './save.js';

/* level-up hook (wired from main → boons) avoids state↔boons cycle */
let onLevelUpCb = null;
export function onLevelUp(cb){ onLevelUpCb = cb; }

const DEFAULT_MODS = {
  dmgBonus:0, moveMul:1, dashCdMul:1, atkCdMul:1,
  lifesteal:0, thorns:0, manaRegenMul:1, iframeBonus:0,
  critBonus:0, execute:0, staticEvery:0, lowHpDmg:0, boltMana:0,
  stoneSkinCd:0, secondWind:0, bulwark:0, cleanse:0, featherfall:0,
  dashDistMul:1, echoStep:0, heartChance:0.08, shopMul:1,
  comboGoldMul:1, comboWindow:3, goldGamble:0, shrineTriple:0, noChestHeal:0,
};
const MULT = new Set(['moveMul', 'dashCdMul', 'atkCdMul', 'manaRegenMul', 'dashDistMul', 'shopMul', 'comboGoldMul']);

export const FINAL_FLOOR = 5;

export const state = {
  hp: 6, maxHp: 6,
  mana: 4, maxMana: 4,
  xp: 0, xpNext: 6, level: 1,
  gold: 0,
  floor: 1,
  kills: 0,
  chests: 0, chestsTotal: 0,
  weaponKey: 'blade', weapon: 'Rusted Blade', weaponDmg: 1, weaponSpeed: 'Fast · Crit',
  relics: [],
  mods: { ...DEFAULT_MODS },
  dead: false,
  deathBy: null,
  themesSeen: [],
  floorTheme: null,
  /* combat runtime flags */
  secondWindUsed: false,
  stoneSkinReadyAt: 0,
  strikeCount: 0,
  heat: 0,                 // active heat this run
  heatFlags: {},           // { swift, scarce, hungry, iron, fickle }
  explorer: false,
  restSlot: null,
};

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
  if(!e.hp) return;
  e.hp.textContent   = state.hp + ' / ' + state.maxHp;
  e.barHp.style.width   = pct(state.hp, state.maxHp);
  e.mana.textContent = Math.floor(state.mana) + ' / ' + state.maxMana;
  e.barMana.style.width = pct(state.mana, state.maxMana);
  e.xp.textContent   = state.xp + ' / ' + state.xpNext;
  e.barXp.style.width   = pct(state.xp, state.xpNext);
  e.level.textContent  = state.level;
  e.gold.textContent   = state.gold;
  e.floor.textContent  = state.floor + '/' + FINAL_FLOOR;
  e.weapon.textContent = state.weapon + ' · ' + state.weaponSpeed;
  e.relics.innerHTML = state.relics.length
    ? state.relics.map(r=>{
        const curse = RELICS[r.key]?.curse;
        return '<span class="pill'+(curse?' curse':'')+'">'+r.name+'</span>';
      }).join('')
    : '<span class="dimpill">none yet</span>';
  updateLowHp();
  document.querySelectorAll('#codex [data-relic]').forEach(row=>{
    row.classList.toggle('owned', state.relics.some(r=>r.key === row.dataset.relic));
  });
}

export function newRun(floor = 1){
  state.level = 1; state.xp = 0; state.xpNext = 6;
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
  state.deathBy = null;
  state.themesSeen = [];
  state.floorTheme = null;
  state.secondWindUsed = false;
  state.stoneSkinReadyAt = 0;
  state.strikeCount = 0;
  const save = getSave();
  state.explorer = !!(save.settings && save.settings.explorerMode);
  state.heat = 0;
  state.heatFlags = {};
  noteWeapon(state.weaponKey);
  renderHud();
}

export function noteTheme(themeKey){
  if(!themeKey) return;
  state.floorTheme = themeKey;
  if(!state.themesSeen.includes(themeKey)) state.themesSeen.push(themeKey);
}

export function setHeat(flags = {}){
  state.heatFlags = { ...flags };
  state.heat = ['swift','scarce','hungry','iron','fickle'].filter(k => flags[k]).length;
}

export function acquireRelic(key){
  const r = RELICS[key];
  if(!r || state.relics.some(x=>x.key === key)) return false;
  state.relics.push({ key, name: r.name, curse: !!r.curse });
  if(r.hp){
    state.maxHp = Math.max(1, state.maxHp + r.hp);
    if(r.hp > 0) state.hp = Math.min(state.maxHp, state.hp + r.hp);
    else state.hp = Math.min(state.hp, state.maxHp);
  }
  if(r.mana){ state.maxMana += r.mana; state.mana += r.mana; }
  if(r.mod) for(const k in r.mod){
    if(MULT.has(k)) state.mods[k] *= r.mod[k];
    else            state.mods[k] = (state.mods[k] || 0) + r.mod[k];
  }
  renderHud();
  return true;
}

export function nextFloor(){
  state.floor++;
  state.hp = Math.min(state.maxHp, state.hp + Math.ceil(state.maxHp * 0.4));
  state.mana = state.maxMana;
  state.chests = 0; state.chestsTotal = 0;
  state.dead = false;
  state.secondWindUsed = false;
  renderHud();
}

export function spendMana(n){
  if(state.mana < n) return false;
  state.mana -= n; renderHud();
  return true;
}
export function tickRegen(dt, rate = 0.7){
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
  noteWeapon(w.key);
  renderHud();
}

export function setDeathCause(cause){
  if(cause) state.deathBy = cause;
}

export function damage(n, cause){
  let dmg = n;
  /* explorer: −25% enemy damage, min 1 if n≥1 */
  if(state.explorer && dmg > 0) dmg = Math.max(1, Math.ceil(dmg * 0.75));

  /* stone skin: negate one hit every Cd (shimmer is driven in enemies update) */
  const now = (typeof performance !== 'undefined' ? performance.now() : 0) / 1000;
  if(state.mods.stoneSkinCd && now >= state.stoneSkinReadyAt && dmg > 0){
    state.stoneSkinReadyAt = now + state.mods.stoneSkinCd;
    sfx.swing();
    document.getElementById('lowhp')?.classList.add('shimmer');
    setTimeout(()=>document.getElementById('lowhp')?.classList.remove('shimmer'), 200);
    renderHud();
    return false;
  }

  state.hp = Math.max(0, state.hp - dmg);
  if(state.hp <= 0){
    const freeWind = state.explorer; // free once-per-floor second wind in explorer
    const hasWind = state.mods.secondWind || freeWind;
    if(hasWind && !state.secondWindUsed){
      state.secondWindUsed = true;
      state.hp = 1;
      sfx.pickup();
      renderHud();
      return false;
    }
    state.dead = true;
    if(cause) state.deathBy = cause;
    else if(!state.deathBy) state.deathBy = 'the depths';
  }
  if(!state.dead && state.hp <= 2) sfx.heartbeat();
  renderHud();
  return state.dead;
}

let lowOn = false;
function updateLowHp(){
  const low = !state.dead && state.hp > 0 && state.hp <= 2;
  if(low !== lowOn){
    lowOn = low;
    document.getElementById('lowhp')?.classList.toggle('on', low);
  }
}
export function heal(n){
  state.hp = Math.min(state.maxHp, state.hp + n);
  renderHud();
}

let comboN = 0, comboAt = -1e9, comboTimer = null;
function comboPop(){
  const el = document.getElementById('combo');
  if(!el) return;
  el.textContent = 'COMBO ×' + comboN;
  el.classList.add('show');
  clearTimeout(comboTimer);
  comboTimer = setTimeout(()=>el.classList.remove('show'), 1400);
}

function gambleGold(g){
  if(!state.mods.goldGamble) return g;
  const mul = 0.5 + Math.random() * 1.5; // 50–200%
  return Math.max(0, Math.round(g * mul));
}

export function addKill(xp = 1, gold = 1){
  const now = performance.now()/1000;
  const win = state.mods.comboWindow || 3;
  comboN = (now - comboAt < win) ? comboN + 1 : 1;
  comboAt = now;
  if(comboN >= 2){
    const cm = state.mods.comboGoldMul || 1;
    gold = Math.round(gold * (1 + 0.25*(comboN-1)) * cm);
    comboPop();
  }
  gold = gambleGold(gold);
  state.kills++;
  state.gold += gold;
  state.xp += xp;
  let leveled = false;
  while(state.xp >= state.xpNext){
    state.xp -= state.xpNext;
    state.level++;
    leveled = true;
    state.xpNext = Math.round(state.xpNext * 1.35);
  }
  renderHud();
  if(leveled && onLevelUpCb) onLevelUpCb();
}

export function addGold(n){
  state.gold += gambleGold(n);
  renderHud();
}

export function setChestTotal(n){ state.chestsTotal = n; renderHud(); }
export function collectChest(healAmount = 2){
  state.chests++;
  if(!state.mods.noChestHeal) heal(healAmount);
  else renderHud();
}

export function effectiveCrit(weaponCrit = 0.10){
  return Math.min(0.75, (weaponCrit || 0.10) + (state.mods.critBonus || 0));
}

export function effectiveDmgBonus(){
  let b = state.mods.dmgBonus || 0;
  if(state.mods.lowHpDmg && state.hp <= 2) b += state.mods.lowHpDmg;
  return b;
}

export function snapshot(){
  return {
    hp: state.hp, maxHp: state.maxHp, mana: state.mana, maxMana: state.maxMana,
    xp: state.xp, xpNext: state.xpNext, level: state.level, gold: state.gold,
    floor: state.floor, kills: state.kills,
    chests: state.chests, chestsTotal: state.chestsTotal,
    weapon: state.weapon, weaponKey: state.weaponKey,
    relics: state.relics.map(r=>r.key), mods: { ...state.mods },
    themesSeen: [...state.themesSeen], floorTheme: state.floorTheme,
    heat: state.heat, explorer: state.explorer,
  };
}

/** Serialize run for Rest (Wayshop). */
export function serializeRun(runSeed){
  return {
    v:1, runSeed: runSeed >>> 0, floor: state.floor, level: state.level,
    xp: state.xp, xpNext: state.xpNext,
    hp: state.hp, maxHp: state.maxHp, mana: state.mana, maxMana: state.maxMana,
    gold: state.gold, kills: state.kills, weaponKey: state.weaponKey,
    relics: state.relics.map(r=>r.key), mods: { ...state.mods },
    themesSeen: [...state.themesSeen], floorTheme: state.floorTheme,
    heatFlags: { ...state.heatFlags },
    explorer: state.explorer, secondWindUsed: state.secondWindUsed,
    strikeCount: state.strikeCount || 0,
  };
}

/**
 * Restore run vitals/mods without changing floor seed logic.
 * Caller must forge the matching floor with the stored runSeed.
 */
export function applySerializedRun(data){
  if(!data || data.v !== 1) return false;
  state.floor = data.floor | 0;
  state.level = data.level | 0; state.xp = data.xp | 0; state.xpNext = data.xpNext || 6;
  state.hp = data.hp; state.maxHp = data.maxHp;
  state.mana = data.mana; state.maxMana = data.maxMana;
  state.gold = data.gold | 0; state.kills = data.kills | 0;
  state.relics = [];
  state.mods = { ...DEFAULT_MODS };
  /* restore mods from snapshot first (includes boon stacking), then equip */
  if(data.mods) state.mods = { ...DEFAULT_MODS, ...data.mods };
  for(const k of (data.relics || [])){
    const r = RELICS[k];
    if(!r || state.relics.some(x=>x.key === k)) continue;
    state.relics.push({ key: k, name: r.name, curse: !!r.curse });
  }
  equipWeapon(data.weaponKey || 'blade');
  state.themesSeen = [...(data.themesSeen || [])];
  state.floorTheme = data.floorTheme || null;
  state.heatFlags = { ...(data.heatFlags || {}) };
  state.heat = ['swift','scarce','hungry','iron','fickle'].filter(k => state.heatFlags[k]).length;
  state.explorer = !!data.explorer;
  state.secondWindUsed = !!data.secondWindUsed;
  state.strikeCount = data.strikeCount | 0;
  state.dead = false;
  state.deathBy = null;
  renderHud();
  return true;
}
