// アプリ本体: タブ（ダメージ計算 / 素早さ一覧 / 逆算 / 流行り / マイポケモン）
import { loadData, store, getNature, attackingMovesFor, allMovesFor, byUsage } from "./data.js";
import { calcStat, calcAllStats, STAT_KEYS, STAT_LABELS_JP, SP_MAX_PER_STAT, SP_TOTAL } from "./calc/stats.js";
import { buildSpeedTable } from "./calc/speed.js";
import { statStageMultiplier } from "./calc/stages.js";
import { computeDamage, typeEffectiveness, stabMultiplier, summarize } from "./calc/damage.js";
import {
  WEATHERS, TERRAINS, SCREENS, weatherDamageMult, weatherDefStatMult,
  terrainDamageMult, screenMult, abilityMods, itemMods, isAbilitySupported, itemRole, ateConversion,
} from "./calc/modifiers.js";
import { loadFavorites, upsertFavorite, removeFavorite, genId, emptySpread, loadRecent, pushRecent, upsertRecentSnap, syncRecentSnapFront } from "./favorites.js";

const RECENT_DEF_KEY = "pokechamp.recentDefenders.v1";
const RECENT_ATK_KEY = "pokechamp.recentAttackers.v1";
const RECENT_CAP = 50; // 履歴の保存件数

// タブのインデックスと、お気に入りから他タブを開くためのコントローラ
// （tabs() に渡す配列の並びと必ず一致させること）
// タブ並びは「対戦中によく使う順」（ダメ計→素早さ→逆算→準備系）。indexはmain()のtabs配列と一致させること。
const TAB = { DAMAGE: 0, SPEED: 1, REVERSE: 2, USAGE: 3, FAV: 4 };
const nav = { open(_i, _preset) {} };

// 性格の日本語名
const NATURE_JP = {
  Adamant:"いじっぱり",Bashful:"てれや",Bold:"ずぶとい",Brave:"ゆうかん",Calm:"おだやか",
  Careful:"しんちょう",Docile:"すなお",Gentle:"おとなしい",Hardy:"がんばりや",Hasty:"せっかち",
  Impish:"わんぱく",Jolly:"ようき",Lax:"のうてんき",Lonely:"さみしがり",Mild:"おっとり",
  Modest:"ひかえめ",Naive:"むじゃき",Naughty:"やんちゃ",Quiet:"れいせい",Quirky:"きまぐれ",
  Rash:"うっかりや",Relaxed:"のんき",Sassy:"なまいき",Serious:"まじめ",Timid:"おくびょう",
};
const TYPE_JP = {
  Normal:"ノーマル",Fire:"ほのお",Water:"みず",Electric:"でんき",Grass:"くさ",Ice:"こおり",
  Fighting:"かくとう",Poison:"どく",Ground:"じめん",Flying:"ひこう",Psychic:"エスパー",
  Bug:"むし",Rock:"いわ",Ghost:"ゴースト",Dragon:"ドラゴン",Dark:"あく",Steel:"はがね",
  Fairy:"フェアリー",Stellar:"ステラ",
};

// --- DOM ヘルパ ---
function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}
function typeBadges(types) {
  return el("span", { class: "types" }, types.map((t) =>
    el("span", { class: `type type-${t.toLowerCase()}` }, TYPE_JP[t] || t)));
}
// タイプ絞り込みチップ（複数選択OR）。対戦に無い「ステラ」は除外。
// 返り値 { node, matches(types) }。onChange は選択が変わるたびに呼ばれる。
function typeFilterChips(onChange) {
  const types = (store.typechart?.types || []).filter((t) => t !== "Stellar");
  const selected = new Set();
  const chips = types.map((t) =>
    el("button", { type: "button", class: `type type-${t.toLowerCase()} type-chip`, "aria-pressed": "false",
      onclick: (e) => {
        if (selected.has(t)) selected.delete(t); else selected.add(t);
        e.currentTarget.setAttribute("aria-pressed", selected.has(t) ? "true" : "false");
        onChange();
      } }, TYPE_JP[t] || t));
  const clear = el("button", { type: "button", class: "chip-btn type-chip-clear",
    onclick: () => { selected.clear(); chips.forEach((c) => c.setAttribute("aria-pressed", "false")); onChange(); } }, "クリア");
  const node = el("div", { class: "type-chips" }, [
    el("span", { class: "type-chips-label" }, "タイプ:"), ...chips, clear,
  ]);
  // 選択が空なら全件通過。dual-type は「いずれか一致」で通す（OR）。
  return { node, matches: (typeList) => selected.size === 0 || (typeList || []).some((t) => selected.has(t)) };
}
// 検索用の正規化: NFKC（全角→半角）→小文字→ひらがなをカタカナへ。
// これで「りざ」「リザ」「riza」いずれでも部分一致できる。
function normJa(s) {
  return (s || "").normalize("NFKC").toLowerCase()
    .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}
function pokeMatches(p, q) {
  const nq = normJa(q);
  if (!nq) return true;
  return normJa(p.nameJp).includes(nq) || normJa(p.name).includes(nq);
}

// 検索付きポケモン選択（コンボボックス）。入力すると候補がプルダウン表示され、
// クリックで選択。ひらがな/カタカナ/英字を問わず部分一致。
// 互換: 戻り値 wrap の .value で英語名を get/set 可能。
function pokemonSelect(onChange, id) {
  const all = [...store.legalPokemon].sort(byUsage);
  const disp = (p) => `${p.usageRankSingle ? `#${p.usageRankSingle} ` : ""}${p.nameJp}`;
  const full = (p) => `${disp(p)}（${p.name}）`;
  let value = all[0]?.name || "";
  let items = [];
  let active = -1;

  const input = el("input", { type: "search", class: "poke-search", id, autocomplete: "off",
    placeholder: "🔍 ひらがな/カタカナ/英字で検索" });
  const list = el("ul", { class: "combo-list", hidden: "hidden" });
  const wrap = el("div", { class: "poke-combo" }, [input, list]);

  function setValue(name, fire) {
    value = name;
    const p = store.pokemonByName.get(name);
    input.value = p ? disp(p) : "";
    if (fire) onChange(p);
  }
  function highlight() {
    [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
    if (active >= 0 && list.children[active]) list.children[active].scrollIntoView({ block: "nearest" });
  }
  function renderList(q) {
    items = all.filter((p) => pokeMatches(p, q)).slice(0, 80);
    active = -1;
    list.replaceChildren(...items.map((p) => el("li", { class: "combo-item",
      onmousedown: (e) => { e.preventDefault(); setValue(p.name, true); close(); } }, full(p))));
    list.hidden = items.length === 0;
  }
  function open() { renderList(""); }
  function close() { list.hidden = true; active = -1; }

  input.addEventListener("focus", () => { input.select(); open(); });
  input.addEventListener("input", () => renderList(input.value));
  input.addEventListener("blur", () => setTimeout(() => { close(); setValue(value, false); }, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) open(); active = Math.min(items.length - 1, active + 1); highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); highlight(); }
    else if (e.key === "Enter") { e.preventDefault(); const p = items[active >= 0 ? active : 0]; if (p) { setValue(p.name, true); close(); } }
    else if (e.key === "Escape") { close(); setValue(value, false); }
  });

  Object.defineProperty(wrap, "value", { get: () => value, set: (v) => setValue(v, false) });
  setValue(value, false);
  return wrap;
}
function natureSelect(id) {
  const opts = [...store.natures]
    .sort((a, b) => (NATURE_JP[a.name] || a.name).localeCompare(NATURE_JP[b.name] || b.name, "ja"))
    .map((n) => el("option", { value: n.name }, `${NATURE_JP[n.name] || n.name}`));
  const sel = el("select", { id, class: "nature-select" }, opts);
  sel.value = "Serious"; // まじめ（無補正）を既定
  return sel;
}

// 性格名 → 指定ステの3択補正状態（up/neutral/down）
const STATKEY_TO_NATURE = { atk: "attack", def: "defense", spa: "sp_attack", spd: "sp_defense", spe: "speed" };
function triFromNature(natureName, statKey) {
  const n = getNature(natureName);
  if (!n) return "neutral";
  const s = STATKEY_TO_NATURE[statKey];
  if (n.increasedStat === s && n.decreasedStat !== s) return "up";
  if (n.decreasedStat === s && n.increasedStat !== s) return "down";
  return "neutral";
}

