// 計算エンジンの回帰テスト（依存ゼロ・node:test）。
// 実行: npm test （= node --test web/js/calc）
// 純粋関数のみ対象。代表対面の実数を固定し、modifiers/damage の改修時の回帰を検出する。
import test from "node:test";
import assert from "node:assert/strict";

import { calcStat } from "./stats.js";
import { statStageMultiplier, stageMultiplier } from "./stages.js";
import {
  weatherDamageMult, weatherDefStatMult, terrainDamageMult, screenMult,
  abilityMods, itemMods, isAbilitySupported, ateConversion, ignoresDefenderAbility,
} from "./modifiers.js";
import { computeDamage, summarize } from "./damage.js";

test("calcStat: 実数値（Lv50/IV31/SP制）", () => {
  assert.equal(calcStat(100, 0, "hp"), 175);            // HP = core+60
  assert.equal(calcStat(100, 32, "atk", 1.1), 167);     // 性格↑・SP最大
  assert.equal(calcStat(100, 0, "atk", 1.0), 120);      // 無補正
  assert.equal(calcStat(100, 0, "atk", 0.9), 108);      // 性格↓
});

test("statStageMultiplier: ランク補正", () => {
  assert.equal(statStageMultiplier(0), 1);
  assert.equal(statStageMultiplier(1), 1.5);
  assert.equal(statStageMultiplier(2), 2);
  assert.equal(statStageMultiplier(6), 4);
  assert.equal(statStageMultiplier(-2), 0.5);
  assert.equal(statStageMultiplier(-6), 0.25);
  // speed用は0未満を0扱い
  assert.equal(stageMultiplier(-2), 1);
  assert.equal(stageMultiplier(2), 2);
});

test("天候の倍率", () => {
  assert.equal(weatherDamageMult("sun", "Fire"), 1.5);
  assert.equal(weatherDamageMult("sun", "Water"), 0.5);
  assert.equal(weatherDamageMult("rain", "Water"), 1.5);
  assert.equal(weatherDamageMult("rain", "Fire"), 0.5);
  assert.equal(weatherDamageMult("", "Fire"), 1);
  assert.equal(weatherDefStatMult("sand", ["Rock"]).spd, 1.5);
  assert.equal(weatherDefStatMult("snow", ["Ice"]).def, 1.5);
});

test("フィールドの倍率", () => {
  assert.equal(terrainDamageMult("electric", "Electric"), 1.3);
  assert.equal(terrainDamageMult("psychic", "Psychic"), 1.3);
  assert.equal(terrainDamageMult("grassy", "Grass"), 1.3);
  assert.equal(terrainDamageMult("grassy", "Ground", "Earthquake"), 0.5);
  assert.equal(terrainDamageMult("misty", "Dragon"), 0.5);
});

test("壁の倍率（急所で無効）", () => {
  assert.equal(screenMult("reflect", true, false), 0.5);   // リフ×物理
  assert.equal(screenMult("reflect", false, false), 1);    // リフは特殊に効かない
  assert.equal(screenMult("light", false, false), 0.5);    // 光×特殊
  assert.equal(screenMult("aurora", true, false), 0.5);    // オーロラは両方
  assert.equal(screenMult("reflect", true, true), 1);      // 急所で無効
});

test("とくせいの倍率", () => {
  assert.deepEqual(abilityMods("Adaptability", {}), { stab: 2.0 });
  assert.deepEqual(abilityMods("Huge Power", { physical: true }), { atkStat: 2 });
  assert.deepEqual(abilityMods("Multiscale", { defenderFullHp: true }), { dmg: 0.5 });
  assert.deepEqual(abilityMods("Filter", { typeEff: 2 }), { dmg: 0.75 });
  assert.deepEqual(abilityMods("Levitate", { moveType: "Ground" }), { immune: true });
  assert.deepEqual(abilityMods("Technician", { basePower: 40 }), { dmg: 1.5 });
  assert.deepEqual(abilityMods("Technician", { basePower: 80 }), {}); // 60超は無効
});

