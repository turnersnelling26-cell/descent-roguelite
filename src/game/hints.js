/**
 * One-time contextual hints (save.hints). Phase 4 onboarding.
 */
import { markHint, getSave } from './save.js';
import { showToast } from './loot.js';
import * as run from './state.js';
import { hazardStats } from './hazards.js';
import { parkourStats } from './parkour.js';

let floatEl = null, floatTimer = null;

function ensureFloat(){
  if(floatEl) return floatEl;
  floatEl = document.getElementById('floathint');
  return floatEl;
}

export function floatHint(msg, ms = 2800){
  const el = ensureFloat();
  if(!el){ showToast(msg); return; }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(floatTimer);
  floatTimer = setTimeout(()=>el.classList.remove('show'), ms);
}

export function updateHints(player, t){
  if(!player || run.state.dead) return;
  const pp = player.root.position;
  const h = getSave().hints;

  /* pits nearby */
  if(!h.pit){
    const pits = hazardStats().pitPositions || [];
    for(const p of pits){
      if(Math.hypot(pp.x - p.x, pp.z - p.z) < 6){
        if(markHint('pit')) floatHint('C — jump');
        break;
      }
    }
  }

  /* parkour */
  if(!h.parkour){
    const pk = parkourStats();
    if(pk.blocks > 0 && pk.rewards?.length){
      const r = pk.rewards[0];
      if(Math.hypot(pp.x - r.x, pp.z - r.z) < 10){
        if(markHint('parkour')) floatHint('Jump the beams — a prize waits');
      }
    }
  }

  /* seal touch handled in seal.js for accurate barrier proximity */
}

export function hintDashMana(){
  if(markHint('dashMana')){
    floatHint('Dash costs 1 mana');
    document.getElementById('barMana')?.classList.add('flash');
    setTimeout(()=>document.getElementById('barMana')?.classList.remove('flash'), 600);
  }
}

export function hintElite(){
  if(markHint('elite')) floatHint('An empowered foe — greater risk, greater spoils');
}

export const DEATH_TIPS = {
  'a charger': 'Chargers telegraph, then dash straight — step sideways.',
  'a grunt': 'Grunts swarm. Keep moving; swipe when they bunch.',
  'a caster': 'Casters kite and snipe. Close the gap or dash the bolt.',
  'a bomber': 'Bombers swell before exploding — back off during the glow.',
  'a warden': 'Wardens block the front. Flank or use the Warden Spear.',
  'a summoner': 'Kill summoners first — they keep raising grunts.',
  'the boss': 'Bosses escalate by phase. Learn the rhythm, then punish.',
  'the Tyrant': 'The Tyrant remembers your themes. Stay mobile.',
  'a hazard': 'Hazards telegraph. Watch plates, vents, and rings.',
  'an enemy bolt': 'Bolts can be dashed through (i-frames).',
  'an icicle': 'Icicles warn with a ring — move before they drop.',
  'molten vents': 'Fire vents pulse on a beat — step out on the jet.',
  'spores': 'Spore pods swell when you near — burst them from range.',
  'a mimic': 'Warm orange chests bite. Honest gold is cooler.',
};

export function deathTip(cause){
  if(!cause) return 'Rise again — the depths remember.';
  for(const k of Object.keys(DEATH_TIPS)){
    if(cause.includes(k.replace(/^a |^the /, '')) || cause === k) return DEATH_TIPS[k];
  }
  return DEATH_TIPS[cause] || 'Learn the pattern. The next run will be cleaner.';
}
