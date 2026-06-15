// data/*.json を読み込み、検索・参照ユーティリティを提供する。
// 既定では「現レギュレーション合法」のみを対象にする（不整合を出さない方針）。

const FILES = ["regulation", "pokemon", "moves", "natures", "typechart", "items", "abilities", "learnsets", "usage"];

export const store = {
  regulation: null,
  pokemon: [],
  legalPokemon: [],
  pokemonByName: new Map(),
  moves: [],
  movesByName: new Map(),
  champMoves: [],      // チャンピオンズに存在する攻撃技
  natures: [],
  typechart: null,
  items: [],
  itemsByName: new Map(),
  legalItems: new Set(),   // 現レギュ合法アイテムの英語名（regulation.rules.legal_items）
  abilities: [],
  learnsets: {},       // { ポケモン名: [覚える技名,...] }
  usage: null,         // { season, single:[{rank,name}], double:[...] }
};

// 使用率順の比較関数（人気順: rank昇順、未取得は末尾、その後 日本語名）。
export function byUsage(a, b) {
  const ra = a.usageRankSingle ?? Infinity;
  const rb = b.usageRankSingle ?? Infinity;
  return ra - rb || a.nameJp.localeCompare(b.nameJp, "ja");
}

export async function loadData(base = "./data") {
  const results = await Promise.all(
    FILES.map((f) => fetch(`${base}/${f}.json`).then((r) => {
      if (!r.ok) throw new Error(`${f}.json の読み込みに失敗 (${r.status})`);
      return r.json();
    }))
  );
  const [regulation, pokemon, moves, natures, typechart, items, abilities, learnsets, usage] = results;

  store.regulation = regulation;
  store.pokemon = pokemon;
  store.legalPokemon = pokemon.filter((p) => p.legal);
  store.pokemonByName = new Map(pokemon.map((p) => [p.name, p]));
  store.moves = moves;
  store.movesByName = new Map(moves.map((m) => [m.name, m]));
  store.champMoves = moves
    .filter((m) => m.inChampions !== false && (m.category === "Physical" || m.category === "Special") && m.power)
    .sort((a, b) => a.name.localeCompare(b.name));
  store.natures = natures;
  store.typechart = typechart;
  store.items = items;
  store.itemsByName = new Map(items.map((it) => [it.name, it]));
  // 合法アイテム集合（未定義の旧データなら空＝フィルタ実質無効でフォールバック）
  store.legalItems = new Set(regulation?.rules?.legal_items || []);
  store.abilities = abilities;
  store.learnsets = learnsets;
  store.usage = usage;
  return store;
}

// ポケモン検索（日本語名・英語名の部分一致）。合法のみ。
export function searchPokemon(query, legalOnly = true) {
  const q = (query || "").trim().toLowerCase();
  const list = legalOnly ? store.legalPokemon : store.pokemon;
  if (!q) return list;
  return list.filter(
    (p) => p.nameJp.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
  );
}

export function getNature(name) {
  return store.natures.find((n) => n.name === name) || null;
}

// learnset 名（メガ等はBaseにフォールバック）を返す内部util。
function learnsetNamesFor(pokemon) {
  let names = store.learnsets[pokemon.name];
  if (!names) {
    const base = store.pokemon.find(
      (p) => p.dexNumber === pokemon.dexNumber && (p.form === "Base" || p.form == null)
    );
    names = base ? store.learnsets[base.name] : null;
  }
  return names;
}

// 指定ポケモンが覚える全わざ（変化技含む・チャンピオンズに存在）。型登録用。
// タイプ順→威力降順で返す。
export function allMovesFor(pokemon) {
  const names = learnsetNamesFor(pokemon);
  if (!names) return store.moves;
  const set = new Set(names);
  const moves = store.moves.filter((m) => set.has(m.name) && m.inChampions !== false);
  moves.sort((a, b) => (a.type || "").localeCompare(b.type || "") || (b.power || 0) - (a.power || 0));
  return moves;
}

// 指定ポケモンが覚える攻撃技（チャンピオンズの物理/特殊・威力あり）を返す。
// 並びは暫定で威力降順（※使用率データ導入後は使用率順に差し替え予定）。
// メガ等で learnset 名が無い場合は同一図鑑番号の Base 個体にフォールバック。
export function attackingMovesFor(pokemon) {
  let names = store.learnsets[pokemon.name];
  if (!names) {
    const base = store.pokemon.find(
      (p) => p.dexNumber === pokemon.dexNumber && (p.form === "Base" || p.form == null)
    );
    names = base ? store.learnsets[base.name] : null;
  }
  if (!names) return store.champMoves; // 最終フォールバック（全技）
  const set = new Set(names);
  const moves = store.champMoves.filter((m) => set.has(m.name));
  moves.sort((a, b) => (b.power || 0) - (a.power || 0) || a.name.localeCompare(b.name));
  return moves;
}