// =================== タブ1: 素早さ一覧 ===================
function speedTab() {
  const root = el("div", { class: "tab-panel" });
  const mods = { scarf: false, paralysis: false, stage: 0 };
  let query = "";

  const search = el("input", { type: "search", placeholder: "ポケモン名で絞り込み（日本語/英語）", class: "search",
    oninput: (e) => { query = e.target.value.trim(); render(); } });

  const typeChips = typeFilterChips(() => render());

  // すばやさ段階（0〜+6）
  const stageSel = el("select", { class: "stage-select",
    onchange: (e) => { mods.stage = parseInt(e.target.value, 10) || 0; render(); } },
    [0, 1, 2, 3, 4, 5, 6].map((n) => el("option", { value: String(n) }, n === 0 ? "すばやさ補正なし" : `すばやさ +${n}`)));

  const cbScarf = el("input", { type: "checkbox", onchange: (e) => { mods.scarf = e.target.checked; render(); } });
  const cbPara = el("input", { type: "checkbox", onchange: (e) => { mods.paralysis = e.target.checked; render(); } });

  const toggles = el("div", { class: "toggles" }, [
    stageSel,
    el("label", { class: "toggle" }, [cbScarf, " こだわりスカーフ ×1.5（メガ不可）"]),
    el("label", { class: "toggle" }, [cbPara, " まひ ×0.5"]),
  ]);

  const tableWrap = el("div", { class: "table-wrap" });

  function render() {
    let rows = buildSpeedTable(store.legalPokemon, mods);
    if (query) rows = rows.filter((r) => pokeMatches(r, query));
    rows = rows.filter((r) => typeChips.matches(r.types));
    const table = el("table", { class: "data-table" }, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "#"), el("th", {}, "ポケモン"), el("th", {}, "タイプ"),
        el("th", { class: "num" }, "使用率"),
        el("th", { class: "num hl" }, "最速"), el("th", { class: "num" }, "準速"),
        el("th", { class: "num" }, "無振り"), el("th", { class: "num" }, "種族値"),
      ])),
      el("tbody", {}, rows.map((r, i) => el("tr", {}, [
        el("td", { class: "rank" }, String(i + 1)),
        el("td", {}, el("span", { class: "pname" }, r.nameJp)),
        el("td", {}, typeBadges(r.types)),
        el("td", { class: "num dim" }, r.usageRankSingle ? `#${r.usageRankSingle}` : "—"),
        el("td", { class: "num hl" }, String(r.max)),
        el("td", { class: "num" }, String(r.fast)),
        el("td", { class: "num" }, String(r.none)),
        el("td", { class: "num dim" }, String(r.baseSpe)),
      ]))),
    ]);
    tableWrap.replaceChildren(table);
  }

  root.append(
    el("p", { class: "hint" }, "Lv50・個体値31固定。最速=SP32+性格補正↑、準速=SP32無補正、無振り=SP0。補正は表全体に適用（こだわりスカーフはメガには無効）。"),
    search, typeChips.node, toggles, tableWrap
  );
  render();
  return root;
}

// =================== タブ: 流行り（使用率ランキング・シングル） ===================
function usageTab() {
  const root = el("div", { class: "tab-panel" });
  let query = "";

  // シングル使用率の付いた合法ポケモンを「一般」と「メガシンカ」に分けて順位順に。
  // 使用率は種族単位（メガは基本種と同じ使用率値を持つ）。各リストは使用率順で1〜N位を振り直す。
  const isMega = (p) => p.form === "Mega";
  const general = store.legalPokemon.filter((p) => p.usageRankSingle && !isMega(p))
    .sort((a, b) => a.usageRankSingle - b.usageRankSingle);
  const megas = store.legalPokemon.filter((p) => p.usageRankSingle && isMega(p))
    .sort((a, b) => a.usageRankSingle - b.usageRankSingle);

  const search = el("input", { type: "search", placeholder: "🔍 ひらがな/カタカナ/英字で絞り込み", class: "search",
    oninput: (e) => { query = e.target.value.trim(); render(); } });

  const typeChips = typeFilterChips(() => render());

  const generalWrap = el("div", { class: "table-wrap" });
  const megaWrap = el("div", { class: "table-wrap" });

  function buildTable(list) {
    const rows = list.filter((p) => pokeMatches(p, query) && typeChips.matches(p.types));
    if (!rows.length) return el("p", { class: "hint" }, "該当なし");
    return el("table", { class: "data-table" }, [
      el("thead", {}, el("tr", {}, [
        el("th", { class: "num" }, "順位"), el("th", {}, "ポケモン"), el("th", {}, "タイプ"),
        el("th", {}, "とくせい"), el("th", { class: "num" }, "種族値"), el("th", { class: "num" }, "素早"),
        el("th", {}, ""),
      ])),
      el("tbody", {}, rows.map((p, i) => el("tr", {}, [
        el("td", { class: "num hl" }, `${list.indexOf(p) + 1}`),
        el("td", {}, el("span", { class: "pname" }, p.nameJp)),
        el("td", {}, typeBadges(p.types)),
        el("td", { class: "dim" }, (p.abilitiesJp || []).join(" / ")),
        el("td", { class: "num dim" }, String(p.bst ?? "—")),
        el("td", { class: "num" }, String(p.base?.spe ?? "—")),
        el("td", {}, el("button", { type: "button", class: "mini",
          onclick: () => nav.open(TAB.DAMAGE, { pokemon: p.name }) }, "ダメ計で使う")),
      ]))),
    ]);
  }
  function render() {
    generalWrap.replaceChildren(buildTable(general));
    megaWrap.replaceChildren(buildTable(megas));
  }

  root.append(
    el("p", { class: "hint" }, `出典: バトルデータベース（シングル・シーズン${store.usage?.season || store.regulation?.season || ""}）。使用率の高い順。各行「ダメ計で使う」で攻撃側に反映。`),
    search, typeChips.node,
    el("h3", { class: "fav-list-title" }, "一般ポケモン ランキング"),
    generalWrap,
    el("h3", { class: "fav-list-title" }, "メガシンカ ランキング"),
    megaWrap,
  );
  render();
  return root;
}

// =================== タブ2: ダメージ計算 ===================
function natureTriToggle(initial = "neutral") {
  // 攻撃/防御ステの性格補正 3択ボタン
  let state = initial;
  const btn = (val, label) => el("button", { type: "button", class: "tri" + (state === val ? " on" : ""), "data-v": val }, label);
  const wrap = el("div", { class: "tri-group" }, [btn("up", "↑1.1"), btn("neutral", "–1.0"), btn("down", "↓0.9")]);
  wrap.get = () => ({ up: 1.1, neutral: 1.0, down: 0.9 }[state]);
  wrap.set = (val) => {
    state = val;
    wrap.querySelectorAll("button.tri").forEach((x) => x.classList.toggle("on", x.dataset.v === state));
  };
  wrap.addEventListener("click", (e) => {
    const b = e.target.closest("button.tri"); if (!b) return;
    state = b.dataset.v;
    wrap.querySelectorAll("button.tri").forEach((x) => x.classList.toggle("on", x.dataset.v === state));
    wrap.dispatchEvent(new CustomEvent("trichange"));
  });
  return wrap;
}
function spInput(initial, id) {
  return el("input", { type: "number", min: "0", max: String(SP_MAX_PER_STAT), value: String(initial), class: "sp-input", id });
}

// --- ダメージ計算の共通部品 ---
function clampSPVal(v) { return Math.max(0, Math.min(SP_MAX_PER_STAT, parseInt(v || "0", 10) || 0)); }
function itemObj(name) { return name ? store.itemsByName.get(name) || null : null; }

// 現レギュ合法か（regulation の legal_items 集合で判定。空ならフォールバックで全許可）。
function isItemLegal(it) {
  return store.legalItems.size === 0 || store.legalItems.has(it.name);
}
// 持てる対戦アイテム（メガストーン除外・現レギュ合法のみ）を日本語名順に。
function holdableItems() {
  return store.items
    .filter((it) => it.holdable && it.category !== "mega-stones" && it.nameJp && it.nameJp !== it.name && isItemLegal(it))
    .sort((a, b) => a.nameJp.localeCompare(b.nameJp, "ja"));
}
// 役割が一致する道具だけ（side="atk"=威力関連 / "def"=防御関連）。効果文付きで返す。
function roleItems(side) {
  return holdableItems().filter((it) => itemRole(it)[side]);
}
// 持ち物のカテゴリ分類（optgroupの見出し）。計算ロジック(itemRole)と item.category で判定。
const ITEM_GROUP_ORDER = {
  atk: ["威力アップ", "こだわり", "タイプ強化（×1.2）", "専用", "その他"],
  def: ["耐久", "その他"],
};
function itemGroup(it, side) {
  const r = itemRole(it);
  const name = it.name;
  if (side === "atk") {
    if (name === "Light Ball" || name === "Thick Club") return "専用";
    if (/こだわり/.test(r.jp)) return "こだわり";
    if (it.category === "type-enhancement" || /タイプの技/.test(r.jp)) return "タイプ強化（×1.2）";
    return "威力アップ"; // 残りの攻撃寄与（いのちのたま/おび/ハチマキ/メガネ等）
  }
  return "耐久"; // 防御寄与（チョッキ/きせき等）
}
// ダメ計用の持ち物セレクト。side で攻/防の効果あり道具のみに絞り、カテゴリ別optgroupで表示。
function realItemSelect(side, onChange) {
  const order = ITEM_GROUP_ORDER[side] || ["その他"];
  const buckets = new Map(order.map((g) => [g, []]));
  for (const it of roleItems(side)) {
    (buckets.get(itemGroup(it, side)) || buckets.get("その他")).push(it);
  }
  const sel = el("select", { class: "item-select", onchange: onChange }, [el("option", { value: "" }, "道具なし")]);
  for (const g of order) {
    const items = buckets.get(g);
    if (!items || !items.length) continue;
    sel.appendChild(el("optgroup", { label: g }, items.map((it) => {
      const r = itemRole(it);
      return el("option", { value: it.name }, r.jp ? `${it.nameJp}（${r.jp}）` : it.nameJp);
    })));
  }
  return sel;
}
// ランク補正セレクト(+6〜-6)
function rankSelect(onChange) {
  const opts = [];
  for (let n = 6; n >= -6; n--) opts.push(el("option", { value: String(n) }, n === 0 ? "補正なし" : (n > 0 ? `+${n}` : `${n}`)));
  const s = el("select", { class: "stage-select", onchange: onChange }, opts);
  s.value = "0";
  return s;
}
// 特性の効果文（abilities.json）を名前→説明でひく（初回だけMap化）。
let _abilDescMap = null;
function abilDesc(name) {
  if (!_abilDescMap) _abilDescMap = new Map((store.abilities || []).map((a) => [a.name, a.description]));
  return _abilDescMap.get(name) || "";
}
// 指定ポケモンの候補特性でセレクトを埋める。既定は最採用とくせい(topAbility)。
// 各選択肢に効果文ツールチップ(title)を付与。計算未対応の特性は注記。
function fillAbilitySelect(sel, pokemon) {
  const abils = pokemon.abilities || [];
  const jp = pokemon.abilitiesJp || [];
  const opts = [el("option", { value: "" }, "特性なし／影響なし")];
  abils.forEach((a, i) => {
    const supp = isAbilitySupported(a) ? "" : "（計算未対応）";
    const o = el("option", { value: a }, `${jp[i] || a}${supp}`);
    const d = abilDesc(a);
    if (d) o.title = d;
    opts.push(o);
  });
  sel.replaceChildren(...opts);
  // 既定＝最採用とくせい。無ければ第一とくせい（「影響なし」にはしない）。
  sel.value = pokemon.topAbility && abils.includes(pokemon.topAbility) ? pokemon.topAbility : (abils[0] || "");
}
function fieldSelect(list, onChange) {
  return el("select", { onchange: onChange }, list.map((o) => el("option", { value: o.id }, o.label)));
}

