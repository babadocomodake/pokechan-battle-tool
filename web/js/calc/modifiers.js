// ダメージ計算の各種補正（天候・フィールド・壁・特性・持ち物）のキュレーション。
// チャンピオンズ（シングル）の競技頻出要素に絞る。未対応の特性/道具は効果なし。
//
// 倍率の返却規約: { atkStat, defStat, dmg, stab, immune } の一部または全部。
//   atkStat … 攻撃実数値(物理atk/特殊spa)に乗じる倍率
//   defStat … 防御実数値(物理def/特殊spd)に乗じる倍率
//   dmg     … ダメージ式の最終チェーンに乗じる倍率
//   stab    … STAB倍率を上書き（てきおうりょく等）
//   immune  … true でダメージ0（ふゆう等の特性無効）

export const WEATHERS = [
  { id: "", label: "なし" }, { id: "sun", label: "はれ" }, { id: "rain", label: "あめ" },
  { id: "sand", label: "すなあらし" }, { id: "snow", label: "ゆき" },
];
export const TERRAINS = [
  { id: "", label: "なし" }, { id: "electric", label: "エレキフィールド" },
  { id: "grassy", label: "グラスフィールド" }, { id: "psychic", label: "サイコフィールド" },
  { id: "misty", label: "ミストフィールド" },
];
export const SCREENS = [
  { id: "", label: "なし" }, { id: "reflect", label: "リフレクター" },
  { id: "light", label: "ひかりのかべ" }, { id: "aurora", label: "オーロラベール" },
];

// 天候によるダメージ倍率（炎・水の威力）。
export function weatherDamageMult(weather, moveType) {
  if (weather === "sun") return moveType === "Fire" ? 1.5 : moveType === "Water" ? 0.5 : 1;
  if (weather === "rain") return moveType === "Water" ? 1.5 : moveType === "Fire" ? 0.5 : 1;
  return 1;
}
// 天候による防御側ステータス倍率（砂=岩の特防1.5 / 雪=氷の防御1.5）。
export function weatherDefStatMult(weather, defenderTypes = []) {
  const out = { def: 1, spd: 1 };
  if (weather === "sand" && defenderTypes.includes("Rock")) out.spd = 1.5;
  if (weather === "snow" && defenderTypes.includes("Ice")) out.def = 1.5;
  return out;
}
// フィールドによるダメージ倍率（攻撃側が地面にいる前提）。
const GRASSY_WEAKENED = new Set(["Earthquake", "Bulldoze", "Magnitude"]);
export function terrainDamageMult(terrain, moveType, moveName) {
  if (terrain === "electric") return moveType === "Electric" ? 1.3 : 1;
  if (terrain === "psychic") return moveType === "Psychic" ? 1.3 : 1;
  if (terrain === "grassy") {
    if (moveType === "Grass") return 1.3;
    if (GRASSY_WEAKENED.has(moveName)) return 0.5;
    return 1;
  }
  if (terrain === "misty") return moveType === "Dragon" ? 0.5 : 1; // 接地した相手へ
  return 1;
}
// 壁の倍率（急所で無効）。シングルは ×0.5。
export function screenMult(screen, physical, crit) {
  if (crit || !screen) return 1;
  if (screen === "reflect") return physical ? 0.5 : 1;
  if (screen === "light") return physical ? 1 : 0.5;
  if (screen === "aurora") return 0.5;
  return 1;
}

