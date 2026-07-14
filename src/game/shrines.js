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
import { gShuffle } from './rng.js';
import { noteShrine } from './save.js';

const RADIUS = 1.6;
let shrines = [], active = null;

export function spawnShrines(D){
  active = null; hideOverlay();
  const owned = new Set(run.state.relics.map(r=>r.key));
  let props = D.props.filter(p=>p.kind==='shrineCrystal');
  /* heat: scarce shrines — drop one per floor */
  if(run.state.heatFlags?.scarce && props.length > 1) props = props.slice(0, props.length - 1);
  const nOffer = run.state.mods.shrineTriple ? 3 : 2;
  shrines = props.map(p=>{
    const pool = RELIC_KEYS.filter(k=>!owned.has(k));
    gShuffle(pool);
    return { x:p.x - D.W/2 + 0.5, z:p.y - D.H/2 + 0.5, ti:p.y*D.W + p.x, used:false, offers:pool.slice(0, nOffer) };
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
  const triple = !!run.state.mods.shrineTriple;
  if(!triple && i === 2){
    run.heal(run.state.maxHp);
    showToast('The shrine mends your wounds.');
  } else {
    const key = s.offers[i];
    if(!key) return;
    if(run.acquireRelic(key)) showToast('Attuned — ' + RELICS[key].name);
  }
  s.used = true; active = null; hideOverlay(); noteShrine(); sfx.pickup();
}

function showOverlay(s){
  const el = document.getElementById('shrine');
  if(!el) return;
  const cards = el.querySelectorAll('.scard');
  const triple = !!run.state.mods.shrineTriple;
  [0,1,2].forEach(i=>{
    const card = cards[i];
    if(!card) return;
    if(!triple && i === 2){
      card.style.display = '';
      card.classList.add('mend');
      card.querySelector('.sn').textContent = 'Mend';
      card.querySelector('.sd').textContent = 'Restore all health';
      return;
    }
    const key = s.offers[i];
    if(key){
      card.style.display = '';
      card.classList.toggle('mend', false);
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
