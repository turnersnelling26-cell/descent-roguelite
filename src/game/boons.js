/**
 * Level-up boon overlay — pick one of three (seeded).
 * Choices are DEFERRED until combat is calm so mid-fight menus can't kill you.
 */
import * as run from './state.js';
import { gShuffle, gPick } from './rng.js';
import { sfx } from './audio.js';
import { showToast } from './loot.js';

const BOON_DEFS = {
  vitality:  { name:'Vitality',  desc:'+1 max HP, heal 2', apply:()=>{ run.state.maxHp++; run.heal(2); } },
  clarity:   { name:'Clarity',   desc:'+1 max mana',       apply:()=>{ run.state.maxMana++; run.state.mana = Math.min(run.state.maxMana, run.state.mana + 1); run.renderHud(); } },
  swiftness: { name:'Swiftness', desc:'+6% move speed',    apply:()=>{ run.state.mods.moveMul *= 1.06; run.renderHud(); } },
  precision: { name:'Precision', desc:'+8% crit chance',   apply:()=>{ run.state.mods.critBonus = (run.state.mods.critBonus||0) + 0.08; run.renderHud(); } },
  force:     { name:'Force',     desc:'+1 weapon damage',  apply:()=>{ run.state.mods.dmgBonus++; run.renderHud(); } },
  /* horizontal picks — change how you play, not just the numbers */
  flow:      { name:'Flow State', desc:'Combo window +2s, +25% combo gold',
               apply:()=>{ run.state.mods.comboWindow += 2; run.state.mods.comboGoldMul *= 1.25; run.renderHud(); } },
  momentum:  { name:'Momentum',  desc:'Dash +20% range, −15% cooldown',
               apply:()=>{ run.state.mods.dashDistMul *= 1.2; run.state.mods.dashCdMul *= 0.85; run.renderHud(); } },
};

let open = false, offers = [], pending = 0, toastPending = false;

/** Called on level-up — does NOT open UI immediately. */
export function queueLevelBoon(){
  pending++;
  if(!open && !toastPending){
    toastPending = true;
    showToast('Level up — pick a boon when the room is clear');
  }
}

export function boonOpen(){ return open; }
export function boonsPending(){ return pending; }

/**
 * Call each frame from the game loop.
 * Opens the overlay only when no threat is nearby (safe room).
 * @param {boolean} combatNearby — true if an alive aggro foe is close
 */
export function tickBoonOffer(combatNearby){
  if(open || pending <= 0) return;
  if(combatNearby) return;
  openNextBoon();
}

function openNextBoon(){
  if(pending <= 0 || open) return;
  pending--;
  toastPending = false;
  const pool = ['vitality', 'clarity', 'swiftness', 'precision', 'flow', 'momentum'];
  if(run.state.level % 3 === 0) pool.push('force');
  const shuffled = gShuffle([...pool]);
  const three = [];
  for(const k of shuffled){
    if(three.length >= 3) break;
    three.push(k);
  }
  while(three.length < 3) three.push(gPick(pool));
  offers = three;
  open = true;
  showOverlay();
  /* brief grace: world is frozen by main while open */
  sfx.pickup();
}

export function selectBoon(i){
  if(!open) return;
  const key = offers[i];
  const def = BOON_DEFS[key];
  if(!def) return;
  def.apply();
  showToast(def.name + ' — ' + def.desc);
  sfx.pickup();
  open = false; offers = [];
  hideOverlay();
  /* chain remaining levels after a beat of calm (next frame will re-check) */
  if(pending > 0) toastPending = true;
}

function showOverlay(){
  const el = document.getElementById('boon');
  if(!el) return;
  const cards = el.querySelectorAll('.scard');
  [0,1,2].forEach(i=>{
    const key = offers[i], def = BOON_DEFS[key], card = cards[i];
    if(!card || !def) return;
    card.querySelector('.sn').textContent = def.name;
    card.querySelector('.sd').textContent = def.desc;
  });
  el.classList.add('show');
}
function hideOverlay(){ document.getElementById('boon')?.classList.remove('show'); }

export function cancelBoon(){
  open = false; offers = [];
  hideOverlay();
}
