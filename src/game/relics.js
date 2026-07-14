/**
 * Relic registry — passives from shrines; cursed relics from altars.
 * Fields: hp/mana, mod{}, special flags read by systems, curse:true for HUD.
 */
export const RELICS = {
  /* original nine (scry reworked) */
  ironheart: { name:'Ironheart',           desc:'+2 max health',                 hp:2, tag:'defense' },
  well:      { name:'Deep Well',            desc:'+2 max mana, swift regen',      mana:2, mod:{ manaRegenMul:1.6 }, tag:'wand' },
  fang:      { name:'Vampiric Fang',        desc:'Kills heal 1 heart',            mod:{ lifesteal:1 }, tag:'combat' },
  boots:     { name:'Swift Boots',          desc:'+20% speed, faster dash',       mod:{ moveMul:1.2, dashCdMul:0.7 }, tag:'mobility' },
  lens:      { name:'Focusing Lens',        desc:'+1 weapon damage',              mod:{ dmgBonus:1 }, tag:'combat' },
  bramble:   { name:'Bramble Heart',        desc:'Attackers take 1 damage',       mod:{ thorns:1 }, tag:'defense' },
  emberward: { name:'Ember Ward',           desc:'Longer dash i-frames',          mod:{ iframeBonus:0.16 }, tag:'mobility' },
  hunter:    { name:"Hunter's Mark",        desc:'+30% attack speed',             mod:{ atkCdMul:0.7 }, tag:'combat' },
  scry:      { name:"Cartographer's Orb",   desc:'F: pulse map pings (20s). Fog stays.', mod:{}, tag:'discovery', mapPulse:true },

  /* Phase 3 expansions */
  execute:   { name:"Executioner's Edge",  desc:'Foes below 25% HP die to any hit', mod:{ execute:0.25 }, tag:'combat' },
  static:    { name:'Static Charge',       desc:'Every 4th strike arcs 1 dmg nearby', mod:{ staticEvery:4 }, tag:'combat' },
  lucky:     { name:'Lucky Coin',          desc:'+10% crit chance',               mod:{ critBonus:0.10 }, tag:'combat' },
  berserk:   { name:'Berserker Bead',      desc:'+2 dmg at ≤2 HP',                mod:{ lowHpDmg:2 }, tag:'combat' },
  siphon:    { name:'Siphon Core',         desc:'Bolt kills refund 1 mana',       mod:{ boltMana:1 }, tag:'wand' },
  stoneskin: { name:'Stone Skin',          desc:'Negate one hit every 12s',       mod:{ stoneSkinCd:12 }, tag:'defense' },
  second:    { name:'Second Wind',         desc:'Once per floor, fatal hit → 1 HP', mod:{ secondWind:1 }, tag:'defense' },
  bulwark:   { name:'Bulwark Sigil',       desc:'Charger/boss hits −1 (min 1)',   mod:{ bulwark:1 }, tag:'defense' },
  cleanse:   { name:'Cleansing Charm',     desc:'Immune to root & slow',          mod:{ cleanse:1 }, tag:'defense' },
  feather:   { name:'Featherfall',         desc:'Pits reposition, deal 0',        mod:{ featherfall:1 }, tag:'mobility' },
  stride:    { name:'Long Stride',         desc:'Dash +40% distance',             mod:{ dashDistMul:1.4 }, tag:'mobility' },
  echo:      { name:'Echo Step',           desc:'Dash leaves a 1.5s decoy',       mod:{ echoStep:1 }, tag:'mobility' },
  nose:      { name:"Prospector's Nose",   desc:'Heart drops 8% → 14%',           mod:{ heartChance:0.14 }, tag:'economy' },
  merchant:  { name:"Merchant's Ring",     desc:'Wayshop −25% prices',            mod:{ shopMul:0.75 }, tag:'economy' },
  greedy:    { name:'Greedy Idol',         desc:'+50% combo gold, shorter window', mod:{ comboGoldMul:1.5, comboWindow:2 }, tag:'economy' },

  /* cursed (altars only) */
  glass:     { name:'Glass Cannon',        desc:'+3 dmg, −2 max HP',              mod:{ dmgBonus:3 }, hp:-2, curse:true, tag:'curse' },
  gambler:   { name:"Gambler's Die",       desc:'Gold gains roll 50–200%',        mod:{ goldGamble:1 }, curse:true, tag:'curse' },
  crown:     { name:'Heavy Crown',         desc:'Shrines offer 3, −10% move',     mod:{ moveMul:0.9, shrineTriple:1 }, curse:true, tag:'curse' },
  bloodpact: { name:'Blood Pact',          desc:'Kills heal 1; chests stop healing', mod:{ lifesteal:1, noChestHeal:1 }, curse:true, tag:'curse' },
};

export const RELIC_KEYS = Object.keys(RELICS).filter(k => !RELICS[k].curse);
export const CURSE_KEYS = Object.keys(RELICS).filter(k => RELICS[k].curse);
export const ALL_RELIC_KEYS = Object.keys(RELICS);