test("とくせいの攻守分離（取り違え防止）", () => {
  // 防御専用（マルチスケイル）: 防御欄では効くが、攻撃欄では効かない
  assert.deepEqual(abilityMods("Multiscale", "def", { defenderFullHp: true }), { dmg: 0.5 });
  assert.deepEqual(abilityMods("Multiscale", "atk", { defenderFullHp: true }), {});
  // 攻撃専用（ちからもち）: 攻撃欄では効くが、防御欄では効かない
  assert.deepEqual(abilityMods("Huge Power", "atk", { physical: true }), { atkStat: 2 });
  assert.deepEqual(abilityMods("Huge Power", "def", { physical: true }), {});
  // てきおうりょくは攻撃側のみ
  assert.deepEqual(abilityMods("Adaptability", "atk", {}), { stab: 2.0 });
  assert.deepEqual(abilityMods("Adaptability", "def", {}), {});
  // フィルターは防御側のみ
  assert.deepEqual(abilityMods("Filter", "def", { typeEff: 2 }), { dmg: 0.75 });
  assert.deepEqual(abilityMods("Filter", "atk", { typeEff: 2 }), {});
  // 両側で効くみずのベール: 攻撃=水2倍 / 防御=炎半減
  assert.deepEqual(abilityMods("Water Bubble", "atk", { moveType: "Water" }), { dmg: 2 });
  assert.deepEqual(abilityMods("Water Bubble", "def", { moveType: "Fire" }), { dmg: 0.5 });
  assert.deepEqual(abilityMods("Water Bubble", "atk", { moveType: "Fire" }), {}); // 攻撃側に炎の防御効果は出ない
});

test("持ち物の倍率", () => {
  const lifeOrb = { name: "Life Orb", description: "Holder's moves do 1.3x damage, but lose 10% HP after each hit." };
  assert.equal(itemMods(lifeOrb, { physical: true }).dmg, 1.3);

  const band = { name: "Choice Band", description: "Holder's Attack is 1.5x, but it can only select one move." };
  assert.equal(itemMods(band, { physical: true }).atkStat, 1.5);
  assert.equal(itemMods(band, { physical: false }).atkStat, undefined); // 特殊技には乗らない

  const belt = { name: "Expert Belt", description: "Holder's super effective moves do 1.2x damage." };
  assert.equal(itemMods(belt, { typeEff: 2 }).dmg, 1.2);
  assert.equal(itemMods(belt, { typeEff: 1 }).dmg, undefined);

  const charcoal = { name: "Charcoal", description: "Holder's Fire-type attacks have 1.2x power." };
  assert.equal(itemMods(charcoal, { moveType: "Fire" }).dmg, 1.2);
  assert.equal(itemMods(charcoal, { moveType: "Water" }).dmg, undefined);
});

// computeDamage: 威力100・攻撃120・防御100・Lv50 → base=54、乱数 45〜54
test("computeDamage: 基礎ダメージと乱数16通り", () => {
  const r = computeDamage({ power: 100, atkStat: 120, defStat: 100 });
  assert.equal(r.rolls.length, 16);
  assert.equal(r.min, 45);
  assert.equal(r.max, 54);
});

test("computeDamage: タイプ相性×2 / STAB×1.5 / 天候×1.5 / 壁×0.5", () => {
  assert.deepEqual(pick(computeDamage({ power: 100, atkStat: 120, defStat: 100, typeEff: 2 })), [90, 108]);
  assert.deepEqual(pick(computeDamage({ power: 100, atkStat: 120, defStat: 100, stab: 1.5 })), [67, 81]);
  assert.deepEqual(pick(computeDamage({ power: 100, atkStat: 120, defStat: 100, weatherMult: 1.5 })), [68, 81]);
  assert.deepEqual(pick(computeDamage({ power: 100, atkStat: 120, defStat: 100, chainMults: [0.5] })), [22, 27]);
});

test("computeDamage: 無効（immune / typeEff 0）はダメージ0", () => {
  assert.equal(computeDamage({ power: 100, atkStat: 120, defStat: 100, immune: true }).max, 0);
  assert.equal(computeDamage({ power: 100, atkStat: 120, defStat: 100, typeEff: 0 }).max, 0);
});

