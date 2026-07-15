/**
 * Door scouting — routing decisions made visible.
 *
 * When the player can see a doorway, a small rune floats over it, tinted by
 * what kind of room lies beyond: violet = elite, gold = treasure,
 * blue = shrine, red = the boss lair. Plain combat rooms stay unmarked.
 * The rune fades once the player actually enters that room — its job is done.
 *
 * Fun rationale (design rulebook): turns "wander until something happens"
 * into a route choice — risk the elite for its altar, detour for treasure,
 * or push for the boss. Anticipation without spoiling discovery: you still
 * must reach the door to learn what's behind it.
 */
import * as THREE from 'three';
import { fogSeen, fogGate, fogRoomEntered } from './fog.js';

const CAP = 20;
const TYPE_COLOR = {
  elite:    0xb17aff,
  treasure: 0xffd27a,
  shrine:   0x8ab4ff,
  boss:     0xff5a5a,
};

let pool = [], markers = [];

export function createScout(scene){
  const geo = new THREE.OctahedronGeometry(0.16, 0);
  for(let i = 0; i < CAP; i++){
    const m = new THREE.Mesh(geo,
      new THREE.MeshBasicMaterial({ color:0xffffff, toneMapped:false, transparent:true, opacity:0.95 }));
    m.visible = false;
    scene.add(m);
    pool.push(m);
  }
}

const TYPE_RANK = { boss:0, elite:1, treasure:2, shrine:3 };

export function spawnScout(D){
  markers = [];
  pool.forEach(m => { m.visible = false; });
  if(!D) return;
  /* gather door tiles per interesting room */
  const byRoom = new Map();
  for(let z = 1; z < D.H - 1; z++) for(let x = 1; x < D.W - 1; x++){
    const i = z*D.W + x;
    if(!D.doorway[i]) continue;
    for(const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const rid = D.roomId[(z+dz)*D.W + (x+dx)];
      if(rid == null || rid < 0) continue;
      const room = D.rooms[rid];
      if(!room || !TYPE_COLOR[room.type]) continue;
      if(!byRoom.has(rid)) byRoom.set(rid, []);
      byRoom.get(rid).push({ ti:i, tx:x, tz:z });
      break;
    }
  }
  /* one rune per door cluster (wide doors span several tiles); rank rooms so
     boss/elite doors always win the pool over a fifth shrine door */
  const cands = [];
  for(const [rid, tiles] of byRoom){
    const type = D.rooms[rid].type;
    const clusters = [];
    for(const t of tiles){
      const c = clusters.find(c => c.some(o => Math.abs(o.tx-t.tx) <= 1 && Math.abs(o.tz-t.tz) <= 1));
      if(c) c.push(t); else clusters.push([t]);
    }
    for(const c of clusters){
      const cx = c.reduce((s,o)=>s+o.tx,0)/c.length, cz = c.reduce((s,o)=>s+o.tz,0)/c.length;
      cands.push({ rid, type, ti: c[0].ti, tx: cx, tz: cz });
    }
  }
  cands.sort((a,b)=>(TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9));
  for(const c of cands.slice(0, CAP)){
    const mesh = pool[markers.length];
    mesh.material.color.set(TYPE_COLOR[c.type]);
    markers.push({
      ti: c.ti, rid: c.rid, type: c.type, mesh,
      x: c.tx - D.W/2 + 0.5, z: c.tz - D.H/2 + 0.5,
      gone: 0,           // 0..1 fade-out after the room is entered
    });
  }
}

export function updateScout(dt, t){
  for(const m of markers){
    if(m.gone >= 1){ m.mesh.visible = false; continue; }
    if(fogRoomEntered(m.rid)) m.gone = Math.min(1, m.gone + dt / 0.8);
    const g = (fogSeen(m.ti) ? fogGate(m.ti, t) : 0) * (1 - m.gone);
    m.mesh.visible = g > 0.02;
    if(!m.mesh.visible) continue;
    m.mesh.position.set(m.x, 1.05 + 0.12*Math.sin(t*2.4 + m.x), m.z);
    m.mesh.rotation.y = t * 1.4;
    m.mesh.scale.setScalar(g * (0.9 + 0.1*Math.sin(t*3 + m.z)));
    m.mesh.material.opacity = 0.95 * g;
  }
}

/** Visible, not-yet-visited markers (minimap + tests). */
export function scoutMarkers(){
  return markers
    .filter(m => m.gone < 1 && m.mesh.visible)
    .map(m => ({ x: m.x, z: m.z, type: m.type }));
}

export const scoutStats = () => ({
  total: markers.length,
  visible: markers.filter(m => m.mesh.visible).length,
  types: markers.reduce((o, m) => { o[m.type] = (o[m.type]||0) + 1; return o; }, {}),
  positions: markers.slice(0, 6).map(m => ({ x:+m.x.toFixed(1), z:+m.z.toFixed(1), type:m.type })),
});
