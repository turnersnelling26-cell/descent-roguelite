/**
 * Pickups — chests (mimic tell) + weapon tokens (prompt to swap, never lost).
 */
import * as THREE from 'three';
import { fogGate } from './fog.js';
import * as run from './state.js';
import { sfx } from './audio.js';
import { WEAPONS, droppableWeapons } from './weapons.js';
import { spawnMimicPack } from './enemies.js';
import { gChance, gShuffle } from './rng.js';
import { noteChest, noteMimic, getSave, markHint } from './save.js';

const POOL = 6, WPN_POOL = 6, COLLECT_R = 0.8, WPN_NEAR = 1.15, HEAL = 2, POP = 0.3;
const HONEST = 0xffd27a, MIMIC = 0xff9a66;

let orbs = [], items = [], collected = 0;
let wpnMeshes = [], wpnItems = [], toastTimer = null;
let activeWeapon = null;

export function createLoot(scene){
  const geo = new THREE.OctahedronGeometry(0.22);
  for(let i=0; i<POOL; i++){
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color:HONEST, toneMapped:false, transparent:true, opacity:0.95 }));
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

function weaponDropPool(){
  return gShuffle(droppableWeapons(getSave().unlocks));
}

function mimicRate(){
  if(run.state.heatFlags?.fickle) return 0.35;
  return 0.2;
}

export function spawnLoot(D){
  activeWeapon = null; hideWeaponPrompt();
  const rate = mimicRate();
  items = D.props.filter(p=>p.kind==='chest').slice(0, POOL).map((p,i)=>({
    x: p.x - D.W/2 + 0.5, z: p.y - D.H/2 + 0.5,
    ti: p.y*D.W + p.x, taken: false, takenAt: 0, ph: i*1.9, orb: orbs[i],
    mimic: gChance(rate),
    twitchAt: 0,
  }));
  collected = 0;
  orbs.forEach(o=>{ o.visible = false; o.scale.setScalar(1); });
  run.setChestTotal(items.length);

  wpnMeshes.forEach(m=>{ m.visible = false; m.scale.setScalar(1); });
  const rooms = D.rooms.filter(r=>r.type==='treasure' || r.type==='elite')
    .sort((a,b)=>b.difficulty - a.difficulty);
  const drops = weaponDropPool();
  wpnItems = [];
  for(let i=0; i<drops.length && i<rooms.length && i<WPN_POOL; i++){
    const r = rooms[i], key = drops[i], w = WEAPONS[key];
    if(!w) continue;
    wpnMeshes[i].material.color.set(w.color);
    wpnItems.push({
      x: r.cx - D.W/2 + 0.5, z: r.cy - D.H/2 + 0.5,
      ti: Math.round(r.cy)*D.W + Math.round(r.cx),
      key, name: w.name,
      taken: false, takenAt: 0, ph: i*2.1, mesh: wpnMeshes[i],
    });
  }
}

export function updateLoot(dt, D, player, t){
  const pp = player.root.position;
  for(const it of items){
    const o = it.orb;
    if(it.taken){
      const k = (t - it.takenAt) / POP;
      if(k >= 1){ o.visible = false; continue; }
      o.scale.setScalar(1 + k*1.6);
      o.material.opacity = 0.95*(1 - k);
      continue;
    }
    const g = fogGate(it.ti, t);
    o.visible = g > 0.01;
    if(!o.visible) continue;
    /* mimic tell: warm tint, slight scale twitch, learnable */
    const col = it.mimic ? MIMIC : HONEST;
    o.material.color.set(col);
    let sc = g;
    if(it.mimic){
      if(t - it.twitchAt > 2.2){ it.twitchAt = t; }
      const twitch = (t - it.twitchAt < 0.15) ? 1.06 : 1.0;
      sc *= twitch;
      /* faint hum within 4 tiles — learnable Discovery micro-skill */
      const dMim = Math.hypot(pp.x - it.x, pp.z - it.z);
      if(dMim < 4 && g >= 0.5){
        if(!it.humAt || t - it.humAt > 1.4){ it.humAt = t; sfx.mimicHum(); }
      }
    }
    o.position.set(it.x, 1.1 + 0.1*Math.sin(t*2.4 + it.ph), it.z);
    o.rotation.y = t*1.4 + it.ph;
    o.scale.setScalar(sc);
    o.material.opacity = 0.95;
    if(g >= 0.99 && Math.hypot(pp.x - it.x, pp.z - it.z) < COLLECT_R){
      it.taken = true; it.takenAt = t; collected++;
      if(it.mimic){
        spawnMimicPack(it.x, it.z, it.ti, D);
        noteMimic();
        showToast('A mimic!');
        sfx.hurt();
      } else {
        run.collectChest(HEAL);
        noteChest();
        sfx.pickup();
      }
    }
  }

  let near = null;
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
    if(g >= 0.99 && Math.hypot(pp.x - it.x, pp.z - it.z) < WPN_NEAR) near = it;
  }

  if(near && near !== activeWeapon){
    activeWeapon = near;
    showWeaponPrompt(near);
    markHint('weaponSwap');
  } else if(!near && activeWeapon){
    activeWeapon = null;
    hideWeaponPrompt();
  }
}

/** Press 1 near a token: equip it; current weapon becomes this token. */
export function takeWeapon(){
  if(!activeWeapon || activeWeapon.taken) return false;
  const it = activeWeapon;
  const prev = run.state.weaponKey;
  const prevW = WEAPONS[prev];
  run.equipWeapon(it.key);
  /* drop previous weapon on the ground as this token */
  it.key = prev;
  it.name = prevW.name;
  it.mesh.material.color.set(prevW.color);
  activeWeapon = null;
  hideWeaponPrompt();
  sfx.pickup();
  showToast('Took the ' + WEAPONS[run.state.weaponKey].name + ' (1 to swap back)');
  return true;
}

export function weaponPromptActive(){ return !!activeWeapon; }

function showWeaponPrompt(it){
  const el = document.getElementById('wpnprompt');
  if(!el) return;
  el.querySelector('.wn').textContent = it.name;
  el.querySelector('.wd').textContent = '1 take · walk away to keep yours · swaps never lost';
  el.classList.add('show');
}
function hideWeaponPrompt(){ document.getElementById('wpnprompt')?.classList.remove('show'); }

export function lootStats(){
  return { total: items.length, collected,
           remaining: items.filter(i=>!i.taken).map(i=>({x:+i.x.toFixed(2), z:+i.z.toFixed(2), mimic:!!i.mimic})),
           weapons: wpnItems.filter(i=>!i.taken).map(i=>({x:+i.x.toFixed(2), z:+i.z.toFixed(2), key:i.key})) };
}
