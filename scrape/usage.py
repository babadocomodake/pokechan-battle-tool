"""使用率（メタ）データの取得。役割分離: これは「人気・流行り」の参考であり、
合法判定(Serebii)とは別。出典: バトルデータベース チャンピオンズ (champs.pokedb.tokyo)。

提供されるのは順位付きの使用率ランキング（ページに%は無く順位のみ）。
個別ページ(/pokemon/show/<id>)には技/持ち物の採用率があり、将来の「型予想」で利用予定。
"""

from __future__ import annotations

import html as html_lib
import json
import re
import unicodedata
import urllib.request
from pathlib import Path

USAGE_LIST_URL = "https://champs.pokedb.tokyo/pokemon/list"
USAGE_SHOW_URL = "https://champs.pokedb.tokyo/pokemon/show"  # 個別ページ（採用率の一次源）
# season=3 が シーズンM-3(M-B)。rule=0 シングル / rule=1 ダブル。切替時に更新。
CURRENT_SEASON_PARAM = 3
USER_AGENT = "Mozilla/5.0 (compatible; pokechamp-helper/0.1; usage sync)"
MIN_EXPECTED_ROWS = 100

# <div class="pokemon-rank ...> N </div> ... <div class="pokemon-name">NAME</div>
_ROW_RE = re.compile(r'pokemon-rank[^>]*>\s*(\d+)\s*<.*?pokemon-name">([^<]+)<', re.S)


def normalize(name: str) -> str:
    """全角()→半角・空白除去で表記ゆれを吸収。"""
    return unicodedata.normalize("NFKC", name).replace(" ", "").strip()


def _fetch(rule: int, cache_dir: Path | None, force: bool) -> str:
    cache = (cache_dir / f"pokedb_usage_rule{rule}.html") if cache_dir else None
    if cache and cache.exists() and not force:
        return cache.read_text(encoding="utf-8", errors="replace")
    url = f"{USAGE_LIST_URL}?season={CURRENT_SEASON_PARAM}&rule={rule}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(raw, encoding="utf-8")
    return raw


def fetch_usage(rule: int, cache_dir: Path | None = None, force: bool = False) -> list[tuple[int, str]]:
    """(順位, 日本語名) のリストを順位順で返す。rule: 0=シングル, 1=ダブル。"""
    html = _fetch(rule, cache_dir, force)
    pairs = [(int(r), html_lib.unescape(n)) for r, n in _ROW_RE.findall(html)]
    if len(pairs) < MIN_EXPECTED_ROWS:
        raise RuntimeError(
            f"pokedb 使用率の行数が想定より少ない ({len(pairs)} < {MIN_EXPECTED_ROWS})。"
            "ページ構造が変わった可能性があります。"
        )
    return pairs


def make_rank_lookup(pairs: list[tuple[int, str]]):
    """正規化名 → 最小順位 の辞書と、前方一致フォールバック付きの引き関数を返す。

    例: 我々の「ニャオニクス」を pokedb の「ニャオニクス (オス)」へ前方一致でマッチ。
    """
    exact: dict[str, int] = {}
    for rank, name in pairs:
        k = normalize(name)
        if k not in exact or rank < exact[k]:
            exact[k] = rank

    def lookup(name_jp: str):
        key = normalize(name_jp)
        if key in exact:
            return exact[key]
        # 前方一致（フォーム分割されている種）。最小順位を採用。
        best = None
        for k, r in exact.items():
            if k.startswith(key) and (best is None or r < best):
                best = r
        return best

    return lookup


# ── 個別ページの採用率（#5 とくせい自動 / わざ並び順 用）─────────────────────
# 採用率は静的HTML内に HTMLエスケープJSONで埋め込まれている:
#   とくせい: x-data="window.usagePieChart([{...,"name":"さめはだ","rate":99.2},...])"
#   わざ    : move-detail="{...,"name":"じしん","rate":99.6,...}"
# 内側の引用符は &quot; なので、属性値は [^"]* で安全に取り出せる。
_ABIL_RE = re.compile(r'usagePieChart\((\[[^"]*?\])\)', re.S)
_MOVE_RE = re.compile(r'move-detail="([^"]*)"')


def _fetch_show(dex: int, form: int, rule: int, cache_dir: Path | None, force: bool) -> str:
    cache = (cache_dir / f"pokedb_show_{dex:04d}-{form:02d}_r{rule}.html") if cache_dir else None
    if cache and cache.exists() and not force:
        return cache.read_text(encoding="utf-8", errors="replace")
    url = f"{USAGE_SHOW_URL}/{dex:04d}-{form:02d}?season={CURRENT_SEASON_PARAM}&rule={rule}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(raw, encoding="utf-8")
    return raw


def fetch_adoption(dex: int, form: int = 0, rule: int = 0,
                   cache_dir: Path | None = None, force: bool = False) -> dict:
    """種(図鑑番号+形態)の採用率を返す。
    戻り値: {"abilities": [(日本語名, rate), ...], "moves": [(日本語名, rate), ...]}（rate降順）。
    取得失敗・データ無しは空リスト（呼び出し側で非致命に扱う）。
    """
    try:
        html_text = _fetch_show(dex, form, rule, cache_dir, force)
    except Exception:
        return {"abilities": [], "moves": []}

    abilities: list[tuple[str, float]] = []
    m = _ABIL_RE.search(html_text)
    if m:
        try:
            for e in json.loads(html_lib.unescape(m.group(1))):
                if e.get("name") and e.get("rate") is not None:
                    abilities.append((html_lib.unescape(str(e["name"])).strip(), float(e["rate"])))
        except Exception:
            pass

    moves: list[tuple[str, float]] = []
    seen: set[str] = set()
    for raw in _MOVE_RE.findall(html_text):
        try:
            e = json.loads(html_lib.unescape(raw))
        except Exception:
            continue
        name = html_lib.unescape(str(e.get("name", ""))).strip()
        if not name or name in seen or e.get("rate") is None:
            continue
        seen.add(name)
        moves.append((name, float(e["rate"])))

    abilities.sort(key=lambda x: -x[1])
    moves.sort(key=lambda x: -x[1])
    return {"abilities": abilities, "moves": moves}


if __name__ == "__main__":
    for rule, label in [(0, "single"), (1, "double")]:
        pairs = fetch_usage(rule, cache_dir=Path("data/raw"))
        print(f"{label}: {len(pairs)} rows. top5:", pairs[:5])
    ad = fetch_adoption(445, 0, 0, cache_dir=Path("data/raw"))
    print("Garchomp abilities:", ad["abilities"])
    print("Garchomp top moves:", ad["moves"][:5])
