// PROGRIT 第二クール d92(2026-07-24)〜d182(2026-10-22) の確定済み学習記録。
// scripts/build-cycle2-seed.ts が Slack の全履歴（Worker と同じパーサーで解釈）と KV から生成する。
// ※ まだ生成前のプレースホルダー。空の間は KV の値がそのまま使われる（fill-only ロックのみ）。
//
// 各行: [d, s, sp, o, v, li, sc, rp, oe, x?]（単位: 分）
export type SeedRow2 = [number, number, number, number, number, number, number, number, number, Record<string, number>?];
export const PROGRIT_SEED_CYCLE2: SeedRow2[] = [];