// 1技分のダメージ計算（全条件込み）。cond はUIから集めた条件。
function computeOne(attacker, defender, move, cond) {
  const physical = move.category === "Physical";
  const atkKey = physical ? "atk" : "spa";
  const defKey = physical ? "def" : "spd";
  // -ate特性（スカイスキン等）でわざタイプが変わるなら、相性/一致の前に反映。
  const ate = ateConversion(cond.atkAbility, move.type);
  const moveType = ate ? ate.type : move.type;
  const ateBoost = ate ? ate.boost : 1;
  const eff = typeEffectiveness(moveType, defender.types, store.typechart.chart);

  let atkStat = calcStat(attacker.base[atkKey], cond.atkSP, atkKey, cond.atkNat);
  // 防御は B(防御)/D(特防) を分けて持てる。技の物理/特殊で当たる方を使う。
  // 逆算タブ等は単一値 cond.defSP/defNat を渡すので、それがあれば優先（後方互換）。
  const defInvest = cond.defSP != null ? cond.defSP : (physical ? cond.defBsp : cond.defDsp) || 0;
  const defNat = cond.defNat != null ? cond.defNat : (physical ? cond.defBnat : cond.defDnat) || 1.0;
  let defStat = calcStat(defender.base[defKey], defInvest, defKey, defNat);
  const maxHp = calcStat(defender.base.hp, cond.defHpSP, "hp", 1.0);

  const f = move.flags || {};
  const ctx = {
    physical, moveType, moveName: move.name, attackerName: attacker.name,
    typeEff: eff, defenderFullHp: cond.remainPct >= 100, basePower: move.power,
    // わざフラグ（とくせい全網羅の判定材料）
    contact: !!f.contact, punch: !!f.punch, bite: !!f.bite, pulse: !!f.pulse,
    sound: !!f.sound, hasSecondary: !!move.hasSecondary, recoil: !!move.isRecoil, crit: !!cond.crit,
  };
  const aA = abilityMods(cond.atkAbility, "atk", ctx); // 攻撃欄＝攻撃用の効果のみ
  const dA = abilityMods(cond.defAbility, "def", ctx); // 防御欄＝防御用の効果のみ
  const aI = itemMods(cond.atkItem, ctx);
  const dI = itemMods(cond.defItem, ctx);

  // ランク補正 → ステ倍率（道具/特性） → 天候の防御ステ
  atkStat = Math.floor(atkStat * statStageMultiplier(cond.atkRank));
  const atkStatMult = (aA.atkStat || 1) * (aI.atkStat || 1);
  if (atkStatMult !== 1) atkStat = Math.floor(atkStat * atkStatMult);

  atkStat = Math.max(1, atkStat);
  defStat = Math.floor(defStat * statStageMultiplier(cond.defRank));
  const wds = weatherDefStatMult(cond.weather, defender.types);
  const defStatMult = (dA.defStat || 1) * (dI.defStat || 1) * (physical ? wds.def : wds.spd);
  if (defStatMult !== 1) defStat = Math.floor(defStat * defStatMult);
  defStat = Math.max(1, defStat);

  const stab = aA.stab ? aA.stab : stabMultiplier(moveType, attacker.types);
  const immune = !!dA.immune;
  const weatherMult = weatherDamageMult(cond.weather, moveType);
  const chainMults = [
    terrainDamageMult(cond.terrain, moveType, move.name),
    screenMult(cond.screen, physical, cond.crit),
    ateBoost,
    aA.dmg || 1, dA.dmg || 1, aI.dmg || 1, dI.dmg || 1,
  ];
  const burn = physical && cond.burn;
  const { rolls } = computeDamage({
    power: move.power, atkStat, defStat, stab, typeEff: eff,
    crit: cond.crit, burn, immune, weatherMult, chainMults,
  });
  const currentHp = Math.max(1, Math.floor(maxHp * Math.min(100, Math.max(0, cond.remainPct)) / 100));
  return { rolls, summary: summarize(rolls, maxHp, currentHp), eff, immune, stab, maxHp, physical };
}

