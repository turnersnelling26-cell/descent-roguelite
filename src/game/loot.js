/**
 * Pickups — two kinds, both fog-gated and repositioned per forge:
 *   • heal orbs   — a glowing gold orb over each treasure-room chest; walking in
 *                   heals 2 hearts and bumps the chest counter.
 *   • weapon tokens — a floating gem in the richest treasure/elite rooms; walking
 *                   in equips that weapon and flashes a toast.
 * Meshes live on the scene (survive disposeLevel) and are placed by spawnLoot().
 */
import * as THREE from 'three';
import { fogGate } from './fog.js';
import * as run from './state.js';
import { sfx } from './audio.js';
import { WEAPONS } from './weapons.js';

const POOL = 6, WPN_POOL = 4, COLLECT_R = 0.8, WPN_COLLECT_R = 0.9, HEAL = 2, POP = 0.3;
const WEAPON_DROPS = ['hammer', 'wand'];        // starter (blade) is equipped; these are found

let orbs = [], items = [], collected = 0;
let wpnMeshes = [], wpnItems = [], toastTimer = null;

export function createLoot(scene){
  const geo = new THREE.OctahedronGeometry(0.22);
  for(let i=0; i<POOL; i++){
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color:0xffd27a, toneMapped:false, transparent:true, opacity:0.95 }));
    m.visible = false;
    scene.add(m);
    orbs.push(m);
  }
  const wgeo = new THREE.IcosahedronGeometry(0.3, 0);
  for(let i=0; i<WPN_POOL; i++){
    const m = new THREE.Mesh(wgeo, new THREE.MeshBasicMaterial({
      color:0xffffff, toneMapped:false, transparent:true, opacity:0.96 }));
    m.visible = false;
    scene.add(m);
    wpnMeshes.push(m);
  }
}

export function showToast(msg){
  const el = document.getElementById('toast');
  if(!el) return;
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 2200);
}

export function spawnLoot(D){
  items = D.props.filter(p=>p.kind==='chest').slice(0, POOL).map((p,i)=>({
    x: p.x - D.W/2 + 0.5, z: p.y - D.H/2 + 0.5,
    ti: p.y*D.W + p.x, taken: false, takenAt: 0, ph: i*1.9, orb: orbs[i],
  }));
  collected = 0;
  orbs.forEach(o=>{ o.visible = false; o.scale.setScalar(1); });
  run.setChestTotal(items.length);

  /* weapon tokens in the richest treasure/elite rooms, hardest first */
  wpnMeshes.forEach(m=>{ m.visible = false; m.scale.setScalar(1); });
  const rooms = D.rooms.filter(r=>r.type==='treasure' || r.type==='elite')
    .sort((a,b)=>b.difficulty - a.difficulty);
  wpnItems = [];
  for(let i=0; i<WEAPON_DROPS.length && i<rooms.length && i<WPN_POOL; i++){
    const r = rooms[i], w = WEAPONS[WEAPON_DROPS[i]];
    wpnMeshes[i].material.color.set(w.color);
    wpnItems.push({
      x: r.cx - D.W/2 + 0.5, z: r.cy - D.H/2 + 0.5,
      ti: Math.round(r.cy)*D.W + Math.round(r.cx),
      key: WEAPON_DROPS[i], name: w.name,
      taken: false, takenAt: 0, ph: i*2.1, mesh: wpnMeshes[i],
    });
  }
}

export function updateLoot(dt, D, player, t){
  const pp = player.root.position;
  for(const it of items){
    const o = it.orb;
    if(it.taken){                               // pop-out animation, then gone
      const k = (t - it.takenAt) / POP;
      if(k >= 1){ o.visible = false; continue; }
      o.scale.setScalar(1 + k*1.6);
      o.material.opacity = 0.95*(1 - k);
      continue;
    }
    const g = fogGate(it.ti, t);                // hidden until the room reveals
    o.visible = g > 0.01;
    if(!o.visible) continue;
    o.position.set(it.x, 1.1 + 0.1*Math.sin(t*2.4 + it.ph), it.z);
    o.rotation.y = t*1.4 + it.ph;
    o.scale.setScalar(g);
    o.material.opacity = 0.95;
    if(g >= 0.99 && Math.hypot(pp.x - it.x, pp.z - it.z) < COLLECT_R){
      it.taken = true; it.takenAt = t; collected++;
      run.collectChest(HEAL);
      sfx.pickup();
    }
  }

  for(const it of wpnItems){
    const m = it.mesh;
    if(it.taken){
      const k = (t - it.takenAt) / POP;
      if(k >= 1){ m.visible = false; continue; }
      m.scale.setScalar(1 + k*1.8);
      m.material.opacity = 0.96*(1 - k);
      continue;
    }
    const g = fogGate(it.ti, t);
    m.visible = g > 0.01;
    if(!m.visible) continue;
    m.position.set(it.x, 1.25 + 0.14*Math.sin(t*2.0 + it.ph), it.z);
    m.rotation.set(t*0.8, t*1.1 + it.ph, 0);
    m.scale.setScalar(g);
    m.material.opacity = 0.96;
    if(g >= 0.99 && Math.hypot(pp.x - it.x, pp.z - it.z) < WPN_COLLECT_R){
      it.taken = true; it.takenAt = t;
      run.equipWeapon(it.key);
      sfx.pickup();
      showToast('Found the ' + it.name + '!');
    }
  }
}

export function lootStats(){
  return { total: items.length, collected,
           remaining: items.filter(i=>!i.taken).map(i=>({x:+i.x.toFixed(2), z:+i.z.toFixed(2)})),
           weapons: wpnItems.filter(i=>!i.taken).map(i=>({x:+i.x.toFixed(2), z:+i.z.toFixed(2), key:i.key})) };
}
