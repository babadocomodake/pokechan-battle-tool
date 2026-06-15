// ステータス計算（ポケモンチャンピオンズ仕様）
//
// 確定仕様（mechanics/stat-formula.md + 複数の検証情報源）:
//   - レベルは 50 固定、個体値(IV)は全て 31 固定。
//   - 能力ポイント(SP): 各ステ上限 32 / 合計 66。SP は旧EV換算で 1SP = 8EV。
//   - 実数値の計算式（Gen3+ 標準形に Lv50/IV31/EV=8*SP を代入）:
//       core = floor((2*Base + 31 + 2*SP) / 2)        // (…)*Lv/100 = (…)/2
//       HP   = core + Lv + 10 = core + 60
//       他   = floor((core + 5) * 性格補正)
//   - 結果: SP を 1 増やすと実数値はちょうど +1（1SP=+1）。

export const LEVEL = 50;
export const IV = 31;
export const SP_MAX_PER_STAT = 32;
export const SP_TOTAL = 66;

export const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"];
export const STAT_LABELS_JP = {
  hp: "HP", atk: "こうげき", def: "ぼうぎょ",
  spa: "とくこう", spd: "とくぼう", spe: "すばやさ",
};

// natures.json の increasedStat/decreasedStat 名 → base のキー
const NATURE_STAT_MAP = {
  attack: "atk", defense: "def",
  sp_attack: "spa", sp_defense: "spd", speed: "spe",
};

// core 値（HP/他で共通の中間値）
function statCore(base, sp) {
  return Math.floor((2 * base + IV + 2 * sp) / 2);
}

// 1ステータスの実数値。natureMod は 1.1 / 0.9 / 1.0。
export function calcStat(base, sp, statKey, natureMod = 1.0) {
  const core = statCore(base, Math.max(0, Math.min(SP_MAX_PER_STAT, sp)));
  if (statKey === "hp") return core + LEVEL + 10;
  return Math.floor((core + 5) * natureMod);
}

// nature オブジェクト({increasedStat, decreasedStat}) から各 base キーの補正倍率を返す
export function natureModifiers(nature) {
  const mods = { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
  if (!nature) return mods;
  const up = NATURE_STAT_MAP[nature.increasedStat];
  const down = NATURE_STAT_MAP[nature.decreasedStat];
  if (up) mods[up] = 1.1;
  if (down) mods[down] = 0.9; // 上昇と下降が同一なら 0.9→上書き後 0.9 にならないよう下で調整
  if (up && up === down) mods[up] = 1.0; // 無補正性格
  return mods;
}

// ポケモンの全ステータス実数値。spSpread = {hp,atk,...}、nature は natures.json の1件。
export function calcAllStats(base, spSpread, nature) {
  const mods = natureModifiers(nature);
  const out = {};
  for (const k of STAT_KEYS) {
    const sp = spSpread?.[k] ?? 0;
    out[k] = calcStat(base[k], sp, k, k === "hp" ? 1.0 : mods[k]);
  }
  return out;
}

// SP合計が上限内か検証
export function spTotal(spSpread) {
  return STAT_KEYS.reduce((s, k) => s + (spSpread?.[k] ?? 0), 0);
}
export function spValid(spSpread) {
  if (spTotal(spSpread) > SP_TOTAL) return false;
  return STAT_KEYS.every((k) => (spSpread?.[k] ?? 0) <= SP_MAX_PER_STAT && (spSpread?.[k] ?? 0) >= 0);
}
