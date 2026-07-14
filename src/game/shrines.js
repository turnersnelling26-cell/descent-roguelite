/**
 * Interactive shrines — the generator already builds shrine rooms with a
 * crystal; this gives them a purpose. Each shrine rolls two un-owned relics as
 * offers. Standing at the crystal opens a choice overlay: take one of the two
 * relics, or Mend (heal to full). Each shrine is used once. Shrine rooms hold
 * no enemies, so the choice happens in safety (no pause needed).
 *
 * No meshes of its own — it reads the rendered crystal's position from the
 * generator props and drives the DOM overlay.
 */
import * as run from './state.js';
import { RELICS, RELIC_KEYS } from './relics.js';
import { fogGate } from './fog.js';
import { sfx } from './audio.js';
import { showToast } from './loot.js';

const RADIUS = 1.6;
let shrines = [], active = null;

export function spawnShrines(D){
  active = null; hideOverlay();
  const owned = new Set(run.state.relics.map(r=>r.key));
  shrines = D.props.filter(p=>p.kind==='shrineCrystal').map(p=>{
    const pool = RELIC_KEYS.filter(k=>!owned.has(k));       // shuffle for two distinct offers
    for(let j=pool.length-1; j>0; j--){ const k = Math.floor(Math.random()*(j+1)); [pool[j],pool[k]] = [pool[k],pool[j]]; }
    return { x:p.x - D.W/2 + 0.5, z:p.y - D.H/2 + 0.5, ti:p.y*D.W + p.x, used:false, offers:pool.slice(0,2) };
  });
}

export function updateShrines(dt, D, player, t){
  const pp = player.root.position;
  let near = null;
  for(const s of shrines){
    if(s.used) continue;
    if(fogGate(s.ti, t) > 0.5 && Math.hypot(pp.x - s.x, pp.z - s.z) < RADIUS){ near = s; break; }
  }
  if(near && near !== active){ active = near; showOverlay(near); }
  else if(!near && active){ active = null; hideOverlay(); }
}

export const shrineActive = ()=> !!active;

export function selectShrine(i){
  if(!active) return;
  const s = active;
  if(i === 2){                                 // Mend
    run.heal(run.state.maxHp);
    showToast('The shrine mends your wounds.');
  } else {
    const key = s.offers[i];
    if(!key) return;                           // empty card (relic pool exhausted)
    if(run.acquireRelic(key)) showToast('Attuned — ' + RELICS[key].name);
  }
  s.used = true; active = null; hideOverlay(); sfx.pickup();
}

function showOverlay(s){
  const el = document.getElementById('shrine');
  if(!el) return;
  const cards = el.querySelectorAll('.scard');
  [0,1].forEach(i=>{
    const key = s.offers[i], card = cards[i];
    if(key){
      card.style.display = '';
      card.querySelector('.sn').textContent = RELICS[key].name;
      card.querySelector('.sd').textContent = RELICS[key].desc;
    } else card.style.display = 'none';
  });
  el.classList.add('show');
}
function hideOverlay(){ document.getElementById('shrine')?.classList.remove('show'); }

export function shrineStats(){
  return {
    total: shrines.length,
    active: active ? { x:+active.x.toFixed(2), z:+active.z.toFixed(2), offers:active.offers } : null,
    positions: shrines.filter(s=>!s.used).map(s=>({ x:+s.x.toFixed(2), z:+s.z.toFixed(2), ti:s.ti, offers:s.offers })),
  };
}
