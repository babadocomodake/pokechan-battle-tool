"""使用率（メタ）データの取得。役割分離: これは「人気・流行り」の参考であり、
合法判定(Serebii)とは別。出典: バトルデータベース チャンピオンズ (champs.pokedb.tokyo)。

提供されるのは順位付きの使用率ランキング（ページに%は無く順位のみ）。
個別ページ(/pokemon/show/<id>)には技/持ち物の採用率があり、将来の「型予想」で利用予定。
"""

from __future__ import annotations

import html as html_lib
import re
import unicodedata
import urllib.request
from pathlib import Path

USAGE_LIST_URL = "https://champs.pokedb.tokyo/pokemon/list"
# season=2 が シーズンM-2。rule=0 シングル / rule=1 ダブル。切替時に更新。
CURRENT_SEASON_PARAM = 2
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


if __name__ == "__main__":
    for rule, label in [(0, "single"), (1, "double")]:
        pairs = fetch_usage(rule, cache_dir=Path("data/raw"))
        print(f"{label}: {len(pairs)} rows. top5:", pairs[:5])