function damageTab(preset) {
  const root = el("div", { class: "tab-panel" });
  let attacker, defender;

  // 攻撃側
  const atkSel = pokemonSelect((p) => { attacker = p; pushRecent(RECENT_ATK_KEY, p.name, RECENT_CAP); renderAtkRecents(); refreshMoves(); fillAbilitySelect(atkAbilSel, p); applyMega(atkItemSel, p); render(); }, "atk-poke");
  const moveSel = el("select", { class: "move-select", onchange: render });
  // #2 わざ検索（かな/英/部分一致でわざ欄を絞り込み）
  const moveSearch = el("input", { type: "search", class: "search move-search", placeholder: "🔍 わざ名で絞り込み（かな/英）",
    oninput: () => refreshMoves(moveSearch.value) });
  const atkSP = spInput(SP_MAX_PER_STAT, "atk-sp");
  const atkNature = natureTriToggle("up");
  const atkRankSel = rankSelect(render);
  const atkAbilSel = el("select", { class: "abil-select", onchange: render });
  const atkItemSel = realItemSelect("atk", render);
  const atkRecents = el("div", { class: "recents" });
  function renderAtkRecents() {
    const names = loadRecent(RECENT_ATK_KEY);
    if (!names.length) {
      atkRecents.replaceChildren(el("span", { class: "dim recents-empty" }, "（最近使った攻撃ポケモンがここに出ます）"));
      return;
    }
    atkRecents.replaceChildren(...names.map((nm) => {
      const p = store.pokemonByName.get(nm);
      if (!p) return null;
      return el("button", { type: "button", class: "chip-btn",
        onclick: () => { atkSel.value = nm; attacker = p; pushRecent(RECENT_ATK_KEY, nm, RECENT_CAP); renderAtkRecents(); refreshMoves(); fillAbilitySelect(atkAbilSel, p); applyMega(atkItemSel, p); render(); } }, p.nameJp);
    }).filter(Boolean));
  }

  // 使用率ランキング順のポケモン（攻守の「ランキングから選択」で共用）
  const rankedList = store.legalPokemon.filter((p) => p.usageRankSingle)
    .sort((a, b) => a.usageRankSingle - b.usageRankSingle || (a.form === "Mega") - (b.form === "Mega"));
  function rankOptions(placeholder) {
    return [el("option", { value: "" }, placeholder),
      ...rankedList.map((p) => el("option", { value: p.name }, `#${p.usageRankSingle} ${p.nameJp}`))];
  }

  // 攻撃側: お気に入りから選択（型ごと反映）
  const atkFavSel = el("select", { class: "item-select" });
  function fillAtkFavSelect() {
    const favs = loadFavorites();
    atkFavSel.replaceChildren(
      el("option", { value: "" }, favs.length ? "お気に入りから選択…" : "（お気に入り未登録）"),
      ...favs.map((f) => {
        const fp = store.pokemonByName.get(f.pokemon);
        return el("option", { value: f.id }, `${f.label}${fp ? ` / ${fp.nameJp}` : ""}`);
      }));
  }
  atkFavSel.addEventListener("change", () => {
    const rec = loadFavorites().find((f) => f.id === atkFavSel.value);
    if (rec) { applyAttackerPreset(rec); pushRecent(RECENT_ATK_KEY, attacker.name, RECENT_CAP); renderAtkRecents(); render(); }
    atkFavSel.value = "";
  });
  // 攻撃側: ランキングから選択（名前のみ反映）
  const atkRankPickSel = el("select", { class: "item-select" }, rankOptions("ランキングから選択…"));
  atkRankPickSel.addEventListener("change", () => {
    const nm = atkRankPickSel.value; if (!nm) return;
    applyAttackerPreset({ pokemon: nm }); pushRecent(RECENT_ATK_KEY, nm, RECENT_CAP); renderAtkRecents(); render();
    atkRankPickSel.value = "";
  });
  // 攻撃側: 現在の入力をマイポケモン（お気に入り）に登録（編集画面で仕上げ）
  const atkSaveBtn = el("button", { type: "button", class: "mini", onclick: () => {
    const move = store.movesByName.get(moveSel.value);
    const atkKey = move && move.category === "Physical" ? "atk" : "spa";
    const sp = emptySpread(); sp[atkKey] = clampSPVal(atkSP.value);
    const itemJp = atkItemSel.disabled ? "" : (store.itemsByName.get(atkItemSel.value)?.nameJp || "");
    nav.open(TAB.FAV, { newFrom: { pokemon: attacker.name, item: itemJp, moves: move ? [move.name] : [], sp } });
  } }, "この攻撃をマイポケモンに登録");

  // 防御側
  const defSel = pokemonSelect((p) => commitDefenderSelection(p), "def-poke");
  const defRecents = el("div", { class: "recents" });
  // 履歴要素(旧:文字列 / 新:スナップショット)を正規化。
  function asSnap(x) { return typeof x === "string" ? { pokemon: x } : (x || {}); }
  // 防御側の現在設定をスナップショット化（SP/性格/持ち物/特性）。
  function defSnapshot() {
    const natState = (m) => (m > 1 ? "up" : m < 1 ? "down" : "neutral");
    return {
      pokemon: defender.name,
      hpSp: clampSPVal(defHpSP.value), bSp: clampSPVal(defBSP.value), dSp: clampSPVal(defDSP.value),
      natB: natState(defNatB.get()), natD: natState(defNatD.get()),
      item: defItemSel.disabled ? "" : (defItemSel.value || ""), ability: defAbilSel.value || "",
    };
  }
  // 新規に防御ポケモンを確定。特性/持ち物はリセット、SP/性格は引き継ぎ、履歴先頭へ。
  function commitDefenderSelection(p) {
    defender = p; defSel.value = p.name;
    fillAbilitySelect(defAbilSel, p); applyMega(defItemSel, p);
    upsertRecentSnap(RECENT_DEF_KEY, defSnapshot(), RECENT_CAP);
    resetLog(); // 防御を変えたらログは整合のためクリア
    renderRecents(); render();
  }
  // 履歴スナップショットを防御側にまるごと復元。
  function restoreDefenderSnapshot(e) {
    const s = asSnap(e);
    const p = store.pokemonByName.get(s.pokemon); if (!p) return;
    defender = p; defSel.value = p.name;
    defHpSP.value = String(s.hpSp ?? 0); defBSP.value = String(s.bSp ?? 0); defDSP.value = String(s.dSp ?? 0);
    defNatB.set(s.natB || "neutral"); defNatD.set(s.natD || "neutral");
    fillAbilitySelect(defAbilSel, p); defAbilSel.value = s.ability || "";
    applyMega(defItemSel, p);
    if (s.item) { defItemSel.value = s.item; if (defItemSel.value !== s.item) defItemSel.value = ""; }
    upsertRecentSnap(RECENT_DEF_KEY, defSnapshot(), RECENT_CAP);
    resetLog();
    renderRecents(); render();
  }
  // 履歴チップの詳細行（SP/性格/持ち物/特性の要約）。旧データ(名前のみ)は空。
  function defSnapSummary(s, p) {
    if (s.hpSp == null && s.bSp == null && s.dSp == null && !s.item && !s.ability) return "";
    const arrow = (v) => (v === "up" ? "↑" : v === "down" ? "↓" : "");
    const parts = [`H${s.hpSp || 0} B${s.bSp || 0}${arrow(s.natB)} D${s.dSp || 0}${arrow(s.natD)}`];
    if (s.ability && p) { const i = (p.abilities || []).indexOf(s.ability); parts.push(i >= 0 ? (p.abilitiesJp?.[i] || s.ability) : s.ability); }
    if (s.item) parts.push(store.itemsByName.get(s.item)?.nameJp || s.item);
    return parts.join(" / ");
  }
  function renderRecents() {
    const entries = loadRecent(RECENT_DEF_KEY);
    if (!entries.length) {
      defRecents.replaceChildren(el("span", { class: "dim recents-empty" }, "（最近使った防御ポケモンがここに出ます）"));
      return;
    }
    defRecents.replaceChildren(...entries.map((e) => {
      const s = asSnap(e);
      const p = store.pokemonByName.get(s.pokemon);
      if (!p) return null;
      const summary = defSnapSummary(s, p);
      return el("button", { type: "button", class: "chip-btn chip-snap", title: summary ? `${p.nameJp} ／ ${summary}` : p.nameJp,
        onclick: () => restoreDefenderSnapshot(s) },
        [el("span", { class: "chip-name" }, p.nameJp), summary ? el("small", { class: "chip-sub" }, summary) : null].filter(Boolean));
    }).filter(Boolean));
  }
  attacker = store.pokemonByName.get(atkSel.value);
  defender = store.pokemonByName.get(defSel.value);
  const defHpSP = spInput(0, "def-hp-sp");
  const defBSP = spInput(0, "def-b-sp");   // 防御(B)への努力値
  const defDSP = spInput(0, "def-d-sp");   // 特防(D)への努力値
  const defNatB = natureTriToggle("neutral"); // 防御の性格補正
  const defNatD = natureTriToggle("neutral"); // 特防の性格補正
  const defRankSel = rankSelect(render);
  const defAbilSel = el("select", { class: "abil-select", onchange: render });
  const defItemSel = realItemSelect("def", render);
  const remainHp = el("input", { type: "number", min: "0", max: "100", value: "100", class: "sp-input", id: "def-remain" });
  // 防御側: ランキングから選択（名前のみ反映）
  const defRankPickSel = el("select", { class: "item-select" }, rankOptions("ランキングから選択…"));
  defRankPickSel.addEventListener("change", () => {
    const nm = defRankPickSel.value; if (!nm) return;
    const p = store.pokemonByName.get(nm); if (!p) { defRankPickSel.value = ""; return; }
    commitDefenderSelection(p);
    defRankPickSel.value = "";
  });

  // 場（共通）
  const weatherSel = fieldSelect(WEATHERS, render);
  const terrainSel = fieldSelect(TERRAINS, render);
  const screenSel = fieldSelect(SCREENS, render);

  // 補正トグル
  const cbCrit = el("input", { type: "checkbox", onchange: render });
  const cbBurn = el("input", { type: "checkbox", onchange: render });
  const cbAll = el("input", { type: "checkbox", onchange: render });
  // 全技ダメ計のとき、技を「そのタイプ」で絞り込むチップ（複数選択OR）
  const allTypeChips = typeFilterChips(render);

  [atkSP, defHpSP, defBSP, defDSP, remainHp].forEach((i) => i.addEventListener("input", render));
  atkNature.addEventListener("trichange", render);
  defNatB.addEventListener("trichange", render);
  defNatD.addEventListener("trichange", render);

  const result = el("div", { class: "dmg-result" });       // 結論＋数値（モバイルでは上部に小さく固定）
  const resultMore = el("div", { class: "dmg-result-more" }); // 内訳・乱数・ログ追加（非固定でスクロール）

  // --- #13 ダメージログ（防御固定で複数技を累積・セッション内のみ）---
  const logPanel = el("div", { class: "dmg-log" });
  const logEntries = []; // { name, min, max, maxHp, include }
  function renderLog() {
    if (!logEntries.length) { logPanel.replaceChildren(); return; }
    const inc = logEntries.filter((e) => e.include);
    const sumMin = inc.reduce((s, e) => s + e.min, 0);
    const sumMax = inc.reduce((s, e) => s + e.max, 0);
    const hp = (inc.length ? inc[inc.length - 1] : logEntries[logEntries.length - 1]).maxHp;
    let cls = "no", txt = `✕ 合計でも倒せない（合計${sumMin}〜${sumMax} / 相手HP${hp}）`;
    if (sumMin >= hp) { cls = "ok"; txt = `✓ 合計で確定で倒せる（${inc.length}発・合計${sumMin}〜${sumMax} / 相手HP${hp}）`; }
    else if (sumMax >= hp) { cls = "maybe"; txt = `△ 合計で乱数で倒せる（合計${sumMin}〜${sumMax} / 相手HP${hp}）`; }
    logPanel.replaceChildren(
      el("h4", { class: "card-sub" }, "ダメージログ（防御固定で複数技を合算）"),
      el("div", { class: "verdict " + cls }, txt),
      el("ul", { class: "log-list" }, logEntries.map((e, i) => el("li", { class: "log-item" + (e.include ? "" : " off") }, [
        el("label", {}, [
          el("input", { type: "checkbox", checked: e.include ? "checked" : null,
            onchange: (ev) => { e.include = ev.target.checked; renderLog(); } }),
          ` ${e.name}：${e.min}〜${e.max}`,
        ]),
        el("button", { type: "button", class: "mini danger", onclick: () => { logEntries.splice(i, 1); renderLog(); } }, "削除"),
      ]))),
      el("button", { type: "button", class: "mini", onclick: () => { logEntries.length = 0; renderLog(); } }, "ログを全消去"),
    );
  }
  function resetLog() { logEntries.length = 0; renderLog(); }

  // メガ個体なら持ち物をメガストーンに固定。非メガなら解除。
  function applyMega(itemSel, p) {
    if (p.form === "Mega" && p.megaStone) {
      // メガストーンは holdableItems に無いので option を一時追加して選択
      if (![...itemSel.options].some((o) => o.value === p.megaStone.name)) {
        itemSel.appendChild(el("option", { value: p.megaStone.name }, p.megaStone.nameJp));
      }
      itemSel.value = p.megaStone.name; itemSel.disabled = true; itemSel.classList.add("locked");
    } else {
      itemSel.disabled = false; itemSel.classList.remove("locked");
      if (itemSel.value && store.itemsByName.get(itemSel.value)?.category === "mega-stones") itemSel.value = "";
    }
  }

  // 攻撃側の図鑑番号に対応するわざ採用率（日本語技名→%）。
  function moveAdoption() {
    return (store.usage?.moveAdoptionByDex || {})[String(attacker.dexNumber)] || {};
  }
  // #2: 物理/特殊で分け→各群「タイプ一致(★)を上→採用率降順→威力降順」。検索で部分一致フィルタ。
  function refreshMoves(query = "") {
    const adopt = moveAdoption();
    const q = (query || "").trim();
    let list = attackingMovesFor(attacker);
    if (q) list = list.filter((m) => normJa(m.nameJp || "").includes(normJa(q)) || normJa(m.name).includes(normJa(q)));
    const isStab = (m) => (attacker.types || []).includes(m.type);
    const rateOf = (m) => (adopt[m.nameJp] ?? adopt[m.name] ?? -1);
    const sortFn = (a, b) => (isStab(b) - isStab(a)) || (rateOf(b) - rateOf(a)) || ((b.power || 0) - (a.power || 0));
    const optFor = (m) => {
      const r = rateOf(m);
      const label = `${isStab(m) ? "★" : ""}${m.nameJp || m.name}（威${m.power}${r >= 0 ? ` 採用${r}%` : ""}）`;
      const o = el("option", { value: m.name }, label);
      o.style.color = isStab(m) ? "" : "";
      return o;
    };
    const groups = [];
    const phys = list.filter((m) => m.category === "Physical").sort(sortFn);
    const spec = list.filter((m) => m.category === "Special").sort(sortFn);
    if (phys.length) groups.push(el("optgroup", { label: "物理わざ（★=タイプ一致／採用率順）" }, phys.map(optFor)));
    if (spec.length) groups.push(el("optgroup", { label: "特殊わざ（★=タイプ一致／採用率順）" }, spec.map(optFor)));
    const cur = moveSel.value;
    moveSel.replaceChildren(...groups);
    if ([...moveSel.options].some((o) => o.value === cur)) moveSel.value = cur;
  }

  function gatherCond() {
    return {
      atkSP: clampSPVal(atkSP.value), atkNat: atkNature.get(),
      // 防御は B/D 別々に渡す。computeOne が技の物理/特殊で当たる方を使う。
      defBsp: clampSPVal(defBSP.value), defBnat: defNatB.get(),
      defDsp: clampSPVal(defDSP.value), defDnat: defNatD.get(),
      defHpSP: clampSPVal(defHpSP.value),
      atkRank: parseInt(atkRankSel.value, 10) || 0, defRank: parseInt(defRankSel.value, 10) || 0,
      atkAbility: atkAbilSel.value, defAbility: defAbilSel.value,
      atkItem: itemObj(atkItemSel.value), defItem: itemObj(defItemSel.value),
      weather: weatherSel.value, terrain: terrainSel.value, screen: screenSel.value,
      crit: cbCrit.checked, burn: cbBurn.checked,
      remainPct: Math.min(100, Math.max(0, parseInt(remainHp.value || "100", 10) || 0)),
    };
  }
  function effLabelOf(eff, immune) {
    if (immune) return "無効（特性）";
    return eff === 0 ? "効果なし" : eff > 1 ? `効果抜群 ×${eff}` : eff < 1 ? `いまひとつ ×${eff}` : "等倍";
  }

  function render() {
    // 防御履歴の先頭が現在の防御ポケモンなら、編集中の設定を逐次反映（実際に使った状態を保存）。
    // 内容が変わった時だけチップを再描画して、表示と復元データを最新に保つ。
    if (syncRecentSnapFront(RECENT_DEF_KEY, defSnapshot())) renderRecents();
    const cond = gatherCond();
    if (cbAll.checked) return renderAll(cond);
    const move = store.movesByName.get(moveSel.value);
    if (!move) { result.replaceChildren(el("p", {}, "技データがありません")); resultMore.replaceChildren(); return; }
    const r = computeOne(attacker, defender, move, cond);
    const s = r.summary;
    const curHp = Math.max(1, Math.floor(r.maxHp * cond.remainPct / 100));
    // 固定部：結論＋数値だけ（モバイルで画面を覆わないよう最小限）
    result.replaceChildren(el("div", {}, [
      verdictBadge(r, curHp),
      el("div", { class: "dmg-headline" }, [
        el("span", { class: "dmg-num" }, `${s.min}〜${s.max}`),
        el("span", { class: "dmg-pct" }, `相手のHPを ${s.pctMin.toFixed(1)}〜${s.pctMax.toFixed(1)}% 削る`),
      ]),
    ]));
    // 非固定部：内訳・乱数・ログ追加（スクロールして読む）
    resultMore.replaceChildren(
      el("div", { class: "dmg-detail" }, [
        `${attacker.nameJp} の ${move.nameJp || move.name} → ${defender.nameJp}`, el("br"),
        `相手HP実数値 ${r.maxHp}${cond.remainPct < 100 ? `（残り${cond.remainPct}% = ${curHp}）` : ""} ・ ${effLabelOf(r.eff, r.immune)}${r.stab > 1 ? ` ・ タイプ一致×${r.stab}` : ""} ・ ${s.label}`,
      ]),
      el("details", { class: "rolls" }, [
        el("summary", {}, "乱数をくわしく（ダメージ / 削れる割合 / 出る確率）"),
        el("div", { class: "roll-grid" }, rollCells(r.rolls, r.maxHp, curHp)),
        koLine(r.rolls, curHp),
      ]),
      el("div", { class: "fav-actions" }, [
        el("button", { type: "button", class: "mini", onclick: () => {
          logEntries.push({ name: `${move.nameJp || move.name}`, min: s.min, max: s.max, maxHp: r.maxHp, include: true });
          renderLog();
        } }, "＋このダメージをログに追加"),
      ]),
    );
  }
  // 結論を信号色で一目で。緑=確定で倒せる / 黄=乱数で倒せる / 赤=倒せない。
  function verdictBadge(r, curHp) {
    const s = r.summary;
    if (r.immune) return el("div", { class: "verdict no" }, "効果なし（特性で無効）");
    if (r.eff === 0 || s.max === 0) return el("div", { class: "verdict no" }, "効果なし（ダメージなし）");
    const ko = r.rolls.filter((v) => v >= curHp).length;
    if (s.guaranteed === 1) return el("div", { class: "verdict ok" }, "✓ 確定1発で倒せる");
    if (ko > 0) return el("div", { class: "verdict maybe" }, `△ 乱数1発で倒せる（${(ko / r.rolls.length * 100).toFixed(0)}%）`);
    if (s.guaranteed) return el("div", { class: "verdict no" }, `1発では落ちない（確定${s.guaranteed}発・最大${s.pctMax.toFixed(0)}%）`);
    return el("div", { class: "verdict no" }, `${r.rolls.length}発でも倒せない（最大${s.pctMax.toFixed(0)}%）`);
  }
  // 乱数16通り（85〜100は各1/16で等確率）。丸めで同じダメージ値になる分を合算した確率を表示。
  function rollCells(rolls, maxHp, curHp) {
    const freq = new Map();
    for (const v of rolls) freq.set(v, (freq.get(v) || 0) + 1);
    return [...freq.keys()].sort((a, b) => a - b).map((v) => {
      const ko = v >= curHp;
      return el("span", { class: "roll-cell" + (ko ? " ko" : "") }, [
        el("b", {}, String(v)),
        el("small", {}, `${(v / maxHp * 100).toFixed(1)}%`),
        el("small", { class: "prob" }, `${(freq.get(v) / rolls.length * 100).toFixed(1)}%`),
      ]);
    });
  }
  function koLine(rolls, curHp) {
    const ko = rolls.filter((v) => v >= curHp).length;
    if (ko === 0 || ko === rolls.length) return null;
    return el("div", { class: "dmg-detail" }, `この技1発で倒せる確率: ${(ko / rolls.length * 100).toFixed(1)}%（${ko}/${rolls.length}）`);
  }

  function renderAll(cond) {
    const moves = attackingMovesFor(attacker).filter((m) => allTypeChips.matches([m.type]));
    const rows = moves.map((m) => ({ m, r: computeOne(attacker, defender, m, cond) }))
      .sort((a, b) => b.r.summary.pctMax - a.r.summary.pctMax);
    const table = el("table", { class: "data-table" }, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "わざ"), el("th", {}, "タイプ"), el("th", { class: "num" }, "威力"),
        el("th", { class: "num" }, "ダメージ"), el("th", { class: "num" }, "削れる割合"), el("th", {}, "確定数"),
      ])),
      el("tbody", {}, rows.map(({ m, r }) => el("tr", {}, [
        el("td", {}, el("span", { class: "pname" }, m.nameJp || m.name)),
        el("td", {}, typeBadges([m.type])),
        el("td", { class: "num dim" }, String(m.power)),
        el("td", { class: "num hl" }, `${r.summary.min}〜${r.summary.max}`),
        el("td", { class: "num" }, `${r.summary.pctMin.toFixed(1)}〜${r.summary.pctMax.toFixed(1)}%`),
        el("td", { class: (r.summary.guaranteed === 1 ? "bad" : "") }, r.summary.label),
      ]))),
    ]);
    // 全技一括は表が大きいので固定部は空にし、非固定部へ出す（画面を覆わない）
    result.replaceChildren();
    resultMore.replaceChildren(
      el("div", { class: "dmg-detail" }, `${attacker.nameJp} → ${defender.nameJp}（覚える攻撃技を一括計算・与ダメ割合の高い順）`),
      allTypeChips.node,
      rows.length ? el("div", { class: "table-wrap" }, table) : el("p", { class: "hint" }, "選択タイプの技がありません"),
    );
  }

  // コア入力（常時表示）: まずこの3つだけで結論が出る
  const coreGrid = el("div", { class: "dmg-grid" }, [
    el("section", { class: "card" }, [
      el("h3", {}, "攻撃側"),
      labeled("ポケモン", atkSel),
      el("div", { class: "fav-row2" }, [labeled("お気に入りから", atkFavSel), labeled("ランキングから", atkRankPickSel)]),
      el("div", { class: "field" }, [el("label", {}, "最近使った攻撃"), atkRecents]),
      el("div", { class: "field" }, [el("label", {}, "わざ"), moveSearch, moveSel]),
      el("div", { class: "fav-actions" }, [atkSaveBtn]),
    ]),
    el("section", { class: "card" }, [
      el("h3", {}, "防御側"),
      labeled("ポケモン", defSel),
      labeled("ランキングから", defRankPickSel),
      el("div", { class: "field" }, [el("label", {}, "最近使った防御"), defRecents]),
    ]),
  ]);

  // --- #3 ワンタップ入力 ---
  const setSP = (input, val) => { input.value = String(val); input.dispatchEvent(new Event("input")); };
  const quick = (label, title, onClick) => el("button", { type: "button", class: "mini sp-quick", title, onclick: onClick }, label);
  // 数値SP欄の横に「32」ボタンを添える
  const labeledSP = (label, input) => el("div", { class: "field" }, [
    el("label", {}, label),
    el("div", { class: "sp-quick-wrap" }, [input, quick("32", "最大(32)にする", () => { setSP(input, SP_MAX_PER_STAT); render(); })]),
  ]);
  // 攻撃側プリセット（攻撃ステの投資量＝ダメ計に素早さは不使用）
  const atkPresets = el("div", { class: "sp-quick-row" }, [
    el("span", { class: "dim sp-quick-label" }, "一発設定:"),
    quick("最速", "攻撃SP32＋性格↑", () => { setSP(atkSP, SP_MAX_PER_STAT); atkNature.set("up"); render(); }),
    quick("準速", "攻撃SP32＋無補正", () => { setSP(atkSP, SP_MAX_PER_STAT); atkNature.set("neutral"); render(); }),
    quick("無振り", "攻撃SP0", () => { setSP(atkSP, 0); atkNature.set("down"); render(); }),
  ]);

  // 詳細設定（折りたたみ）: SP・性格・とくせい・持ち物・ランク・場・補正
  const advGrid = el("div", { class: "dmg-grid" }, [
    el("section", { class: "card" }, [
      el("h4", { class: "card-sub" }, "攻撃側の詳細"),
      el("div", { class: "fav-row2" }, [labeledSP("攻撃SP(0-32)", atkSP), labeled("ランク補正", atkRankSel)]),
      atkPresets,
      labeled("性格補正", atkNature),
      labeled("とくせい", atkAbilSel),
      labeled("持ち物", atkItemSel),
    ]),
    el("section", { class: "card" }, [
      el("h4", { class: "card-sub" }, "防御側の詳細"),
      el("div", { class: "fav-row2" }, [labeledSP("HP SP(0-32)", defHpSP), labeled("残りHP(%)", remainHp)]),
      el("p", { class: "hint" }, "防御(B)=物理技を受ける時／特防(D)=特殊技を受ける時に使われます。"),
      el("div", { class: "fav-row2" }, [labeledSP("防御SP(0-32)", defBSP), labeledSP("特防SP(0-32)", defDSP)]),
      el("div", { class: "fav-row2" }, [labeled("防御の性格補正", defNatB), labeled("特防の性格補正", defNatD)]),
      labeled("ランク補正", defRankSel),
      labeled("とくせい", defAbilSel),
      labeled("持ち物", defItemSel),
    ]),
  ]);
  const fieldRow = el("section", { class: "card" }, [
    el("h4", { class: "card-sub" }, "場の状態"),
    el("div", { class: "sp-controls" }, [labeled("天候", weatherSel), labeled("フィールド", terrainSel), labeled("壁", screenSel)]),
  ]);
  const modRow = el("div", { class: "toggles" }, [
    el("label", { class: "toggle" }, [cbCrit, " 急所"]),
    el("label", { class: "toggle" }, [cbBurn, " やけど(物理×0.5)"]),
    el("label", { class: "toggle" }, [cbAll, " 全技ダメ計（一括）"]),
  ]);
  const moreDetails = el("details", { class: "more" }, [
    el("summary", {}, "詳細設定（SP・性格・とくせい・持ち物・ランク・天候・壁・急所など）"),
    advGrid, fieldRow, modRow,
  ]);

  // 結論を最上部に（モバイルでは画面上部に固定）→ 入力はその下
  root.append(
    result,
    resultMore,
    logPanel,
    el("p", { class: "hint" }, "相手と自分のポケモン・わざを選ぶだけで結論が出ます（攻撃SP最大・性格↑が初期値）。ランク補正・天候・壁・とくせい・持ち物は「詳細設定」で。とくせいは最採用を既定表示。「＋ログに追加」で複数技を合算できます。"),
    coreGrid, moreDetails
  );

  // お気に入り/流行りから攻撃側プリセットを反映
  function applyAttackerPreset(p) {
    if (p.pokemon && store.pokemonByName.has(p.pokemon)) {
      atkSel.value = p.pokemon; attacker = store.pokemonByName.get(p.pokemon);
      refreshMoves(); fillAbilitySelect(atkAbilSel, attacker); applyMega(atkItemSel, attacker);
    }
    if (p.move && Array.from(moveSel.options).some((o) => o.value === p.move)) moveSel.value = p.move;
    const move = store.movesByName.get(moveSel.value);
    const atkKey = move && move.category === "Physical" ? "atk" : "spa";
    if (p.sp) atkSP.value = String(clampSPVal(p.sp[atkKey] ?? 0));
    if (p.nature) atkNature.set(triFromNature(p.nature, atkKey));
    if (p.item && !atkItemSel.disabled) {
      const it = holdableItems().find((x) => x.nameJp === p.item || x.name === p.item);
      if (it) atkItemSel.value = it.name;
    }
  }

  refreshMoves();
  renderAtkRecents();
  fillAtkFavSelect();
  renderRecents();
  fillAbilitySelect(atkAbilSel, attacker);
  fillAbilitySelect(defAbilSel, defender);
  applyMega(atkItemSel, attacker);
  applyMega(defItemSel, defender);
  if (preset) applyAttackerPreset(preset);
  render();
  return root;
}

