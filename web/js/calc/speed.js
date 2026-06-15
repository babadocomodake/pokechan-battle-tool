// すばやさ計算と素早さ順テーブル
import { calcStat, SP_MAX_PER_STAT } from "./stats.js";
import { stageMultiplier } from "./stages.js";

// ランク補正は calc/stages.js に共通化（後方互換のため再エクスポート）。
export { stageMultiplier };

// すばやさへの補正適用（適用ごとに切り捨て）。
// mods = { stage:0..6, scarf:bool, paralysis:bool }
// isMega: メガシンカ個体はメガストーン固定のため、こだわりスカーフを持てない（無効）。
export function applySpeedMods(speed, mods = {}, isMega = false) {
  let s = speed;
  if (mods.stage) s = Math.floor(s * stageMultiplier(mods.stage));
  if (mods.scarf && !isMega) s = Math.floor(s * 1.5); // こだわりスカーフ
  if (mods.paralysis) s = Math.floor(s * 0.5);        // まひ
  return s;
}

// 代表的なすばやさ実数値
export function speedPresets(baseSpe) {
  return {
    max: calcStat(baseSpe, SP_MAX_PER_STAT, "spe", 1.1),   // 最速（SP32+性格補正↑）
    fast: calcStat(baseSpe, SP_MAX_PER_STAT, "spe", 1.0),  // 準速（SP32無補正）
    none: calcStat(baseSpe, 0, "spe", 1.0),                // 無振り
    minus: calcStat(baseSpe, 0, "spe", 0.9),               // 下降無振り
  };
}

// 合法ポケモンの素早さ順テーブル。mods は全体に適用する補正。
// 戻り値: [{name, nameJp, baseSpe, max, fast, none, types, isMega}] を max 降順でソート。
export function buildSpeedTable(pokemonList, mods = {}) {
  const rows = pokemonList.map((p) => {
    const isMega = p.form === "Mega";
    const ps = speedPresets(p.base.spe);
    return {
      name: p.name,
      nameJp: p.nameJp,
      types: p.types,
      isMega,
      usageRankSingle: p.usageRankSingle ?? null,
      baseSpe: p.base.spe,
      max: applySpeedMods(ps.max, mods, isMega),
      fast: applySpeedMods(ps.fast, mods, isMega),
      none: applySpeedMods(ps.none, mods, isMega),
    };
  });
  rows.sort((a, b) => b.max - a.max || b.baseSpe - a.baseSpe);
  return rows;
}
