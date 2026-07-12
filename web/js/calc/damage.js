// ダメージ計算（標準ダメージ式 / Lv50固定）
//
// 修正子の適用順（Gen5+準拠 / 各段で五捨五超入 pokeRound）:
//   base = floor(floor(floor((2*Lv/5+2)*威力*攻撃/防御)/50)+2)
//   → ×複数対象(0.75) → ×天候(1.5/0.5) → ×急所(1.5)
//   → ×乱数(0.85〜1.00, floor) → ×タイプ一致(STAB) → ×タイプ相性(floor)
//   → ×やけど(0.5) → ×その他チェーン(壁/道具/特性/フィールド…)
// ランク補正・ステ変動道具/特性（ハチマキ/チョッキ/きせき等）は呼び出し側で
// 攻撃/防御の実数値に織り込み済みとする。
//
// 一次照合: damekei.com / ポケモン徹底攻略 のダメ計と代表対面で突合。

import { LEVEL } from "./stats.js";

// 五捨五超入: 小数部 > 0.5 のとき切り上げ、それ以外は切り捨て（端数0.5は切り捨て）
function pokeRound(x) {
  return x - Math.floor(x) > 0.5 ? Math.ceil(x) : Math.floor(x);
}

// 防御側タイプ配列に対する効果倍率（chart[攻撃][防御] の積）
export function typeEffectiveness(moveType, defenderTypes, chart) {
  let mult = 1;
  for (const dt of defenderTypes) {
    const row = chart[moveType];
    const v = row ? row[dt] : undefined;
    mult *= v === undefined ? 1 : v;
  }
  return mult;
}

// STAB 倍率: 一致なら 1.5（特性 Adaptability 想定で 2.0 を渡せる）
export function stabMultiplier(moveType, attackerTypes, adaptability = false) {
  if (!attackerTypes.includes(moveType)) return 1;
  return adaptability ? 2.0 : 1.5;
}

// メインのダメージ計算。
// params: { power, atkStat, defStat, stab, typeEff,
//           crit, spread, burn, immune, weatherMult, chainMults[], level }
// 戻り値: { rolls:number[16], min, max, typeEff }
export function computeDamage(params) {
  const {
    power, atkStat, defStat,
    stab = 1, typeEff = 1,
    crit = false, spread = false, burn = false, immune = false,
    weatherMult = 1, chainMults = [], level = LEVEL,
  } = params;

  if (immune || !power || power <= 0 || typeEff === 0) {
    return { rolls: new Array(16).fill(0), min: 0, max: 0, typeEff };
  }

  // 基礎ダメージ
  let base = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * atkStat / defStat) / 50) + 2;

  if (spread) base = pokeRound(base * 0.75);            // 複数対象（ダブル全体技）
  if (weatherMult !== 1) base = pokeRound(base * weatherMult); // 天候（炎/水）
  if (crit) base = pokeRound(base * 1.5);              // 急所

  const rolls = [];
  for (let r = 85; r <= 100; r++) {
    let dmg = Math.floor(base * r / 100);
    dmg = pokeRound(dmg * stab);     // タイプ一致
    dmg = Math.floor(dmg * typeEff); // タイプ相性（整数倍/半減）
    if (burn) dmg = pokeRound(dmg * 0.5); // やけど（物理）
    for (const m of chainMults) {    // その他（壁/道具/特性/フィールド…）
      if (m && m !== 1) dmg = pokeRound(dmg * m);
    }
    rolls.push(Math.max(1, dmg)); // 効果ありなら最低1
  }
  return { rolls, min: rolls[0], max: rolls[rolls.length - 1], typeEff };
}

// ===== 逆算（与ダメ% → 相手の耐久SP推定）用の純粋ヘルパ =====
//
// 観測した割合(observed%)が、ある配分の取り得る割合レンジ[pctMin,pctMax]に
// 収まるか（表示丸め等の許容 tol% を両端に足す）。
export function observedMatches(pctMin, pctMax, observed, tol = 1) {
  return observed >= pctMin - tol && observed <= pctMax + tol;
}

// 観測% がレンジのどちら側に外れているかを返す（UIの助言用）。
//   "below": 観測が小さすぎ = 相手はもっと硬い/半減など想定外
//   "above": 観測が大きすぎ = 相手はもっと柔らかい/こちらの火力が上
//   "in":    レンジ内（許容込み）
export function observedSide(pctMin, pctMax, observed, tol = 1) {
  if (observed < pctMin - tol) return "below";
  if (observed > pctMax + tol) return "above";
  return "in";
}

// 整合した配分の配列 [{hpSP, defSP}] を「HP-SPごとの防御-SP範囲」に畳む。
// 戻り値: { rows:[{hp,defMin,defMax}], hpMin,hpMax, defMin,defMax, totalMin,totalMax, count }
export function scoutBand(combos) {
  if (!combos.length) return { rows: [], hpMin: null, hpMax: null, defMin: null, defMax: null, totalMin: null, totalMax: null, count: 0 };
  const byHp = new Map();
  let hpMin = Infinity, hpMax = -Infinity, defMin = Infinity, defMax = -Infinity, totalMin = Infinity, totalMax = -Infinity;
  for (const c of combos) {
    hpMin = Math.min(hpMin, c.hpSP); hpMax = Math.max(hpMax, c.hpSP);
    defMin = Math.min(defMin, c.defSP); defMax = Math.max(defMax, c.defSP);
    const t = c.hpSP + c.defSP;
    totalMin = Math.min(totalMin, t); totalMax = Math.max(totalMax, t);
    const cur = byHp.get(c.hpSP);
    if (!cur) byHp.set(c.hpSP, [c.defSP, c.defSP]);
    else { cur[0] = Math.min(cur[0], c.defSP); cur[1] = Math.max(cur[1], c.defSP); }
  }
  const rows = [...byHp.entries()].sort((a, b) => a[0] - b[0]).map(([hp, [dmin, dmax]]) => ({ hp, defMin: dmin, defMax: dmax }));
  return { rows, hpMin, hpMax, defMin, defMax, totalMin, totalMax, count: combos.length };
}

// 防御側HPに対するダメージ割合と確定数の要約。
// maxHp=最大HP実数値、currentHp=現在HP（残りHP指定。既定は満タン）。
// 割合は最大HP基準、確定数は現在HP基準で評価。
export function summarize(rolls, maxHp, currentHp = maxHp) {
  const min = rolls[0], max = rolls[rolls.length - 1];
  const pctMin = (min / maxHp) * 100;
  const pctMax = (max / maxHp) * 100;
  const hp = currentHp || maxHp;
  const CAP = 16;
  let guaranteed = null; // 最小乱数でHP以上になる発数（確定数）
  let possible = null;   // 最大乱数でHP以上になる発数
  for (let n = 1; n <= CAP; n++) {
    if (possible === null && max * n >= hp) possible = n;
    if (guaranteed === null && min * n >= hp) guaranteed = n;
  }
  let label;
  if (max === 0) label = "ダメージなし";
  else if (guaranteed === null) label = `${CAP}発でも倒せない`;
  else if (guaranteed === possible) label = `確定${guaranteed}発`;
  else if (possible === null) label = `確定${guaranteed}発`;
  else label = `乱数${possible}発（確定${guaranteed}発）`;
  return { min, max, pctMin, pctMax, guaranteed, possible, label };
}
