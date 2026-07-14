/**
 * Relic registry — pure data, no imports. Relics are passive run modifiers
 * found at shrines; state.js/acquireRelic() interprets these fields:
 *   hp / mana   — immediate +max (and heal by the same amount)
 *   mod{...}    — merged into state.mods; multiplicative keys (see MULT in
 *                 state.js) multiply, the rest add.
 * Effects are read by player.js (movement/dash) and enemies.js (attacks),
 * plus state.tickRegen (mana). One of each per run (shrines never re-offer one
 * you already hold).
 */
export const RELICS = {
  ironheart: { name:'Ironheart',      desc:'+2 max health',            hp:2 },
  well:      { name:'Deep Well',       desc:'+2 max mana, swift regen', mana:2, mod:{ manaRegenMul:1.6 } },
  fang:      { name:'Vampiric Fang',   desc:'Kills heal 1 heart',       mod:{ lifesteal:1 } },
  boots:     { name:'Swift Boots',     desc:'+20% speed, faster dash',  mod:{ moveMul:1.2, dashCdMul:0.7 } },
  lens:      { name:'Focusing Lens',   desc:'+1 weapon damage',         mod:{ dmgBonus:1 } },
  bramble:   { name:'Bramble Heart',   desc:'Attackers take 1 damage',  mod:{ thorns:1 } },
  emberward: { name:'Ember Ward',      desc:'Longer dash i-frames',     mod:{ iframeBonus:0.16 } },
  hunter:    { name:"Hunter's Mark",   desc:'+30% attack speed',        mod:{ atkCdMul:0.7 } },
  scry:      { name:'Scrying Orb',     desc:'Press F to lift the fog',  mod:{} },
};

export const RELIC_KEYS = Object.keys(RELICS);
