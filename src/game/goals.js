/**
 * Floor discovery goals — secondary objectives beyond kill-clear.
 * Fun is learning + interesting decisions: each theme teaches a pattern,
 * optional goals reward exploration without gating the boss.
 */
import * as run from './state.js';
import { showToast } from './loot.js';
import { parkourStats } from './parkour.js';
import { shrineStats } from './shrines.js';
import { fogStats } from './fog.js';
import { sfx } from './audio.js';

const THEME_GOAL = {
  ancient: { label: 'Ancient: escape 2 rune snares', need: 2 },
  molten:  { label: 'Molten: vent-kill 2 foes', need: 2 },
  frost:   { label: 'Frost: dodge 3 icicles', need: 3 },
  grim:    { label: 'Grim: survive 2 wisp sips', need: 2 },
  verdant: { label: 'Verdant: burst 2 spore pods', need: 2 },
};

let goals = [];
let themeKey = '';
let mazeAvailable = true;

function mk(id, label, need = 1){
  return { id, label, need, have: 0, done: false, claimed: false };
}

export function resetGoals(D, theme){
  themeKey = theme || D?.params?.themeKey || 'ancient';
  const tg = THEME_GOAL[themeKey] || THEME_GOAL.ancient;
  mazeAvailable = true;
  goals = [
    mk('maze', 'Claim the maze prize', 1),
    mk('shrine', 'Choose a shrine boon', 1),
    mk('explore', 'Reveal 55% of the floor', 55),
    mk('theme', tg.label, tg.need),
  ];
}

function grantReward(g){
  if(g.claimed) return;
  g.claimed = true;
  const gold = 12 + run.state.floor * 4;
  run.state.gold += gold;
  /* small XP without forcing a mid-combat level-up spam */
  run.state.xp = (run.state.xp || 0) + 1;
  if(run.state.xp >= run.state.xpNext){
    /* defer level-up via existing kill path semantics: leave at threshold-1
       so the next kill/chest still feels like the level-up trigger */
    run.state.xp = Math.max(0, run.state.xpNext - 1);
  }
  run.renderHud();
  showToast('Goal · ' + g.label + '  +' + gold + 'g');
  sfx.pickup();
}

export function noteGoal(id, amount = 1){
  const g = goals.find(x => x.id === id);
  if(!g || g.done) return;
  g.have = Math.min(g.need, g.have + amount);
  if(g.have >= g.need){
    g.done = true;
    grantReward(g);
  }
}

export function noteMazePrize(){ noteGoal('maze', 1); }
export function noteShrineChoice(){ noteGoal('shrine', 1); }

export function noteThemeProgress(kind, amount = 1){
  if(kind && kind !== themeKey) return;
  noteGoal('theme', amount);
}

export function updateGoals(D){
  if(!D || !goals.length) return;

  const fs = fogStats();
  const explored = fs.total > 0 ? Math.floor(100 * fs.tiles / fs.total) : 0;
  const eg = goals.find(g => g.id === 'explore');
  if(eg && !eg.done){
    eg.have = Math.min(eg.need, explored);
    if(eg.have >= eg.need){ eg.done = true; grantReward(eg); }
  }

  const pk = parkourStats();
  if(pk.rooms === 0) mazeAvailable = false;
  else if((pk.prizesTaken || 0) > 0 || (pk.rooms > 0 && pk.rewardsLeft === 0))
    noteGoal('maze', 1);

  const ss = shrineStats();
  if(ss && ss.total > 0){
    const unused = (ss.positions || []).length;
    if(unused < ss.total) noteGoal('shrine', 1);
  }
}

export function goalsSummary(){
  const list = goals.filter(g => {
    if(g.id === 'maze' && !mazeAvailable) return false;
    return true;
  });
  const done = list.filter(g => g.done).length;
  return {
    goals: list,
    done,
    total: list.length,
    short: done + '/' + list.length + ' side goals',
    line: list.map(g => {
      const mark = g.done ? '✓' : '·';
      const prog = g.need > 1 && !g.done ? ` ${g.have}/${g.need}` : '';
      return mark + ' ' + g.label + prog;
    }).join(' · '),
  };
}

export function themeGoalHint(theme){
  const t = THEME_GOAL[theme] || THEME_GOAL.ancient;
  return t.label;
}
