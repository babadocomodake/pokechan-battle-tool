#!/usr/bin/env python3
"""データ整形パイプライン。

A系統（ゲーム基礎データ: GitHub公開データセット, CC BY 4.0）と
B系統（合法判定: Serebii + 公式突合）を取得・結合し、整合チェックを通してから
web/ が読む data/*.json を生成する。

設計の要点:
  - 「合法か否か」の根拠は Serebii のみ（scrape/regulation.py）。
  - A↔B で食い違い（Serebiiの合法名がデータセットに無い等）を検出したら
    data/ を書き出さず中断する（不整合のまま公開しない）。
  - ポケモンチャンピオンズは Lv50固定・個体値31固定・SP(能力ポイント)制。

使い方:
  python build_data.py            # キャッシュがあれば使う
  python build_data.py --force    # 全ソースを再取得
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from scrape.regulation import fetch_regulation, cross_check_official
from scrape.usage import fetch_usage, make_rank_lookup

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data"
WEB_DATA = ROOT / "web" / "data"

DATASET_BASE = "https://raw.githubusercontent.com/otterlyclueless/pokemon-champions-data/main"
DATASET_FILES = {
    "roster": "pokemon/roster.json",
    "base_stats": "pokemon/base-stats.json",
    "moves": "moves/moves.json",
    "abilities": "abilities/abilities.json",
    "items": "items/items.json",
    "natures": "natures/natures.json",
    "type_chart": "type-chart/effectiveness.json",
    "learnsets": "learnsets/learnsets.json",
    "meta": "meta/version.json",
}
# 日本語名ソース: PokeAPI のCSV（GitHub）。言語ID 1 = ja-hrkt（公式の日本語名）。
POKEAPI_CSV_BASE = "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv"
POKEAPI_CSV_FILES = [
    "moves.csv", "move_names.csv", "items.csv", "item_names.csv",
    "abilities.csv", "ability_names.csv", "item_categories.csv",
]
JA_LANG_ID = "1"

# 「持てる対戦アイテム」とみなす PokeAPI のカテゴリ。ベリーは別途 nameJp末尾「のみ」で判定。
HELD_ITEM_CATEGORIES = {
    "held-items", "choice", "bad-held-items", "type-enhancement", "type-protection",
    "plates", "species-specific", "jewels", "memories", "effort-training", "mega-stones",
}
# メガストーンの説明文から対象種を取り出す（チャンピオンズ新規メガもこれで検出）。
MEGA_STONE_RE = re.compile(r"held by an?\s+(.+?),\s+this item allows it to Mega Evolve", re.I)

ATTRIBUTION = (
    "Pokemon Champions Data — github.com/otterlyclueless/pokemon-champions-data (CC BY 4.0). "
    "Regulation/legality: Serebii.net + Pokémon Champions 公式."
)
USER_AGENT = "Mozilla/5.0 (compatible; pokechamp-helper/0.1; data sync)"


def fetch_dataset(force: bool = False) -> dict:
    """A系統を取得（キャッシュ利用）。各JSONを辞書で返す。"""
    RAW.mkdir(parents=True, exist_ok=True)
    out: dict = {}
    for key, path in DATASET_FILES.items():
        cache = RAW / path.replace("/", "_")
        if cache.exists() and not force:
            raw = cache.read_text(encoding="utf-8")
        else:
            req = urllib.request.Request(f"{DATASET_BASE}/{path}", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
            cache.write_text(raw, encoding="utf-8")
        out[key] = json.loads(raw)
    return out


def _read_csv(path: Path) -> list[dict]:
    return list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8"))))


def fetch_ja_maps(force: bool = False) -> dict:
    """PokeAPI CSV から slug→日本語名 のマップを技/道具/特性ごとに作る。"""
    csv_dir = RAW / "poke_csv"
    csv_dir.mkdir(parents=True, exist_ok=True)
    for f in POKEAPI_CSV_FILES:
        cache = csv_dir / f
        if cache.exists() and not force:
            continue
        req = urllib.request.Request(f"{POKEAPI_CSV_BASE}/{f}", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            cache.write_bytes(resp.read())

    def build(ids_csv: str, names_csv: str, id_col: str) -> dict:
        ident_to_id = {r["identifier"]: r["id"] for r in _read_csv(csv_dir / ids_csv)}
        id_to_ja = {}
        for r in _read_csv(csv_dir / names_csv):
            if r["local_language_id"] == JA_LANG_ID:
                id_to_ja[r[id_col]] = r["name"]
        return {ident: id_to_ja[i] for ident, i in ident_to_id.items() if i in id_to_ja}

    return {
        "moves": build("moves.csv", "move_names.csv", "move_id"),
        "items": build("items.csv", "item_names.csv", "item_id"),
        "abilities": build("abilities.csv", "ability_names.csv", "ability_id"),
    }


def item_category_map() -> dict:
    """slug → カテゴリ識別子（items.csv × item_categories.csv）。"""
    csv_dir = RAW / "poke_csv"
    cats = {r["id"]: r["identifier"] for r in _read_csv(csv_dir / "item_categories.csv")}
    return {r["identifier"]: cats.get(r["category_id"]) for r in _read_csv(csv_dir / "items.csv")}


def slugify(name: str) -> str:
    """データセットの英語表示名を PokeAPI の identifier 形式へ。"""
    s = name.lower().replace("é", "e").replace("’", "").replace("'", "")
    s = s.replace(".", "").replace(":", "")
    s = re.sub(r"[\s_]+", "-", s.strip())
    s = re.sub(r"-+", "-", s)
    return s


def localize(name: str, ja_map: dict) -> str:
    return ja_map.get(slugify(name), name)


def _display_jp(name_en: str, species_jp: str) -> str:
    """フォームを踏まえた日本語表示名。メガは「メガ＋種名(＋X/Y)」にする。"""
    if name_en.startswith("Mega "):
        suffix = ""
        if name_en.endswith(" X"):
            suffix = "X"
        elif name_en.endswith(" Y"):
            suffix = "Y"
        return f"メガ{species_jp}{suffix}"
    return species_jp


def build_pokemon(dataset: dict, legal_forms) -> tuple[list[dict], list[str]]:
    """roster + base-stats を結合し、合法フラグと日本語名を付与。

    戻り値: (pokemonリスト, エラーメッセージリスト)
    エラーが空でなければ不整合 → 呼び出し側で書き出しを中断する。
    """
    errors: list[str] = []

    stats_by_name = {e["name"]: e for e in dataset["base_stats"]}
    legal_by_name = {f.name_en: f for f in legal_forms}
    dataset_names = {e["name"] for e in dataset["roster"]}

    # 整合チェック(1): Serebiiの合法名がデータセットに存在するか
    missing = [f.name_en for f in legal_forms if f.name_en not in dataset_names]
    if missing:
        errors.append(
            f"Serebii合法 {len(missing)}件がデータセットに存在しません（名称ゆれ/未収録）: "
            + ", ".join(missing[:10]) + (" ..." if len(missing) > 10 else "")
        )

    pokemon: list[dict] = []
    for entry in dataset["roster"]:
        name = entry["name"]
        stats = stats_by_name.get(name)
        if stats is None:
            errors.append(f"base-stats に '{name}' がありません（roster と不整合）")
            continue
        legal = legal_by_name.get(name)
        if legal is not None:
            jp = _display_jp(name, legal.name_jp)
        else:
            # 非合法フォーム: 同一図鑑番号の合法種から種名を借りる
            same_dex = next((f for f in legal_forms if f.dex_number == entry["dexNumber"]), None)
            jp = _display_jp(name, same_dex.name_jp) if same_dex else name
        pokemon.append({
            "name": name,
            "nameJp": jp,
            "dexNumber": entry["dexNumber"],
            "form": entry.get("form", "Base"),
            "types": entry["types"],
            "abilities": list(entry.get("abilities", {}).values()),
            "base": {k: stats[k] for k in ("hp", "atk", "def", "spa", "spd", "spe")},
            "bst": stats.get("total"),
            "legal": legal is not None,
        })

    return pokemon, errors


def build_moves(dataset: dict, ja_map: dict) -> tuple[list[dict], int]:
    keep = ("name", "type", "category", "power", "accuracy", "pp", "priority", "target",
            "inChampions", "description")
    out, miss = [], 0
    for m in dataset["moves"]:
        d = {k: m.get(k) for k in keep}
        d["nameJp"] = localize(m["name"], ja_map)
        if d["nameJp"] == m["name"]:
            miss += 1
        out.append(d)
    return out, miss


def localize_list(items: list[dict], ja_map: dict) -> tuple[list[dict], int]:
    """{name, ...} のリストに nameJp を付与。戻り値は (リスト, 未一致数)。"""
    out, miss = [], 0
    for it in items:
        jp = localize(it["name"], ja_map)
        if jp == it["name"]:
            miss += 1
        out.append({**it, "nameJp": jp})
    return out, miss


def build_items(items: list[dict], ja_map: dict, cat_map: dict) -> tuple[list[dict], int]:
    """道具に nameJp / category / holdable（持てる対戦アイテムか）を付与。"""
    out, miss = [], 0
    for it in items:
        jp = localize(it["name"], ja_map)
        if jp == it["name"]:
            miss += 1
        cat = cat_map.get(slugify(it["name"]))
        holdable = (cat in HELD_ITEM_CATEGORIES) or jp.endswith("のみ")  # ベリー
        out.append({**it, "nameJp": jp, "category": cat, "holdable": holdable})
    return out, miss


def parse_mega_stones(items_localized: list[dict]) -> dict:
    """説明文から「Mega <種> (X/Y)」→ 道具(nameJp付き) の対応を作る。"""
    stones = {}
    for it in items_localized:
        m = MEGA_STONE_RE.search(it.get("description", "") or "")
        if not m:
            continue
        species = m.group(1).strip()
        suffix = " X" if it["name"].endswith(" X") else (" Y" if it["name"].endswith(" Y") else "")
        stones[f"Mega {species}{suffix}"] = it
    return stones


def attach_mega_stones(pokemon: list[dict], items_localized: list[dict]) -> int:
    """メガ個体に megaStone={name,nameJp} を付与。公式日本語名が無い新規メガは
    「<種の日本語名>ナイト(+X/Y)」で合成する。戻り値は付与した数。"""
    stones = parse_mega_stones(items_localized)
    species_jp = {p["dexNumber"]: p["nameJp"] for p in pokemon if p["form"] == "Base"}
    count = 0
    for p in pokemon:
        if p["form"] != "Mega":
            continue
        sjp = species_jp.get(p["dexNumber"], p["nameJp"])
        suf = "X" if p["name"].endswith(" X") else ("Y" if p["name"].endswith(" Y") else "")
        st = stones.get(p["name"])
        if st and st["nameJp"] != st["name"]:
            jp, en = st["nameJp"], st["name"]
        elif st:
            jp, en = f"{sjp}ナイト{suf}", st["name"]  # 英語名のみ → 日本語は合成
        else:
            jp, en = f"{sjp}ナイト{suf}", None         # 石未検出 → 合成
        p["megaStone"] = {"name": en, "nameJp": jp}
        count += 1
    return count


def build_natures(dataset: dict) -> list[dict]:
    return dataset["natures"]


def build_learnsets(dataset: dict) -> dict:
    """{ポケモン名: [覚える技名,...]} に圧縮。"""
    out = {}
    for name, entry in dataset["learnsets"].items():
        out[name] = [m["name"] for m in entry.get("moves", [])]
    return out


def build_typechart(dataset: dict) -> dict:
    tc = dataset["type_chart"]
    return {"types": tc["types"], "chart": tc["chart"], "legend": tc.get("legend")}


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="ポケモンチャンピオンズ補助アプリ データ整形")
    ap.add_argument("--force", action="store_true", help="全ソースを再取得")
    args = ap.parse_args()

    print("A系統（ゲーム基礎データ）を取得中 ...")
    dataset = fetch_dataset(force=args.force)
    print("B系統（Serebii 合法判定）を取得中 ...")
    regulation = fetch_regulation(cache_dir=RAW, force=args.force)
    print(f"  Regulation {regulation.regulation} / Season {regulation.season}: "
          f"{len(regulation.legal_forms)} legal forms")

    # 整合チェック(2): 公式突合（警告のみ・非致命）
    warnings = cross_check_official(regulation, cache_dir=RAW, force=args.force)
    for w in warnings:
        print("WARN:", w)

    print("日本語名（技/道具/特性）を取得中 ...")
    ja = fetch_ja_maps(force=args.force)

    # C系統: 使用率（メタ・流行り。合法判定とは別。取得失敗は非致命）
    print("使用率（pokedb・参考）を取得中 ...")
    usage_single = usage_double = []
    try:
        usage_single = fetch_usage(0, cache_dir=RAW, force=args.force)
        usage_double = fetch_usage(1, cache_dir=RAW, force=args.force)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"使用率(pokedb)取得に失敗（人気順は無効）: {exc}")
        print("WARN:", warnings[-1])

    pokemon, errors = build_pokemon(dataset, regulation.legal_forms)
    legal_count = sum(1 for p in pokemon if p["legal"])
    # ポケモンの特性も日本語名を併記（UI表示用）
    for p in pokemon:
        p["abilitiesJp"] = [localize(a, ja["abilities"]) for a in p["abilities"]]

    # 使用率順位を付与（nameJp で照合、フォーム分割は前方一致）
    look_s = make_rank_lookup(usage_single) if usage_single else (lambda _n: None)
    look_d = make_rank_lookup(usage_double) if usage_double else (lambda _n: None)
    for p in pokemon:
        p["usageRankSingle"] = look_s(p["nameJp"])
        p["usageRankDouble"] = look_d(p["nameJp"])
    # メガ等フォームは同一図鑑番号の Base 順位を継承（自前の順位が無い場合）
    base_rank = {}
    for p in pokemon:
        if p["form"] == "Base":
            base_rank[p["dexNumber"]] = (p["usageRankSingle"], p["usageRankDouble"])
    for p in pokemon:
        bs, bd = base_rank.get(p["dexNumber"], (None, None))
        if p["usageRankSingle"] is None:
            p["usageRankSingle"] = bs
        if p["usageRankDouble"] is None:
            p["usageRankDouble"] = bd
    matched_usage = sum(1 for p in pokemon if p["legal"] and p["usageRankSingle"] is not None)

    if errors:
        print("\n*** 整合エラー: 不整合のため data/ を書き出しません ***", file=sys.stderr)
        for e in errors:
            print("  -", e, file=sys.stderr)
        return 1

    # 出力
    generated_at = datetime.now(timezone.utc).isoformat()
    regulation_json = {
        "regulation": regulation.regulation,
        "season": regulation.season,
        "rules": regulation.rules,
        "legalPokemonCount": legal_count,
        "generatedAt": generated_at,
        "sources": {
            "gameData": "github.com/otterlyclueless/pokemon-champions-data (CC BY 4.0)",
            "regulation": regulation.source_url,
            "official": "https://www.pokemonchampions.jp/ja/battle/",
        },
        "attribution": ATTRIBUTION,
        "warnings": warnings,
    }

    moves, moves_miss = build_moves(dataset, ja["moves"])
    items, items_miss = build_items(dataset["items"], ja["items"], item_category_map())
    abilities, ab_miss = localize_list(dataset["abilities"], ja["abilities"])
    mega_count = attach_mega_stones(pokemon, items)
    holdable_count = sum(1 for it in items if it["holdable"])

    usage_json = {
        "season": regulation.season,
        "source": "champs.pokedb.tokyo",
        "single": [{"rank": r, "name": n} for r, n in usage_single],
        "double": [{"rank": r, "name": n} for r, n in usage_double],
    }

    outputs = {
        "regulation.json": regulation_json,
        "pokemon.json": pokemon,
        "moves.json": moves,
        "natures.json": build_natures(dataset),
        "typechart.json": build_typechart(dataset),
        "learnsets.json": build_learnsets(dataset),
        "items.json": items,
        "abilities.json": abilities,
        "usage.json": usage_json,
    }
    for name, data in outputs.items():
        write_json(OUT / name, data)
        write_json(WEB_DATA / name, data)  # web/ からも読めるようコピー

    print(f"\n生成完了: {OUT} と {WEB_DATA}")
    print(f"  ポケモン {len(pokemon)}件（うち合法 {legal_count}件）/ 技 {len(moves)}件")
    print(f"  日本語名 未一致: 技{moves_miss} / 道具{items_miss} / 特性{ab_miss}（未一致は英語名のまま）")
    print(f"  持てる道具: {holdable_count}件 / メガストーン付与: {mega_count}件")
    if usage_single:
        print(f"  使用率: シングル{len(usage_single)}件/ダブル{len(usage_double)}件 取得、合法に付与{matched_usage}件")
    print("  整合チェック: OK（不整合なし）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
