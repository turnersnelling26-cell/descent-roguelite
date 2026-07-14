/**
 * The Wayshop — a gold sink between floors. Stepping into the descent portal
 * opens the shop instead of dropping you straight down; spend your gold on
 * permanent (per-run) upgrades, then descend when ready. Gameplay is frozen
 * while it's open (main.js gates the update loop on shopOpen()).
 */
import * as run from './state.js';
import { RELICS, RELIC_KEYS } from './relics.js';
import { showToast } from './loot.js';
import { sfx } from './audio.js';

let open = false, onDescend = null, purchases = 0;

const ITEMS = [
  { id:'heal',  name:'Mend All',      desc:'Restore full health',  price: 20,
    can: ()=> run.state.hp < run.state.maxHp,
    buy: ()=> run.heal(run.state.maxHp) },
  { id:'vigor', name:'Heart of Oak',  desc:'+1 max health',        price: 35,
    can: ()=> true,
    buy: ()=>{ run.state.maxHp++; run.heal(1); } },
  { id:'whet',  name:'Whetstone',     desc:'+1 weapon damage',     price: 45,
    can: ()=> true,
    buy: ()=>{ run.state.mods.dmgBonus++; run.renderHud(); } },
  { id:'relic', name:'Mystery Relic', desc:'A random unowned relic', price: 60,
    can: ()=> RELIC_KEYS.some(k=>!run.state.relics.find(r=>r.key===k)),
    buy: ()=>{
      const pool = RELIC_KEYS.filter(k=>!run.state.relics.find(r=>r.key===k));
      const key = pool[Math.floor(Math.random()*pool.length)];
      run.acquireRelic(key);
      showToast('The merchant hands you… ' + RELICS[key].name + '!');
    } },
];

function render(){
  const el = document.getElementById('shop');
  if(!el) return;
  el.querySelector('.sgold').textContent = run.state.gold + ' gold';
  el.querySelectorAll('.shopcard').forEach((card, i)=>{
    const it = ITEMS[i];
    const ok = it.can() && run.state.gold >= it.price;
    card.classList.toggle('off', !ok);
    card.querySelector('.sn').textContent = it.name;
    card.querySelector('.sd').textContent = it.desc;
    card.querySelector('.sp').textContent = it.price + 'g';
  });
}

export function openShop(descendCb){
  open = true; onDescend = descendCb; purchases = 0;
  render();
  document.getElementById('shop')?.classList.add('show');
}

export function buyShopItem(i){
  if(!open) return;
  const it = ITEMS[i];
  if(!it) return;
  if(!it.can()){ showToast('The merchant shakes their head.'); return; }
  if(run.state.gold < it.price){ showToast('Not enough gold.'); sfx.hurt(); return; }
  run.state.gold -= it.price;
  it.buy();
  purchases++;
  run.renderHud();
  sfx.pickup();
  render();
}

export function shopDescend(){
  if(!open) return;
  open = false;
  document.getElementById('shop')?.classList.remove('show');
  const cb = onDescend; onDescend = null;
  if(cb) cb();
}

/* close without descending (e.g. R pressed for a fresh run mid-shop) */
export function cancelShop(){
  open = false; onDescend = null;
  document.getElementById('shop')?.classList.remove('show');
}

export const shopOpen = ()=> open;
export const shopStats = ()=>({ open, gold: run.state.gold, purchases,
  canBuy: ITEMS.map(it=>it.can() && run.state.gold >= it.price) });
