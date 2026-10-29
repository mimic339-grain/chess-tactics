// ルールエンジンの正しさチェック（node test/perft.js で実行）
// 既知の局面で「n手先までの局面数」を数え、正解と比べる。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ctx = {};
vm.createContext(ctx);
for (const f of ['pieces.js', 'engine.js', 'ai.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx);
}
vm.runInContext(`
function perft(state, depth) {
  const moves = allLegalMoves(state);
  if (depth === 1) return moves.reduce((n, m) => n + (m.promote ? PROMOTION_CHOICES.length : 1), 0);
  let n = 0;
  for (const m of moves) {
    if (m.promote) for (const t of PROMOTION_CHOICES) n += perft(applyMove(state, { ...m, promotion: t }), depth - 1);
    else n += perft(applyMove(state, m), depth - 1);
  }
  return n;
}
this.perft = perft;
`, ctx);

const cases = [
  ['初期局面', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902]],
  ['Kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['Position3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['Position4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
];

let ok = true;
for (const [name, fen, expected] of cases) {
  const state = ctx.createStateFromFEN(fen);
  expected.forEach((exp, i) => {
    const got = ctx.perft(state, i + 1);
    const pass = got === exp;
    if (!pass) ok = false;
    console.log(`${pass ? 'OK ' : 'NG '} ${name} depth ${i + 1}: ${got} (正解 ${exp})`);
  });
}

const t = Date.now();
ctx.chooseCpuMove(ctx.createStateFromFEN(cases[1][1]));
console.log(`CPU 思考時間（複雑な局面）: ${Date.now() - t}ms`);
process.exit(ok ? 0 : 1);
