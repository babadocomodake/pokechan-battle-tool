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
//
// 各特性は「攻撃側で効くか(atk)／防御側で効くか(def)」を分けて持つ。
// これにより、防御専用の特性（マルチスケイル等）を攻撃欄に置いても効かず、
// 攻撃専用の特性（ちからもち等）を防御欄に置いても効かない（= 取り違え防止）。
// 両側で効く特性（みずのベール等）は atk/def の両方を定義する。
const ABILITY_FX = {
  // --- 攻撃側で効く特性 ---
  // ちからもち/ヨガパワー: 物理攻撃実数値2倍
  "Huge Power": { atk: (c) => (c.physical ? { atkStat: 2 } : {}) },
  "Pure Power": { atk: (c) => (c.physical ? { atkStat: 2 } : {}) },
  // てきおうりょく: STAB 2.0
  "Adaptability": { atk: () => ({ stab: 2.0 }) },
  // テクニシャン: 威力60以下 ×1.5
  "Technician": { atk: (c) => (c.basePower && c.basePower <= 60 ? { dmg: 1.5 } : {}) },
  // いろめがね: 効果いまひとつ ×2
  "Tinted Lens": { atk: (c) => (c.typeEff > 0 && c.typeEff < 1 ? { dmg: 2 } : {}) },
  // タイプ強化系 ×1.5
  "Transistor": { atk: (c) => (c.moveType === "Electric" ? { dmg: 1.5 } : {}) },
  "Dragon's Maw": { atk: (c) => (c.moveType === "Dragon" ? { dmg: 1.5 } : {}) },
  "Rocky Payload": { atk: (c) => (c.moveType === "Rock" ? { dmg: 1.5 } : {}) },
  "Steelworker": { atk: (c) => (c.moveType === "Steel" ? { dmg: 1.5 } : {}) },
  "Steely Spirit": { atk: (c) => (c.moveType === "Steel" ? { dmg: 1.5 } : {}) },
  // 御三家ピンチ特性（HP1/3以下で発動。計算機では発動状態として適用）
  "Blaze": { atk: (c) => (c.moveType === "Fire" ? { dmg: 1.5 } : {}) },
  "Torrent": { atk: (c) => (c.moveType === "Water" ? { dmg: 1.5 } : {}) },
  "Overgrow": { atk: (c) => (c.moveType === "Grass" ? { dmg: 1.5 } : {}) },
  "Swarm": { atk: (c) => (c.moveType === "Bug" ? { dmg: 1.5 } : {}) },
  // サンパワー（はれ下で特攻1.5）— 天候はctxに無いため発動状態として適用
  "Solar Power": { atk: (c) => (!c.physical ? { atkStat: 1.5 } : {}) },

  // --- 両側で効く特性 ---
  // みずのベール: 攻撃=水技2倍 / 防御=炎半減
  "Water Bubble": {
    atk: (c) => (c.moveType === "Water" ? { dmg: 2 } : {}),
    def: (c) => (c.moveType === "Fire" ? { dmg: 0.5 } : {}),
  },
  // もらいび: 攻撃=発動状態で炎技1.5 / 防御=炎無効
  "Flash Fire": {
    atk: (c) => (c.moveType === "Fire" ? { dmg: 1.5 } : {}),
    def: (c) => (c.moveType === "Fire" ? { immune: true } : {}),
  },

  // --- 防御側で効く特性 ---
  "Multiscale": { def: (c) => (c.defenderFullHp ? { dmg: 0.5 } : {}) },
  "Shadow Shield": { def: (c) => (c.defenderFullHp ? { dmg: 0.5 } : {}) },
  "Filter": { def: (c) => (c.typeEff > 1 ? { dmg: 0.75 } : {}) },
  "Solid Rock": { def: (c) => (c.typeEff > 1 ? { dmg: 0.75 } : {}) },
  "Prism Armor": { def: (c) => (c.typeEff > 1 ? { dmg: 0.75 } : {}) },
  "Thick Fat": { def: (c) => (c.moveType === "Fire" || c.moveType === "Ice" ? { dmg: 0.5 } : {}) },
  "Heatproof": { def: (c) => (c.moveType === "Fire" ? { dmg: 0.5 } : {}) },
  "Ice Scales": { def: (c) => (!c.physical ? { dmg: 0.5 } : {}) },
  "Purifying Salt": { def: (c) => (c.moveType === "Ghost" ? { dmg: 0.5 } : {}) },
  "Levitate": { def: (c) => (c.moveType === "Ground" ? { immune: true } : {}) },
};
// 指定の特性が「side（"atk" or "def"）」で効く倍率を返す。
// side を省略すると両側を合算（後方互換・テスト用）。
export function abilityMods(abilityName, side, ctx) {
  const entry = ABILITY_FX[abilityName];
  if (!entry) return {};
  // 旧シグネチャ abilityMods(name, ctx) 互換: 第2引数がオブジェクトなら side 無指定とみなす
  if (side && typeof side === "object") {
    ctx = side;
    return { ...(entry.atk ? entry.atk(ctx) || {} : {}), ...(entry.def ? entry.def(ctx) || {} : {}) };
  }
  const fn = entry[side];
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

// タイプの英語→日本語（効果文の表示用）。
const TYPE_JP = {
  Normal: "ノーマル", Fire: "ほのお", Water: "みず", Electric: "でんき", Grass: "くさ",
  Ice: "こおり", Fighting: "かくとう", Poison: "どく", Ground: "じめん", Flying: "ひこう",
  Psychic: "エスパー", Bug: "むし", Rock: "いわ", Ghost: "ゴースト", Dragon: "ドラゴン",
  Dark: "あく", Steel: "はがね", Fairy: "フェアリー",
};

// 持ち物の「役割（攻撃用/防御用）」と日本語効果文を返す。
// 判定は itemMods と同一（説明文の正規表現＋種族例外）なので、
// UIの絞り込み（攻撃側=atk / 防御側=def）と効果文の表示が計算とズレない。
// 返り値: { atk:boolean, def:boolean, jp:string }（計算に影響しない道具は両方 false）。
export function itemRole(item) {
  if (!item) return { atk: false, def: false, jp: "" };
  const d = item.description || "";
  const name = item.name;

  // 種族専用
  if (name === "Light Ball") return { atk: true, def: false, jp: "ピカチュウ専用：こうげき・とくこう ×2" };
  if (name === "Thick Club") return { atk: true, def: false, jp: "カラカラ/ガラガラ専用：物理こうげき ×2" };

  // ステータス倍率（こだわり / チョッキ / きせき）
  if (/Attack is 1\.5x/i.test(d) && !/Sp\. ?Atk/i.test(d)) return { atk: true, def: false, jp: "物理こうげき ×1.5（こだわり：技固定）" };
  if (/Sp\. ?Atk is 1\.5x/i.test(d)) return { atk: true, def: false, jp: "とくこう ×1.5（こだわり：技固定）" };
  if (/Sp\. ?Def is 1\.5x/i.test(d)) return { atk: false, def: true, jp: "とくぼう ×1.5（攻撃技のみ選択可）" };
  if (/Defense and Sp\. ?Def are 1\.5x/i.test(d)) return { atk: false, def: true, jp: "ぼうぎょ・とくぼう ×1.5（進化前のみ）" };

  // ダメージ倍率（攻撃側）
  if (/do 1\.3x damage/i.test(d)) return { atk: true, def: false, jp: "全こうげき ×1.3（毎ターンHP1/10減）" };
  if (/super effective.*1\.2x damage/i.test(d)) return { atk: true, def: false, jp: "こうかばつぐんの技 ×1.2" };
  if (/physical attacks have 1\.1x power/i.test(d)) return { atk: true, def: false, jp: "物理技 ×1.1" };
  if (/special attacks have 1\.1x power/i.test(d)) return { atk: true, def: false, jp: "特殊技 ×1.1" };
  const m = d.match(TYPE_ATK_RE);
  if (m) return { atk: true, def: false, jp: `${TYPE_JP[m[1]] || m[1]}タイプの技 ×1.2` };

  return { atk: false, def: false, jp: "" }; // 計算に影響しない道具
}