// ---- 特性（英語名キー）----
// ctx: { physical, moveType, moveName, attackerName, typeEff, defenderFullHp, basePower }
const ABILITY_FX = {
  // 攻撃側・攻撃実数値2倍（物理）
  "Huge Power": (c) => (c.physical ? { atkStat: 2 } : {}),
  "Pure Power": (c) => (c.physical ? { atkStat: 2 } : {}),
  // STAB 2.0
  "Adaptability": () => ({ stab: 2.0 }),
  // テクニシャン: 威力60以下 ×1.5
  "Technician": (c) => (c.basePower && c.basePower <= 60 ? { dmg: 1.5 } : {}),
  // いろめがね: 効果いまひとつ ×2
  "Tinted Lens": (c) => (c.typeEff > 0 && c.typeEff < 1 ? { dmg: 2 } : {}),
  // タイプ強化系 ×1.5
  "Transistor": (c) => (c.moveType === "Electric" ? { dmg: 1.5 } : {}),
  "Dragon's Maw": (c) => (c.moveType === "Dragon" ? { dmg: 1.5 } : {}),
  "Rocky Payload": (c) => (c.moveType === "Rock" ? { dmg: 1.5 } : {}),
  "Steelworker": (c) => (c.moveType === "Steel" ? { dmg: 1.5 } : {}),
  "Steely Spirit": (c) => (c.moveType === "Steel" ? { dmg: 1.5 } : {}),
  "Water Bubble": (c) => {
    // 攻撃側: 水技2倍 / 防御側: 炎半減
    const o = {};
    if (c.moveType === "Water") o.dmg = 2;
    if (c.moveType === "Fire") o.dmg = (o.dmg || 1) * 0.5;
    return o;
  },
  // 御三家ピンチ特性（HP1/3以下で発動。計算機では発動状態として適用）
  "Blaze": (c) => (c.moveType === "Fire" ? { dmg: 1.5 } : {}),
  "Torrent": (c) => (c.moveType === "Water" ? { dmg: 1.5 } : {}),
  "Overgrow": (c) => (c.moveType === "Grass" ? { dmg: 1.5 } : {}),
  "Swarm": (c) => (c.moveType === "Bug" ? { dmg: 1.5 } : {}),
  // もらいび（発動状態で炎技1.5）
  "Flash Fire": (c) => (c.moveType === "Fire" ? { dmg: 1.5 } : {}),
  // サンパワー（はれ下で特攻1.5）— 天候はctxに無いため発動状態として適用
  "Solar Power": (c) => (!c.physical ? { atkStat: 1.5 } : {}),

  // 防御側
  "Multiscale": (c) => (c.defenderFullHp ? { dmg: 0.5 } : {}),
  "Shadow Shield": (c) => (c.defenderFullHp ? { dmg: 0.5 } : {}),
  "Filter": (c) => (c.typeEff > 1 ? { dmg: 0.75 } : {}),
  "Solid Rock": (c) => (c.typeEff > 1 ? { dmg: 0.75 } : {}),
  "Prism Armor": (c) => (c.typeEff > 1 ? { dmg: 0.75 } : {}),
  "Thick Fat": (c) => (c.moveType === "Fire" || c.moveType === "Ice" ? { dmg: 0.5 } : {}),
  "Heatproof": (c) => (c.moveType === "Fire" ? { dmg: 0.5 } : {}),
  "Ice Scales": (c) => (!c.physical ? { dmg: 0.5 } : {}),
  "Purifying Salt": (c) => (c.moveType === "Ghost" ? { dmg: 0.5 } : {}),
  "Levitate": (c) => (c.moveType === "Ground" ? { immune: true } : {}),
};
// 攻撃側として効く特性かどうか（UIの注記用）。dmg/atkStat/stab を返すものを攻撃側とみなす。
export function abilityMods(abilityName, ctx) {
  const fn = ABILITY_FX[abilityName];
  if (!fn) return {};
  return fn(ctx) || {};
}
export function isAbilitySupported(abilityName) {
  return !!ABILITY_FX[abilityName];
}

// ---- 持ち物（説明文ベースで自動判定 + 例外）----
// item: items.json の1件（name, nameJp, description, category）。
const TYPE_ATK_RE = /Holder's ([A-Z][a-z]+)-type (?:attacks|moves) have 1\.2x power/i;
export function itemMods(item, ctx) {
  if (!item) return {};
  const d = item.description || "";
  const name = item.name;
  const out = {};

  // 種族専用（説明文の数値が曖昧なため明示）
  if (name === "Light Ball") { // でんきだま: ピカチュウ 攻撃・特攻2倍
    if (ctx.attackerName && ctx.attackerName.includes("Pikachu")) out.atkStat = 2;
    return out;
  }
  if (name === "Thick Club") { // ふといホネ: カラカラ/ガラガラ 攻撃2倍
    if (ctx.attackerName && (ctx.attackerName.includes("Marowak") || ctx.attackerName.includes("Cubone")) && ctx.physical) out.atkStat = 2;
    return out;
  }

  // こだわり / とつげきチョッキ / しんかのきせき（ステータス倍率）
  if (/Attack is 1\.5x/i.test(d) && !/Sp\. ?Atk/i.test(d)) { if (ctx.physical) out.atkStat = 1.5; }     // こだわりハチマキ
  if (/Sp\. ?Atk is 1\.5x/i.test(d)) { if (!ctx.physical) out.atkStat = 1.5; }                          // こだわりメガネ
  if (/Sp\. ?Def is 1\.5x/i.test(d)) { if (!ctx.physical) out.defStat = 1.5; }                          // とつげきチョッキ
  if (/Defense and Sp\. ?Def are 1\.5x/i.test(d)) { out.defStat = 1.5; }                                 // しんかのきせき(両壁)

  // いのちのたま
  if (/do 1\.3x damage/i.test(d)) out.dmg = (out.dmg || 1) * 1.3;
  // たつじんのおび（抜群時 ×1.2）
  if (/super effective.*1\.2x damage/i.test(d) && ctx.typeEff > 1) out.dmg = (out.dmg || 1) * 1.2;
  // ちからのハチマキ/ものしりメガネ（×1.1）
  if (/physical attacks have 1\.1x power/i.test(d) && ctx.physical) out.dmg = (out.dmg || 1) * 1.1;
  if (/special attacks have 1\.1x power/i.test(d) && !ctx.physical) out.dmg = (out.dmg || 1) * 1.1;
  // タイプ強化 ×1.2
  const m = d.match(TYPE_ATK_RE);
  if (m && ctx.moveType === m[1]) out.dmg = (out.dmg || 1) * 1.2;

  return out;
}
