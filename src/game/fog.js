/**
 * Fog of war — the dungeon starts hidden and reveals permanently as the
 * player explores: whole rooms on first entry (plus their wall ring), and a
 * small radius around the player for corridors.
 *
 * Visibility is a per-instance SCALE gate (matrix writes, mirroring the build
 * reveal in writeInstances), never instanceColor — so it can't fight the
 * difficulty-heatmap tinting. Steady state costs nothing per frame; matrices
 * are only rewritten during a short window after something new is revealed.
 */
import * as THREE from 'three';

const REVEAL_R = 7;     // corridor reveal radius around the player, in tiles
const GROW = 0.35;      // seconds a newly seen tile takes to grow in

let W = 0, H = 0;
let seenAt = null;      // Float32Array(W*H): -1 unseen, else elapsed time revealed
let roomSeen = null;    // Uint8Array(rooms)
let enabled = true;     // user toggle
let active = false;     // false during build animation / before first level

export function fogEnabled(){ return enabled; }

export function fogReset(D, t){
  W = D.W; H = D.H;
  seenAt = new Float32Array(W*H).fill(enabled ? -1 : 0);
  roomSeen = new Uint8Array(D.rooms.length);
  if(!enabled) roomSeen.fill(1);
  active = true;
}
export function fogSuspend(){ active = false; }   // during forge/build animation

const stamp = (i, t)=>{ if(seenAt[i] < 0){ seenAt[i] = t; return true; } return false; };

/* reveal around a world position; whole room (+wall ring) on first entry */
export function fogMark(D, wxp, wzp, t){
  if(!active || !enabled) return false;
  let fresh = false;
  const px = Math.floor(wxp + W/2), pz = Math.floor(wzp + H/2);
  const r = Math.ceil(REVEAL_R);
  for(let dz=-r; dz<=r; dz++) for(let dx=-r; dx<=r; dx++){
    if(dx*dx + dz*dz > REVEAL_R*REVEAL_R) continue;
    const x = px+dx, z = pz+dz;
    if(x>=0 && z>=0 && x<W && z<H && stamp(z*W+x, t)) fresh = true;
  }
  const rid = (px>=0 && pz>=0 && px<W && pz<H) ? D.roomId[pz*W+px] : -1;
  if(rid >= 0 && !roomSeen[rid]){
    roomSeen[rid] = 1;
    for(let z=0; z<H; z++) for(let x=0; x<W; x++){
      if(D.roomId[z*W+x] !== rid) continue;
      for(let dz=-1; dz<=1; dz++) for(let dx=-1; dx<=1; dx++){   // tile + wall ring
        const nx = x+dx, nz = z+dz;
        if(nx>=0 && nz>=0 && nx<W && nz<H && stamp(nz*W+nx, t)) fresh = true;
      }
    }
  }
  return fresh;
}

/* per-instance visibility: 0 hidden → eased 1 over GROW seconds once seen */
const easeOutCubic = t => 1-Math.pow(1-t,3);
export function fogGate(ti, t){
  if(!active || !enabled || !seenAt) return 1;
  const s = seenAt[ti];
  if(s < 0) return 0;
  const k = (t - s) / GROW;
  return k >= 1 ? 1 : easeOutCubic(Math.max(k, 0));
}
export const fogSeen = ti => !active || !enabled || !seenAt || seenAt[ti] >= 0;

/** True once the player has actually stood inside room `rid` (not merely
    glimpsed its tiles from a corridor). Scout runes retire on entry. */
export const fogRoomEntered = rid =>
  !active || !enabled || !roomSeen || (rid >= 0 && roomSeen[rid] === 1);

/* mirror of writeInstances, with the fog gate folded into the authored scale */
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(),
      _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _E = new THREE.Euler();
export function fogWrite(mesh, t){
  const u = mesh.userData, s = u.set;
  if(!s.ti) return;
  for(let i=0; i<s.n; i++){
    const g = Math.max(fogGate(s.ti[i], t), 0.0001);
    _q.setFromEuler(_E.set(s.rx[i], s.ry[i], s.rz[i]));
    _p.set(s.px[i], s.py[i], s.pz[i]);
    /* hidden instances collapse on ALL axes — a rise-mode wall squashed only
       in Y still renders its footprint as a flat outline, leaking the layout */
    if(u.mode==='rise' && g > 0.02) _s.set(s.sx[i], s.sy[i]*g, s.sz[i]);
    else                            _s.set(s.sx[i]*g, s.sy[i]*g, s.sz[i]*g);
    _m.compose(_p,_q,_s); mesh.setMatrixAt(i,_m);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

/* user toggle: off = all seen; on = back to only what's around the player */
export function setFogEnabled(on, D, wxp, wzp, t){
  enabled = on;
  if(!active || !seenAt || !D) return;   // mid-build: fogReset at finishAnim picks it up
  if(!on){ seenAt.fill(0); roomSeen.fill(1); }
  else { fogReset(D, t); fogMark(D, wxp, wzp, t); }
}

export function fogStats(){
  if(!seenAt) return { enabled, active, rooms:0, tiles:0, total:0 };
  let tiles = 0; for(let i=0;i<seenAt.length;i++) if(seenAt[i]>=0) tiles++;
  let rooms = 0; for(let i=0;i<roomSeen.length;i++) rooms += roomSeen[i];
  return { enabled, active, rooms, tiles, total:seenAt.length };
}
