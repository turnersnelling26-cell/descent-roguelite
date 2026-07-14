/**
 * Level-up boon overlay — pick one of three (seeded). Force only every 3rd level.
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
};

let open = false, offers = [], onPicked = null;

export function queueLevelBoon(){
  /* called when level increases; may stack if multi-level */
  const pool = ['vitality', 'clarity', 'swiftness', 'precision'];
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
}

export function boonOpen(){ return open; }

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
  if(onPicked) onPicked();
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
