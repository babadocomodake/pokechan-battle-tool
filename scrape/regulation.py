"""現レギュレーションの「合法判定」を取得するモジュール。

役割分離（計画より）:
  - 合法か否かの真実の源は Serebii（このファイル）。使用率や構築記事とは混同しない。
  - シーズン名/期間/ルールは公式(pokemonchampions.jp)と突合して食い違いを警告する。

Serebii のレギュレーションページは、使用可能な「フォーム単位」の行を表で列挙する。
各行から (図鑑番号, 英語名, 日本語名) を取り出す。英語名はデータセットの命名と一致する
（例: "Mega Charizard X"）ので、これで合法判定と日本語名付与を同時に行える。
"""

from __future__ import annotations

import html as html_lib
import re
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

SEREBII_REGULATION_URL = "https://www.serebii.net/pokemonchampions/rankedbattle/regulationm-a.shtml"
OFFICIAL_BATTLE_URL = "https://www.pokemonchampions.jp/ja/battle/"

# 現レギュレーション識別子（切替時はここと URL を更新する）
CURRENT_REGULATION = "M-A"
CURRENT_SEASON = "M-2"

USER_AGENT = "Mozilla/5.0 (compatible; pokechamp-helper/0.1; data sync)"

# Serebii のページ構造変化を検知するための健全性しきい値
MIN_EXPECTED_FORMS = 150


@dataclass
class LegalForm:
    dex_number: int
    name_en: str
    name_jp: str
    slug: str


@dataclass
class Regulation:
    regulation: str
    season: str
    legal_forms: list[LegalForm] = field(default_factory=list)
    # ルール（Serebii / 公式で確認した固定値。切替時に見直す）
    rules: dict = field(default_factory=dict)
    source_url: str = SEREBII_REGULATION_URL


def _fetch(url: str, cache_path: Path | None = None, force: bool = False) -> str:
    """URL を取得。cache_path があればキャッシュを使う（再取得は force=True）。"""
    if cache_path and cache_path.exists() and not force:
        return cache_path.read_text(encoding="utf-8", errors="replace")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(raw, encoding="utf-8")
    return raw


# 1行ぶんから (dex, slug, 英語名, 日本語名) を取り出す。
# 図鑑セル(#dddd) → アイコンセル → 名前セル(<a ...>EN<br/>JP</a>) の順に並ぶ。
# アイコンリンクは直後が <img なので ([^<]+) が一致せず、名前リンクだけが拾われる。
_ROW_RE = re.compile(
    r"#(\d{3,4})"  # 図鑑番号
    r".*?"
    r'<a href="/pokedex-champions/([a-z0-9\-]+)/">'  # 名前リンク（slug）
    r"([^<]+)<br\s*/?>([^<]+)</a>",  # EN <br> JP
    re.S,
)


def parse_regulation(html: str) -> list[LegalForm]:
    forms: list[LegalForm] = []
    seen: set[str] = set()
    for dex, slug, en, jp in _ROW_RE.findall(html):
        name_en = html_lib.unescape(en).strip()
        name_jp = html_lib.unescape(jp).strip()
        if not name_en or name_en in seen:
            continue
        seen.add(name_en)
        forms.append(
            LegalForm(
                dex_number=int(dex),
                name_en=name_en,
                name_jp=name_jp,
                slug=slug,
            )
        )
    return forms


def fetch_regulation(cache_dir: Path | None = None, force: bool = False) -> Regulation:
    """Serebii から現レギュレーションの合法フォーム一覧を取得して返す。"""
    cache_path = (cache_dir / "serebii_reg.html") if cache_dir else None
    html = _fetch(SEREBII_REGULATION_URL, cache_path, force)
    legal_forms = parse_regulation(html)
    if len(legal_forms) < MIN_EXPECTED_FORMS:
        raise RuntimeError(
            f"Serebii の合法フォーム数が想定より少ない ({len(legal_forms)} < {MIN_EXPECTED_FORMS})。"
            "ページ構造が変わった可能性があります。解析処理を見直してください。"
        )
    return Regulation(
        regulation=CURRENT_REGULATION,
        season=CURRENT_SEASON,
        legal_forms=legal_forms,
        rules={
            "level": 50,
            "ivs_fixed": 31,
            "single_team_size": [3, 6],
            "single_bring": 3,
            "double_team_size": [4, 6],
            "double_bring": 4,
            "no_duplicate_species": True,
            "no_duplicate_items": True,
            "gimmick": "Mega Evolution",
            "banned": ["Mega Lucario Z", "Mega Garchomp Z"],
            "note": "Lv50統一・個体値31固定・同種/同道具禁止。ダイマ/テラスは不可。",
        },
    )


def cross_check_official(regulation: Regulation, cache_dir: Path | None = None,
                         force: bool = False) -> list[str]:
    """公式ページの到達性とレギュレーション概念の存在を確認し、警告を返す。

    公式「バトルについて」ページは概念説明であり、現行シーズン番号(例: M-2)は
    掲載されない。よってシーズン番号の自動突合はできない。ここでは
      - 公式ページが取得でき、'レギュレーション' の語が存在する（URL/構成の健全性）
    を確認し、現行シーズンの最終確認は運用者の手動チェックに委ねる（下記の note）。
    取得失敗・不一致は警告に留め、致命扱いにはしない（Serebiiが一次解析源）。
    """
    warnings: list[str] = []
    cache_path = (cache_dir / "official_battle.html") if cache_dir else None
    try:
        html = _fetch(OFFICIAL_BATTLE_URL, cache_path, force)
    except Exception as exc:  # noqa: BLE001 - 公式取得失敗は警告に留める
        warnings.append(f"公式ページ取得に失敗（突合スキップ）: {exc}")
        return warnings
    text = html_lib.unescape(html)
    if "レギュレーション" not in text:
        warnings.append(
            "公式バトルページに『レギュレーション』表記が見つかりません。"
            "URL/構成が変わった可能性があり要確認。"
        )
    # 現行シーズンは公式概要ページに出ないため、運用者向けの確認喚起を常に1件出す。
    warnings.append(
        f"【運用確認】現行を Serebii の {regulation.regulation}（{regulation.season}）として処理。"
        "レギュレーション切替時は公式最新情報/ゲーム内で番号・期間を確認し、"
        "scrape/regulation.py の CURRENT_* と URL を更新すること。"
    )
    return warnings


if __name__ == "__main__":
    reg = fetch_regulation(cache_dir=Path("data/raw"))
    print(f"Regulation {reg.regulation} / Season {reg.season}: {len(reg.legal_forms)} legal forms")
    for f in reg.legal_forms[:5]:
        print(f"  #{f.dex_number:04d} {f.name_en} / {f.name_jp}")
    for w in cross_check_official(reg, cache_dir=Path("data/raw")):
        print("WARN:", w)