test("summarize: 割合・確定数", () => {
  const r = computeDamage({ power: 100, atkStat: 120, defStat: 100 }); // 45〜54
  const s1 = summarize(r.rolls, 175);
  assert.equal(s1.guaranteed, 4);
  assert.equal(s1.label, "確定4発");
  assert.ok(Math.abs(s1.pctMax - (54 / 175 * 100)) < 1e-9);

  const s2 = summarize(r.rolls, 40); // 最小45で確定1発
  assert.equal(s2.guaranteed, 1);
  assert.equal(s2.label, "確定1発");
});

test("②-A 追加特性: 倍率・タイプ変化・メタ判定", () => {
  // へんげんじざい/リベロ: 常にSTAB1.5
  assert.deepEqual(abilityMods("Protean", "atk", {}), { stab: 1.5 });
  assert.deepEqual(abilityMods("Libero", "atk", {}), { stab: 1.5 });
  // すなのちから: すなあらし中の地/岩/鋼 ×1.3、他天候では無効
  assert.deepEqual(abilityMods("Sand Force", "atk", { weather: "sand", moveType: "Ground" }), { dmg: 1.3 });
  assert.deepEqual(abilityMods("Sand Force", "atk", { weather: "", moveType: "Ground" }), {});
  assert.deepEqual(abilityMods("Sand Force", "atk", { weather: "sand", moveType: "Water" }), {});
  // ぼうだん: 弾技を無効
  assert.deepEqual(abilityMods("Bulletproof", "def", { bullet: true }), { immune: true });
  assert.deepEqual(abilityMods("Bulletproof", "def", { bullet: false }), {});
  // ドラゴンスキン: ノーマル技→ドラゴン ×1.2（-ate）
  assert.deepEqual(ateConversion("Dragonize", "Normal"), { type: "Dragon", boost: 1.2 });
  assert.equal(ateConversion("Dragonize", "Fire"), null);
  // メタ特性はサポート扱い＆かたやぶり判定
  for (const a of ["Mold Breaker", "Unaware", "Scrappy", "Liquid Voice", "Protean", "Dragonize"]) {
    assert.ok(isAbilitySupported(a), `${a} should be supported`);
  }
  assert.equal(ignoresDefenderAbility("Mold Breaker"), true);
  assert.equal(ignoresDefenderAbility("Teravolt"), true);
  assert.equal(ignoresDefenderAbility("Guts"), false);
});

test("②-A2 条件付き特性: アナライズ/きれあじ/とうそうしん/そうだいしょう", () => {
  // アナライズ: 後攻で ×1.3
  assert.deepEqual(abilityMods("Analytic", "atk", { movedAfter: true }), { dmg: 1.3 });
  assert.deepEqual(abilityMods("Analytic", "atk", { movedAfter: false }), {});
  // きれあじ: 切断技で ×1.5
  assert.deepEqual(abilityMods("Sharpness", "atk", { slicing: true }), { dmg: 1.5 });
  assert.deepEqual(abilityMods("Sharpness", "atk", { slicing: false }), {});
  // とうそうしん: 同性×1.25 / 異性×0.75 / 未指定なし
  assert.deepEqual(abilityMods("Rivalry", "atk", { rivalry: "same" }), { dmg: 1.25 });
  assert.deepEqual(abilityMods("Rivalry", "atk", { rivalry: "opp" }), { dmg: 0.75 });
  assert.deepEqual(abilityMods("Rivalry", "atk", { rivalry: "" }), {});
  // そうだいしょう: 倒れた味方数×0.1加算（最大5）
  assert.deepEqual(abilityMods("Supreme Overlord", "atk", { faintedAllies: 0 }), {});
  assert.deepEqual(abilityMods("Supreme Overlord", "atk", { faintedAllies: 3 }), { dmg: 1.3 });
  assert.deepEqual(abilityMods("Supreme Overlord", "atk", { faintedAllies: 9 }), { dmg: 1.5 });
  // すべてサポート扱い
  for (const a of ["Analytic", "Sharpness", "Rivalry", "Supreme Overlord"]) assert.ok(isAbilitySupported(a));
});

// 乱数の [min, max] を取り出す小ヘルパ
function pick(r) { return [r.min, r.max]; }
