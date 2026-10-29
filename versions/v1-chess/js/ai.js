// =====================================================================
//  簡易 CPU（駒得だけを見る先読み）
// =====================================================================

const CPU_DEPTH = 3; // 先読みの深さ。大きいほど強いが遅い

function evaluate(state) {
  let score = 0;
  for (const row of state.board)
    for (const p of row)
      if (p) score += (p.color === state.turn ? 1 : -1) * PIECES[p.type].value;
  return score;
}

// 取る手を先に調べると枝刈りが効きやすい
function orderMoves(moves) {
  return moves.sort((a, b) => (b.capture ? 1 : 0) - (a.capture ? 1 : 0));
}

function negamax(state, depth, alpha, beta) {
  if (depth === 0) return evaluate(state);
  const moves = allLegalMoves(state);
  if (moves.length === 0) return inCheck(state, state.turn) ? -10000 - depth : 0;
  let best = -Infinity;
  for (const m of orderMoves(moves)) {
    const score = -negamax(applyMove(state, m), depth - 1, -beta, -alpha);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function chooseCpuMove(state) {
  const moves = allLegalMoves(state);
  // 同点の手からランダムに選ばれるよう先にシャッフル
  for (let i = moves.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [moves[i], moves[j]] = [moves[j], moves[i]];
  }
  let best = null, bestScore = -Infinity;
  for (const m of orderMoves(moves)) {
    const score = -negamax(applyMove(state, m), CPU_DEPTH - 1, -Infinity, -bestScore);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}
