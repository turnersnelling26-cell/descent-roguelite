/**
 * Cursed altars — elite rooms, floor 3+, once unlocks.altars (floor-4 milestone).
 * One cursed relic offer; take (1) or walk away.
 */
import * as THREE from 'three';
import * as run from './state.js';
import { RELICS, CURSE_KEYS } from './relics.js';
import { fogGate } from './fog.js';
import { gPick } from './rng.js';
import { getSave } from './save.js';
import { sfx } from './audio.js';
import { showToast } from './loot.js';

const RADIUS = 1.5;
let altars = [], active = null, meshPool = [];

export function createAltars(scene){
  for(let i = 0; i < 4; i++){
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, 0.7, 6),
      new THREE.MeshBasicMaterial({ color:0x6a2040, toneMapped:false, transparent:true, opacity:0.9 })
    );
    m.visible = false;
    scene.add(m);
    meshPool.push(m);
  }
}

export function spawnAltars(D){
  active = null; hideOverlay();
  altars = [];
  meshPool.forEach(m => { m.visible = false; });
  if(!getSave().unlocks.altars || run.state.floor < 3) return;

  const elites = D.rooms.filter(r => r.type === 'elite');
  for(let i = 0; i < elites.length && i < meshPool.length; i++){
    const r = elites[i];
    const curse = gPick(CURSE_KEYS);
    const a = {
      x: r.cx - D.W/2 + 0.5,
      z: r.cy - D.H/2 + 0.5,
      ti: Math.round(r.cy) * D.W + Math.round(r.cx),
      key: curse,
      used: false,
      mesh: meshPool[i],
    };
    a.mesh.position.set(a.x, 0.35, a.z);
    altars.push(a);
  }
}

export function updateAltars(dt, D, player, t){
  const pp = player.root.position;
  let near = null;
  for(const a of altars){
    const g = fogGate(a.ti, t);
    a.mesh.visible = !a.used && g > 0.01;
    if(a.used || !a.mesh.visible) continue;
    a.mesh.rotation.y = t * 0.6;
    a.mesh.scale.setScalar(g);
    if(g >= 0.99 && Math.hypot(pp.x - a.x, pp.z - a.z) < RADIUS) near = a;
  }
  if(near && near !== active){ active = near; showOverlay(near); }
  else if(!near && active){ active = null; hideOverlay(); }
}

export function altarActive(){ return !!active; }

export function selectAltar(take){
  if(!active) return;
  if(take){
    const key = active.key;
    if(run.acquireRelic(key)) showToast('Cursed — ' + RELICS[key].name);
    sfx.hurt();
  } else {
    showToast('You walk away from the altar.');
  }
  active.used = true; active.mesh.visible = false;
  active = null; hideOverlay();
}

function showOverlay(a){
  const el = document.getElementById('altar');
  if(!el) return;
  const r = RELICS[a.key];
  el.querySelector('.sn').textContent = r.name;
  el.querySelector('.sd').textContent = r.desc;
  el.classList.add('show');
}
function hideOverlay(){ document.getElementById('altar')?.classList.remove('show'); }

export const altarStats = () => ({
  total: altars.length,
  remaining: altars.filter(a => !a.used).length,
});
