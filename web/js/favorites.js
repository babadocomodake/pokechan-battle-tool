// お気に入り（マイポケモン＝保存した型）の永続化。ブラウザの localStorage に保存。
// 1レコード = 1つの型: { id, label, pokemon, nature, item, sp{}, moves[], note, updatedAt }

const KEY = "pokechamp.favorites.v1";

export function loadFavorites() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function genId() {
  return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 追加または更新（id一致で置換）。戻り値は更新後リスト。
export function upsertFavorite(rec) {
  const list = loadFavorites();
  rec.updatedAt = Date.now();
  const i = list.findIndex((x) => x.id === rec.id);
  if (i >= 0) list[i] = rec;
  else list.push(rec);
  saveAll(list);
  return list;
}

export function removeFavorite(id) {
  const list = loadFavorites().filter((x) => x.id !== id);
  saveAll(list);
  return list;
}

export function emptySpread() {
  return { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
}

// 汎用の「最近使った」履歴（文字列の配列）。
export function loadRecent(key) {
  try {
    const a = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
export function pushRecent(key, value, cap = 8) {
  const a = loadRecent(key).filter((x) => x !== value);
  a.unshift(value);
  const trimmed = a.slice(0, cap);
  localStorage.setItem(key, JSON.stringify(trimmed));
  return trimmed;
}
// 履歴の各要素は「文字列(旧:名前のみ)」または「{pokemon, ...}スナップショット」。
const recentName = (x) => (typeof x === "string" ? x : x && x.pokemon);
// スナップショットをポケモン名で重複排除して先頭に積む（防御履歴用）。
export function upsertRecentSnap(key, snap, cap = 50) {
  const a = loadRecent(key).filter((x) => recentName(x) !== snap.pokemon);
  a.unshift(snap);
  const trimmed = a.slice(0, cap);
  localStorage.setItem(key, JSON.stringify(trimmed));
  return trimmed;
}
// 先頭が同じポケモンの時だけスナップショットを上書き（並びは変えない）。
// 入力を編集するたびに「実際に使った状態」を先頭履歴へ反映するのに使う。
// 実際に内容が変わった時だけ true を返す（呼び出し側はその時だけ再描画すればよい）。
export function syncRecentSnapFront(key, snap) {
  const a = loadRecent(key);
  if (a.length && recentName(a[0]) === snap.pokemon && JSON.stringify(a[0]) !== JSON.stringify(snap)) {
    a[0] = snap;
    localStorage.setItem(key, JSON.stringify(a));
    return true;
  }
  return false;
}