function labeled(label, control) {
  return el("div", { class: "field" }, [el("label", {}, label), control]);
}

// =================== タブ: 逆算（耐久調整 R1） ===================
function reverseTab() {
  const root = el("div", { class: "tab-panel" });
  let attacker, defender;

  // 攻撃側
  const atkSel = pokemonSelect((p) => { attacker = p; refreshMoves(); fillAbilitySelect(atkAbilSel, p); applyMega2(atkItemSel, p); render(); }, "rv-atk");
  const moveSel = el("select", { class: "move-select", onchange: render });
  const atkSP = spInput(SP_MAX_PER_STAT, "rv-atk-sp");
  const atkNature = natureTriToggle("up");
  const atkRankSel = rankSelect(render);
  const atkAbilSel = el("select", { class: "abil-select", onchange: render });
  const atkItemSel = realItemSelect("atk", render);

  // 防御側
  const defSel = pokemonSelect((p) => { defender = p; fillAbilitySelect(defAbilSel, p); applyMega2(defItemSel, p); render(); }, "rv-def");
  attacker = store.pokemonByName.get(atkSel.value);
  defender = store.pokemonByName.get(defSel.value);
  const defNature = natureTriToggle("neutral");
  const defAbilSel = el("select", { class: "abil-select", onchange: render });
  const defItemSel = realItemSelect("def", render);

  // 場
  const weatherSel = fieldSelect(WEATHERS, render);
  const terrainSel = fieldSelect(TERRAINS, render);
  const screenSel = fieldSelect(SCREENS, render);
  const cbCrit = el("input", { type: "checkbox", onchange: render });
  const cbBurn = el("input", { type: "checkbox", onchange: render });

  // 固定するSP（一方を固定し他方の必要量を求める）
  const fixHpSP = spInput(0, "rv-fix-hp");
  const fixDefSP = spInput(0, "rv-fix-def");
  [atkSP, fixHpSP, fixDefSP].forEach((i) => i.addEventListener("input", render));
  atkNature.addEventListener("trichange", render);
  defNature.addEventListener("trichange", render);

  const result = el("div", { class: "dmg-result" });

  function applyMega2(itemSel, p) {
    if (p.form === "Mega" && p.megaStone) {
      if (![...itemSel.options].some((o) => o.value === p.megaStone.name)) {
        itemSel.appendChild(el("option", { value: p.megaStone.name }, p.megaStone.nameJp));
      }
      itemSel.value = p.megaStone.name; itemSel.disabled = true; itemSel.classList.add("locked");
    } else {
      itemSel.disabled = false; itemSel.classList.remove("locked");
      if (itemSel.value && store.itemsByName.get(itemSel.value)?.category === "mega-stones") itemSel.value = "";
    }
  }
  function refreshMoves() {
    const list = attackingMovesFor(attacker);
    const order = store.typechart?.types || [];
    const byType = new Map();
    for (const m of list) { if (!byType.has(m.type)) byType.set(m.type, []); byType.get(m.type).push(m); }
    const types = [...byType.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    moveSel.replaceChildren(...types.map((t) => {
      const moves = byType.get(t).sort((a, b) => (b.power || 0) - (a.power || 0));
      return el("optgroup", { label: TYPE_JP[t] || t }, moves.map((m) =>
        el("option", { value: m.name }, `${m.nameJp || m.name}（${m.category === "Physical" ? "物理" : "特殊"}/威力${m.power}）`)));
    }));
  }

  function baseCond() {
    return {
      atkSP: clampSPVal(atkSP.value), atkNat: atkNature.get(),
      defNat: defNature.get(),
      atkRank: parseInt(atkRankSel.value, 10) || 0, defRank: 0,
      atkAbility: atkAbilSel.value, defAbility: defAbilSel.value,
      atkItem: itemObj(atkItemSel.value), defItem: itemObj(defItemSel.value),
      weather: weatherSel.value, terrain: terrainSel.value, screen: screenSel.value,
      crit: cbCrit.checked, burn: cbBurn.checked, remainPct: 100,
    };
  }
  // 確定1発耐え = 最大乱数でも倒れない（possible が 1 でない）
  function survives(move, defHpSP, defSP) {
    const r = computeOne(attacker, defender, move, { ...baseCond(), defHpSP, defSP });
    return { ok: r.summary.possible !== 1, r };
  }

  function render() {
    const move = store.movesByName.get(moveSel.value);
    if (!move) { result.replaceChildren(el("p", {}, "技データがありません")); return; }
    const physical = move.category === "Physical";
    const defStatJp = physical ? "ぼうぎょ" : "とくぼう";
    const hp = clampSPVal(fixHpSP.value);
    const dv = clampSPVal(fixDefSP.value);

    // 現状（固定値そのまま）
    const cur = computeOne(attacker, defender, move, { ...baseCond(), defHpSP: hp, defSP: dv });

    // ① HP固定 → 必要な防御SP最小
    let needDef = null;
    for (let d = 0; d <= SP_MAX_PER_STAT; d++) { if (survives(move, hp, d).ok) { needDef = d; break; } }
    // ② 防御固定 → 必要なHP SP最小
    let needHp = null;
    for (let h = 0; h <= SP_MAX_PER_STAT; h++) { if (survives(move, h, dv).ok) { needHp = h; break; } }

    const line = (label, val, unit) => el("div", { class: "fav-statline" }, val === null
      ? `${label}: SP最大でも確定耐え不可`
      : `${label}: ${unit} ${val}${val === 0 ? "（無振りでOK）" : ""}`);

    result.replaceChildren(
      el("div", { class: "dmg-headline" }, [
        el("span", { class: "dmg-num" }, `${cur.summary.min}〜${cur.summary.max}`),
        el("span", { class: "dmg-pct" }, `（${cur.summary.pctMin.toFixed(1)}% 〜 ${cur.summary.pctMax.toFixed(1)}%）`),
      ]),
      el("div", { class: "dmg-ko " + (cur.summary.possible === 1 ? "ko" : "") },
        cur.summary.possible === 1 ? `現状の配分(HP${hp}/${defStatJp}${dv})では確定耐えできない` : `現状の配分(HP${hp}/${defStatJp}${dv})で確定耐えOK`),
      el("div", { class: "dmg-detail" }, `${attacker.nameJp} の ${move.nameJp || move.name} を ${defender.nameJp} が「確定1発耐え」する条件`),
      line(`① HP SPを ${hp} に固定したとき必要な${defStatJp}`, needDef, "SP"),
      line(`② ${defStatJp}SPを ${dv} に固定したとき必要なHP`, needHp, "SP"),
    );
  }

  const grid = el("div", { class: "dmg-grid" }, [
    el("section", { class: "card" }, [
      el("h3", {}, "攻撃側（相手）"),
      labeled("ポケモン", atkSel),
      labeled("わざ", moveSel),
      el("div", { class: "fav-row2" }, [labeled("攻撃SP", atkSP), labeled("ランク補正", atkRankSel)]),
      labeled("性格補正", atkNature),
      labeled("とくせい", atkAbilSel),
      labeled("持ち物", atkItemSel),
    ]),
    el("section", { class: "card" }, [
      el("h3", {}, "防御側（自分）"),
      labeled("ポケモン", defSel),
      labeled("防御の性格補正", defNature),
      el("div", { class: "fav-row2" }, [labeled("固定HP SP", fixHpSP), labeled("固定 防御/特防 SP", fixDefSP)]),
      labeled("とくせい", defAbilSel),
      labeled("持ち物", defItemSel),
    ]),
  ]);
  const fieldRow = el("section", { class: "card" }, [
    el("h3", {}, "場の状態"),
    el("div", { class: "sp-controls" }, [labeled("天候", weatherSel), labeled("フィールド", terrainSel), labeled("壁", screenSel)]),
  ]);
  const modRow = el("div", { class: "toggles" }, [
    el("label", { class: "toggle" }, [cbCrit, " 急所"]),
    el("label", { class: "toggle" }, [cbBurn, " やけど(物理×0.5)"]),
  ]);

  root.append(
    el("p", { class: "hint" }, "相手の攻撃を「確定1発耐え」するのに必要な耐久SPを逆算します。HP/防御の片方を固定すると、もう片方の最小必要SPを表示。性格や持ち物・特性も考慮。"),
    grid, fieldRow, modRow, result
  );
  refreshMoves();
  fillAbilitySelect(atkAbilSel, attacker);
  fillAbilitySelect(defAbilSel, defender);
  applyMega2(atkItemSel, attacker);
  applyMega2(defItemSel, defender);
  render();
  return root;
}

// =================== タブ4: マイポケモン（お気に入り型） ===================
function moveJp(name) {
  if (!name) return "";
  const m = store.movesByName.get(name);
  return m ? (m.nameJp || m.name) : name;
}
function moveOptionNodes(pokemon) {
  const list = allMovesFor(pokemon);
  const order = store.typechart?.types || [];
  const byType = new Map();
  for (const m of list) {
    if (!byType.has(m.type)) byType.set(m.type, []);
    byType.get(m.type).push(m);
  }
  const types = [...byType.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const nodes = [el("option", { value: "" }, "（なし）")];
  for (const t of types) {
    const moves = byType.get(t).sort((a, b) => (b.power || 0) - (a.power || 0));
    nodes.push(el("optgroup", { label: TYPE_JP[t] || t }, moves.map((m) =>
      el("option", { value: m.name }, `${m.nameJp || m.name}${m.power ? `/威力${m.power}` : "/変化"}`))));
  }
  return nodes;
}

function favoritesTab(preset) {
  const root = el("div", { class: "tab-panel" });
  let editing = null;       // 編集中レコードid（null=新規）
  let selPoke;

  const clampSP = (v) => Math.max(0, Math.min(SP_MAX_PER_STAT, parseInt(v || "0", 10) || 0));

  const labelInput = el("input", { type: "text", class: "search", placeholder: "型名（例: 物理AS / 耐久HB）" });
  const pokeSel = pokemonSelect((p) => { selPoke = p; applyMegaItem(); rebuildMoves(); renderStats(); }, "fav-poke");
  selPoke = store.pokemonByName.get(pokeSel.value);
  const natSel = natureSelect("fav-nature");
  natSel.addEventListener("change", renderStats);

  // 持てる対戦アイテムのみ（メガストーンは自動反映するため除外・現レギュ合法のみ）を日本語名順に
  const pickerItems = holdableItems();
  const itemListId = "fav-item-list";
  const itemList = el("datalist", { id: itemListId }, pickerItems.map((it) => el("option", { value: it.nameJp })));
  const itemInput = el("input", { type: "text", class: "search", list: itemListId, placeholder: "持ち物（例: こだわりスカーフ）" });

  // メガ個体を選んだら持ち物を自動でメガストーンに固定。非メガに戻したら解除。
  function applyMegaItem() {
    if (selPoke.form === "Mega" && selPoke.megaStone) {
      itemInput.value = selPoke.megaStone.nameJp;
      itemInput.readOnly = true;
      itemInput.classList.add("locked");
    } else {
      itemInput.readOnly = false;
      itemInput.classList.remove("locked");
      if (/ナイト[XY]?$/.test(itemInput.value)) itemInput.value = "";
    }
  }

  const spState = emptySpread();
  const spInputs = {};
  for (const k of STAT_KEYS) {
    spInputs[k] = el("input", { type: "number", min: "0", max: String(SP_MAX_PER_STAT), value: "0", class: "sp-input",
      oninput: (e) => { spState[k] = clampSP(e.target.value); renderStats(); } });
  }
  const totalBadge = el("span", { class: "total-badge" });
  const statLine = el("div", { class: "fav-statline dim" });

  const moveSels = [0, 1, 2, 3].map(() => el("select", { class: "move-select" }));
  function rebuildMoves() {
    moveSels.forEach((sel) => {
      const cur = sel.value;
      sel.replaceChildren(...moveOptionNodes(selPoke));
      if ([...sel.querySelectorAll("option")].some((o) => o.value === cur)) sel.value = cur;
      else sel.value = "";
    });
  }
  const noteArea = el("textarea", { class: "search fav-note", placeholder: "メモ（型の狙い・対面の注意など）", rows: "2" });

  function renderStats() {
    const nature = getNature(natSel.value);
    const stats = calcAllStats(selPoke.base, spState, nature);
    const total = STAT_KEYS.reduce((s, k) => s + spState[k], 0);
    totalBadge.textContent = `合計SP ${total} / ${SP_TOTAL}`;
    totalBadge.classList.toggle("over", total > SP_TOTAL);
    statLine.textContent = STAT_KEYS.map((k) => `${STAT_LABELS_JP[k]} ${stats[k]}`).join(" / ");
  }

  const saveBtn = el("button", { type: "button", class: "tab-btn primary", onclick: onSave });
  const newBtn = el("button", { type: "button", class: "tab-btn", onclick: () => resetForm() }, "新規（クリア）");
  const formTitle = el("h3", {}, "型を登録");

  function onSave() {
    const rec = {
      id: editing || genId(),
      label: labelInput.value.trim() || selPoke.nameJp,
      pokemon: selPoke.name,
      nature: natSel.value,
      item: itemInput.value.trim(),
      sp: { ...spState },
      moves: moveSels.map((s) => s.value).filter(Boolean),
      note: noteArea.value.trim(),
    };
    upsertFavorite(rec);
    resetForm();
    renderList();
  }
  function resetForm() {
    editing = null;
    formTitle.textContent = "型を登録";
    saveBtn.textContent = "保存する";
    labelInput.value = ""; itemInput.value = ""; noteArea.value = "";
    itemInput.readOnly = false; itemInput.classList.remove("locked");
    natSel.value = "Serious";
    for (const k of STAT_KEYS) { spState[k] = 0; spInputs[k].value = "0"; }
    moveSels.forEach((s) => { s.value = ""; });
    renderStats();
  }
  function loadIntoForm(rec) {
    editing = rec.id;
    formTitle.textContent = "型を編集";
    saveBtn.textContent = "更新する";
    labelInput.value = rec.label || "";
    if (store.pokemonByName.has(rec.pokemon)) { pokeSel.value = rec.pokemon; selPoke = store.pokemonByName.get(rec.pokemon); }
    rebuildMoves();
    natSel.value = rec.nature || "Serious";
    itemInput.value = rec.item || "";
    applyMegaItem();
    for (const k of STAT_KEYS) { spState[k] = rec.sp?.[k] ?? 0; spInputs[k].value = String(spState[k]); }
    moveSels.forEach((s, i) => { s.value = rec.moves?.[i] || ""; });
    noteArea.value = rec.note || "";
    renderStats();
    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const spGrid = el("div", { class: "fav-sp-grid" }, STAT_KEYS.map((k) =>
    el("label", { class: "fav-sp-cell" }, [el("span", {}, STAT_LABELS_JP[k]), spInputs[k]])));
  const moveGrid = el("div", { class: "fav-move-grid" }, moveSels.map((s, i) =>
    el("label", { class: "field" }, [el("span", { class: "dim" }, `わざ${i + 1}`), s])));

  const editor = el("section", { class: "card fav-editor" }, [
    formTitle,
    labeled("型名", labelInput),
    el("div", { class: "fav-row2" }, [labeled("ポケモン", pokeSel), labeled("せいかく", natSel)]),
    labeled("持ち物", itemInput), itemList,
    el("div", { class: "field" }, [el("label", {}, ["能力ポイント(SP)　", totalBadge]), spGrid]),
    statLine,
    el("div", { class: "field" }, [el("label", {}, "わざ（最大4つ）"), moveGrid]),
    labeled("メモ", noteArea),
    el("div", { class: "fav-actions" }, [saveBtn, newBtn]),
  ]);

  const listWrap = el("div", { class: "fav-list" });
  function renderList() {
    const list = loadFavorites().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!list.length) {
      listWrap.replaceChildren(el("p", { class: "hint" }, "保存した型はまだありません。上のフォームから登録してください。"));
      return;
    }
    listWrap.replaceChildren(...list.map((rec) => {
      const poke = store.pokemonByName.get(rec.pokemon);
      const nature = getNature(rec.nature);
      const stats = poke ? calcAllStats(poke.base, rec.sp, nature) : null;
      const statTxt = stats ? STAT_KEYS.map((k) => `${STAT_LABELS_JP[k]}${stats[k]}`).join(" ") : "";
      return el("div", { class: "card fav-card" }, [
        el("div", { class: "fav-card-head" }, [
          el("strong", {}, rec.label),
          el("span", { class: "dim" }, poke ? `　${poke.nameJp}` : ""),
        ]),
        el("div", { class: "fav-card-meta dim" }, [
          `${NATURE_JP[rec.nature] || rec.nature}`,
          rec.item ? ` ・ ${rec.item}` : "",
        ].join("")),
        stats ? el("div", { class: "fav-card-stats" }, statTxt) : null,
        rec.moves?.length ? el("div", { class: "fav-card-moves" }, rec.moves.map((m) =>
          el("span", { class: "move-chip" }, moveJp(m)))) : null,
        rec.note ? el("div", { class: "fav-card-note dim" }, rec.note) : null,
        el("div", { class: "fav-card-actions" }, [
          el("button", { type: "button", class: "mini", onclick: () => nav.open(TAB.DAMAGE, { pokemon: rec.pokemon, sp: rec.sp, nature: rec.nature, item: rec.item, move: rec.moves?.[0] }) }, "ダメ計(攻)で使う"),
          el("button", { type: "button", class: "mini", onclick: () => loadIntoForm(rec) }, "編集"),
          el("button", { type: "button", class: "mini danger", onclick: () => { if (confirm(`「${rec.label}」を削除しますか？`)) renderList(removeFavorite(rec.id)); } }, "削除"),
        ]),
      ]);
    }));
  }

  root.append(
    el("p", { class: "hint" }, "よく使う型（ポケモン＋SP＋性格＋持ち物＋わざ）を保存して、各タブにワンタップ呼び出し。ブラウザ内に保存され、外部に送信されません。"),
    editor,
    el("h3", { class: "fav-list-title" }, "保存した型"),
    listWrap,
  );
  rebuildMoves();
  resetForm();
  renderList();

  // ダメ計の「この攻撃をマイポケモンに登録」から渡された入力で新規登録フォームを下書き
  if (preset?.newFrom) {
    const nf = preset.newFrom;
    if (nf.pokemon && store.pokemonByName.has(nf.pokemon)) {
      pokeSel.value = nf.pokemon; selPoke = store.pokemonByName.get(nf.pokemon);
      applyMegaItem(); rebuildMoves();
    }
    if (nf.item && !itemInput.readOnly) itemInput.value = nf.item;
    if (nf.sp) for (const k of STAT_KEYS) { spState[k] = nf.sp[k] ?? 0; spInputs[k].value = String(spState[k]); }
    if (nf.moves) moveSels.forEach((s, i) => { s.value = nf.moves[i] || ""; });
    labelInput.value = `${selPoke.nameJp}（攻撃）`;
    renderStats();
    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return root;
}

// =================== レイアウト ===================
function regulationBanner() {
  const r = store.regulation;
  const date = (r.generatedAt || "").slice(0, 10);
  return el("div", { class: "reg-banner" }, [
    el("span", { class: "reg-pill" }, `レギュレーション ${r.regulation}（シーズン${r.season}）`),
    el("span", { class: "reg-meta" }, `合法${r.legalPokemonCount}体 ・ データ生成 ${date}`),
  ]);
}

function tabs(defs) {
  const navEl = el("div", { class: "tabs" });
  const panel = el("div", { class: "panel-host" });
  const buttons = [];
  function select(i, preset) {
    buttons.forEach((b, j) => b.classList.toggle("active", i === j));
    panel.replaceChildren(defs[i].render(preset));
    // ページごとに背景モチーフの色味を変える（CSSの body[data-tab="n"] で受ける）
    document.body.setAttribute("data-tab", String(i));
  }
  defs.forEach((d, i) => {
    const b = el("button", { class: "tab-btn", onclick: () => select(i) }, d.label);
    buttons.push(b); navEl.appendChild(b);
  });
  nav.open = select; // お気に入りからの呼び出し用
  select(0);
  return el("div", {}, [navEl, panel]);
}

async function main() {
  const app = document.getElementById("app");
  try {
    await loadData();
  } catch (e) {
    app.replaceChildren(el("div", { class: "error" }, [
      el("p", {}, "データの読み込みに失敗しました。ローカルサーバ経由で開いてください。"),
      el("code", {}, "cd web && python3 -m http.server"),
      el("p", { class: "dim" }, String(e.message || e)),
    ]));
    return;
  }
  app.replaceChildren(
    regulationBanner(),
    tabs([
      { label: "ダメージ計算", render: damageTab },
      { label: "素早さ一覧", render: speedTab },
      { label: "逆算", render: reverseTab },
      { label: "流行り", render: usageTab },
      { label: "マイポケモン", render: favoritesTab },
    ]),
  );
}

document.addEventListener("DOMContentLoaded", main);
