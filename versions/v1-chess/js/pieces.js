// =====================================================================
//  駒の定義ファイル  ― 改造するときはまずここを触る
// =====================================================================
//
//  dirs は「白から見た向き」で書く。[dx, dy] の dy がマイナス = 前進方向。
//  黒の駒は自動で上下反転されるので、前にしか進めない駒なども作れる。
//
//  moves の type:
//    'slide' … 止められるまで何マスでも進む（ルーク・ビショップのような動き）
//    'leap'  … 1回だけ跳ぶ。間の駒は飛び越える（ナイト・キングのような動き）
//    'pawn'  … ポーンの特殊な動き（前進・斜め取り・2マス進み・アンパッサン・昇格）
//
//  その他のフラグ:
//    royal     … 取られたら負けの駒（チェック判定の対象）
//    canCastle … キャスリングできる王
//    castleRook… キャスリングの相方になれる駒
//    value     … CPU が使う駒の価値

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL8 = ORTHO.concat(DIAG);
const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];

const PIECES = {
  K: { name: 'キング', symbol: '♚', value: 0, royal: true, canCastle: true, moves: [{ type: 'leap', dirs: ALL8 }] },
  Q: { name: 'クイーン', symbol: '♛', value: 9, moves: [{ type: 'slide', dirs: ALL8 }] },
  R: { name: 'ルーク', symbol: '♜', value: 5, castleRook: true, moves: [{ type: 'slide', dirs: ORTHO }] },
  B: { name: 'ビショップ', symbol: '♝', value: 3, moves: [{ type: 'slide', dirs: DIAG }] },
  N: { name: 'ナイト', symbol: '♞', value: 3, moves: [{ type: 'leap', dirs: KNIGHT }] },
  P: { name: 'ポーン', symbol: '♟︎', value: 1, moves: [{ type: 'pawn' }] },
};

// 初期配置。大文字 = 白、小文字 = 黒、'.' = 空きマス。上が黒側。
// 行数・列数を変えれば盤のサイズも変えられる。
const INITIAL_LAYOUT = [
  'rnbqkbnr',
  'pppppppp',
  '........',
  '........',
  '........',
  '........',
  'PPPPPPPP',
  'RNBQKBNR',
];

// ポーンが最奥に着いたときに選べる駒
const PROMOTION_CHOICES = ['Q', 'R', 'B', 'N'];
