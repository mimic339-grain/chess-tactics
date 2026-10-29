// =====================================================================
//  ルールエンジン（合法手の生成・勝敗判定）
// =====================================================================
//  盤面は board[y][x]。y = 0 が上（黒側）、x = 0 が左（a列）。
//  駒は { type: 'K', color: 'w' | 'b', moved: false }。

const FILES = 'abcdefghijklmnop';

function opposite(color) { return color === 'w' ? 'b' : 'w'; }
function boardWidth(board) { return board[0].length; }
function boardHeight(board) { return board.length; }
function inBounds(board, x, y) { return x >= 0 && y >= 0 && x < boardWidth(board) && y < boardHeight(board); }
function cloneBoard(board) { return board.map(row => row.map(p => (p ? { ...p } : null))); }
function squareName(board, x, y) { return FILES[x] + (boardHeight(board) - y); }

function createInitialState() {
  const board = INITIAL_LAYOUT.map(row => row.split('').map(ch => {
    if (ch === '.') return null;
    const color = ch === ch.toUpperCase() ? 'w' : 'b';
    return { type: ch.toUpperCase(), color, moved: false };
  }));
  return { board, turn: 'w', enPassant: null, halfmove: 0, fullmove: 1 };
}

// デバッグ・テスト用：FEN 文字列から局面を作る（標準 8x8 のみ）
function createStateFromFEN(fen) {
  const [placement, turn, castling, ep, half, full] = fen.split(' ');
  const board = placement.split('/').map((row, y) => {
    const cells = [];
    for (const ch of row) {
      if (/\d/.test(ch)) { for (let i = 0; i < +ch; i++) cells.push(null); continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const type = ch.toUpperCase();
      // FEN ではキャスリング権で「動いたか」を表すので、王と飛車は一旦動いた扱いにする
      let moved = type === 'K' || type === 'R';
      if (type === 'P') moved = !((color === 'w' && y === 6) || (color === 'b' && y === 1));
      cells.push({ type, color, moved });
    }
    return cells;
  });
  const unmove = (x, y) => { if (board[y][x]) board[y][x].moved = false; };
  if (castling.includes('K')) { unmove(4, 7); unmove(7, 7); }
  if (castling.includes('Q')) { unmove(4, 7); unmove(0, 7); }
  if (castling.includes('k')) { unmove(4, 0); unmove(7, 0); }
  if (castling.includes('q')) { unmove(4, 0); unmove(0, 0); }
  const enPassant = ep === '-' ? null : [FILES.indexOf(ep[0]), 8 - +ep[1]];
  return { board, turn, enPassant, halfmove: +(half || 0), fullmove: +(full || 1) };
}

// ---------------------------------------------------------------------
//  疑似合法手（自分の王が取られるかは考えない）
//  attacksOnly = true のときは「利いているマス」だけ返す（チェック判定用）
// ---------------------------------------------------------------------
function pseudoMoves(board, x, y, enPassant, attacksOnly) {
  const p = board[y][x];
  const def = PIECES[p.type];
  const flip = p.color === 'w' ? 1 : -1;
  const res = [];
  const add = (nx, ny, extra) => res.push({ from: [x, y], to: [nx, ny], ...extra });

  for (const m of def.moves) {
    if (m.type === 'slide' || m.type === 'leap') {
      for (const [dx, dy0] of m.dirs) {
        const dy = dy0 * flip;
        let nx = x + dx, ny = y + dy;
        while (inBounds(board, nx, ny)) {
          const t = board[ny][nx];
          if (t) {
            if (t.color !== p.color || attacksOnly) add(nx, ny, { capture: true });
            break;
          }
          add(nx, ny);
          if (m.type === 'leap') break;
          nx += dx; ny += dy;
        }
      }
    } else if (m.type === 'pawn') {
      const fwd = -flip;
      const lastRow = p.color === 'w' ? 0 : boardHeight(board) - 1;
      const promo = ny => (ny === lastRow ? { promote: true } : {});
      for (const dx of [-1, 1]) {
        const nx = x + dx, ny = y + fwd;
        if (!inBounds(board, nx, ny)) continue;
        if (attacksOnly) { add(nx, ny); continue; }
        const t = board[ny][nx];
        if (t && t.color !== p.color) add(nx, ny, { capture: true, ...promo(ny) });
        else if (!t && enPassant && enPassant[0] === nx && enPassant[1] === ny) add(nx, ny, { capture: true, enPassant: true });
      }
      if (!attacksOnly) {
        const ny = y + fwd;
        if (inBounds(board, x, ny) && !board[ny][x]) {
          add(x, ny, promo(ny));
          const ny2 = y + fwd * 2;
          if (!p.moved && inBounds(board, x, ny2) && !board[ny2][x]) add(x, ny2, { double: true });
        }
      }
    }
  }
  return res;
}

function isAttacked(board, x, y, byColor) {
  for (let sy = 0; sy < boardHeight(board); sy++) {
    for (let sx = 0; sx < boardWidth(board); sx++) {
      const p = board[sy][sx];
      if (!p || p.color !== byColor) continue;
      if (pseudoMoves(board, sx, sy, null, true).some(m => m.to[0] === x && m.to[1] === y)) return true;
    }
  }
  return false;
}

function findRoyal(board, color) {
  for (let y = 0; y < boardHeight(board); y++)
    for (let x = 0; x < boardWidth(board); x++) {
      const p = board[y][x];
      if (p && p.color === color && PIECES[p.type].royal) return [x, y];
    }
  return null;
}

function inCheck(state, color) {
  const k = findRoyal(state.board, color);
  return k ? isAttacked(state.board, k[0], k[1], opposite(color)) : false;
}

function castlingMoves(state, x, y) {
  const board = state.board;
  const king = board[y][x];
  if (!PIECES[king.type].canCastle || king.moved) return [];
  const enemy = opposite(king.color);
  if (isAttacked(board, x, y, enemy)) return [];
  const res = [];
  for (const side of [{ name: 'K', rookX: boardWidth(board) - 1, dir: 1 }, { name: 'Q', rookX: 0, dir: -1 }]) {
    const rook = board[y][side.rookX];
    if (!rook || rook.color !== king.color || rook.moved || !PIECES[rook.type].castleRook) continue;
    let clear = true;
    for (let i = x + side.dir; i !== side.rookX; i += side.dir) if (board[y][i]) { clear = false; break; }
    if (!clear || isAttacked(board, x + side.dir, y, enemy)) continue;
    res.push({
      from: [x, y], to: [x + 2 * side.dir, y],
      castle: { side: side.name, rookFrom: [side.rookX, y], rookTo: [x + side.dir, y] },
    });
  }
  return res;
}

// 手を指した後の新しい局面を返す（元の state は変更しない）
function applyMove(state, move) {
  const board = cloneBoard(state.board);
  const [fx, fy] = move.from, [tx, ty] = move.to;
  const p = board[fy][fx];
  let captured = board[ty][tx];
  board[ty][tx] = p;
  board[fy][fx] = null;
  if (move.enPassant) { captured = board[fy][tx]; board[fy][tx] = null; }
  if (move.castle) {
    const [rx, ry] = move.castle.rookFrom, [rtx, rty] = move.castle.rookTo;
    board[rty][rtx] = board[ry][rx];
    board[ry][rx] = null;
    board[rty][rtx].moved = true;
  }
  p.moved = true;
  if (move.promote) board[ty][tx] = { type: move.promotion || PROMOTION_CHOICES[0], color: p.color, moved: true };
  return {
    board,
    turn: opposite(state.turn),
    enPassant: move.double ? [fx, (fy + ty) / 2] : null,
    halfmove: p.type === 'P' || captured ? 0 : state.halfmove + 1,
    fullmove: state.fullmove + (state.turn === 'b' ? 1 : 0),
  };
}

function legalMovesFrom(state, x, y) {
  const p = state.board[y][x];
  if (!p || p.color !== state.turn) return [];
  const moves = pseudoMoves(state.board, x, y, state.enPassant, false).concat(castlingMoves(state, x, y));
  return moves.filter(m => !inCheck(applyMove(state, m), p.color));
}

function allLegalMoves(state) {
  const res = [];
  for (let y = 0; y < boardHeight(state.board); y++)
    for (let x = 0; x < boardWidth(state.board); x++)
      if (state.board[y][x]?.color === state.turn) res.push(...legalMovesFrom(state, x, y));
  return res;
}

function positionKey(state) {
  const cells = state.board.map(row => row.map(p => {
    if (!p) return '.';
    const ch = p.color === 'w' ? p.type : p.type.toLowerCase();
    return ch + (p.moved && (p.type === 'K' || p.type === 'R') ? '*' : '');
  }).join('')).join('/');
  return cells + ' ' + state.turn + ' ' + (state.enPassant ? state.enPassant.join(',') : '-');
}

function insufficientMaterial(board) {
  const others = board.flat().filter(p => p && !PIECES[p.type].royal);
  return others.length === 0 || (others.length === 1 && (others[0].type === 'B' || others[0].type === 'N'));
}

// 棋譜表記（SAN）
function toSAN(state, move) {
  const board = state.board;
  if (move.castle) return move.castle.side === 'K' ? 'O-O' : 'O-O-O';
  const [fx, fy] = move.from, [tx, ty] = move.to;
  const p = board[fy][fx];
  const dest = squareName(board, tx, ty);
  const capture = move.capture ? 'x' : '';
  if (p.type === 'P') {
    return (capture ? FILES[fx] + 'x' : '') + dest + (move.promote ? '=' + (move.promotion || PROMOTION_CHOICES[0]) : '');
  }
  // 同じ種類の駒が同じマスに行ける場合は区別をつける
  const rivals = allLegalMoves(state).filter(m =>
    (m.from[0] !== fx || m.from[1] !== fy) && m.to[0] === tx && m.to[1] === ty && board[m.from[1]][m.from[0]].type === p.type);
  let dis = '';
  if (rivals.length) {
    if (!rivals.some(m => m.from[0] === fx)) dis = FILES[fx];
    else if (!rivals.some(m => m.from[1] === fy)) dis = String(boardHeight(board) - fy);
    else dis = squareName(board, fx, fy);
  }
  return p.type + dis + capture + dest;
}

// ---------------------------------------------------------------------
//  ゲーム全体の進行管理（履歴・一手戻し・勝敗）
// ---------------------------------------------------------------------
class Game {
  constructor() { this.reset(); }

  reset() {
    this.state = createInitialState();
    this.history = [];
    this.positionCounts = {};
    this._countPosition();
  }

  _countPosition() {
    const k = positionKey(this.state);
    this.positionCounts[k] = (this.positionCounts[k] || 0) + 1;
  }

  legalMovesFrom(x, y) { return legalMovesFrom(this.state, x, y); }

  play(move) {
    let san = toSAN(this.state, move);
    const next = applyMove(this.state, move);
    if (inCheck(next, next.turn)) san += allLegalMoves(next).length === 0 ? '#' : '+';
    this.history.push({ state: this.state, move, san, counts: { ...this.positionCounts } });
    this.state = next;
    this._countPosition();
  }

  undo() {
    const h = this.history.pop();
    if (!h) return false;
    this.state = h.state;
    this.positionCounts = h.counts;
    return true;
  }

  lastMove() { return this.history.length ? this.history[this.history.length - 1].move : null; }

  status() {
    const s = this.state;
    const check = inCheck(s, s.turn);
    if (allLegalMoves(s).length === 0) {
      return check
        ? { over: true, winner: opposite(s.turn), reason: 'チェックメイト' }
        : { over: true, winner: null, reason: 'ステイルメイト' };
    }
    if (s.halfmove >= 100) return { over: true, winner: null, reason: '50手ルール' };
    if (this.positionCounts[positionKey(s)] >= 3) return { over: true, winner: null, reason: '同一局面3回' };
    if (insufficientMaterial(s.board)) return { over: true, winner: null, reason: '駒不足' };
    return { over: false, check };
  }
}
