// 能力ランク補正（段階）の倍率。攻撃・防御・素早さ等で共通利用。
// +n 段階 → (2+n)/2、-n 段階 → 2/(2+|n|)。範囲は -6〜+6。
export function statStageMultiplier(stage) {
  const n = Math.max(-6, Math.min(6, stage | 0));
  return n >= 0 ? (2 + n) / 2 : 2 / (2 - n);
}

// すばやさ等で上昇のみ（0〜+6）を扱う既存用途の薄いラッパ。
export function stageMultiplier(stage) {
  return statStageMultiplier(Math.max(0, stage | 0));
}
