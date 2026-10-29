// =====================================================================
//  画面表示と操作
// =====================================================================

const CPU_COLOR = 'b';

const game = new Game();
let selected = null;      // 選択中のマス [x, y]
let selectedMoves = [];   // 選択中の駒の合法手
let flipped = false;
let cpuEnabled = false;
let thinking = false;

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const movesEl = document.getElementById('moves');
const undoBtn = document.getElementById('btn-undo');
const promoEl = document.getElementById('promo');
const promoChoicesEl = document.getElementById('promo-choices');

const COLOR_NAME = { w: '白', b: '黒' };

function render() {
  const board = game.state.board;
  const W = boardWidth(board), H = boardHeight(board);
  const status = game.status();
  const last = game.lastMove();
  const checkSq = status.check || (status.over && status.winner) ? findRoyal(board, game.state.turn) : null;

  boardEl.style.gridTemplateColumns = `repeat(${W}, 1fr)`;
  boardEl.style.gridTemplateRows = `repeat(${H}, 1fr)`;
  boardEl.style.aspectRatio = `${W} / ${H}`;
  boardEl.innerHTML = '';

  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const x = flipped ? W - 1 - col : col;
      const y = flipped ? H - 1 - row : row;
      const sq = document.createElement('div');
      sq.className = 'sq ' + ((x + y) % 2 === 0 ? 'light' : 'dark');
      const same = (a) => a && a[0] === x && a[1] === y;
      if (last && (same(last.from) || same(last.to))) sq.classList.add('last');
      if (same(selected)) sq.classList.add('selected');
      if (same(checkSq)) sq.classList.add('check');
      const mv = selectedMoves.find(m => same(m.to));
      if (mv) sq.classList.add(mv.capture ? 'target-capture' : 'target');

      const p = board[y][x];
      if (p) {
        const span = document.createElement('span');
        span.className = 'piece ' + (p.color === 'w' ? 'white' : 'black');
        span.textContent = PIECES[p.type].symbol;
        span.title = COLOR_NAME[p.color] + 'の' + PIECES[p.type].name;
        sq.appendChild(span);
      }
      if (col === 0) sq.insertAdjacentHTML('beforeend', `<span class="coord rank">${H - y}</span>`);
      if (row === H - 1) sq.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[x]}</span>`);
      sq.addEventListener('click', () => onSquare(x, y));
      boardEl.appendChild(sq);
    }
  }

  // 状態表示
  if (status.over) {
    statusEl.textContent = status.winner
      ? `${status.reason}！ ${COLOR_NAME[status.winner]}の勝ち`
      : `${status.reason}で引き分け`;
    statusEl.className = 'status over';
  } else {
    let text = `${COLOR_NAME[game.state.turn]}の番`;
    if (thinking) text += '（CPU 考え中…）';
    if (status.check) text += ' ― チェック！';
    statusEl.textContent = text;
    statusEl.className = 'status' + (status.check ? ' check' : '');
  }

  // 棋譜
  movesEl.innerHTML = '';
  for (let i = 0; i < game.history.length; i += 2) {
    const li = document.createElement('li');
    li.textContent = game.history[i].san + (game.history[i + 1] ? '　' + game.history[i + 1].san : '');
    movesEl.appendChild(li);
  }
  movesEl.scrollTop = movesEl.scrollHeight;
  undoBtn.disabled = thinking || game.history.length === 0;
}

function onSquare(x, y) {
  if (thinking || game.status().over) return;
  if (cpuEnabled && game.state.turn === CPU_COLOR) return;

  if (selected) {
    const mv = selectedMoves.find(m => m.to[0] === x && m.to[1] === y);
    if (mv) { playerMove(mv); return; }
  }
  const p = game.state.board[y][x];
  if (p && p.color === game.state.turn && !(selected && selected[0] === x && selected[1] === y)) {
    selected = [x, y];
    selectedMoves = game.legalMovesFrom(x, y);
  } else {
    selected = null;
    selectedMoves = [];
  }
  render();
}

async function playerMove(mv) {
  if (mv.promote) {
    const choice = await askPromotion(game.state.turn);
    if (!choice) return;
    mv = { ...mv, promotion: choice };
  }
  game.play(mv);
  selected = null;
  selectedMoves = [];
  render();
  maybeCpuTurn();
}

function maybeCpuTurn() {
  if (!cpuEnabled || game.state.turn !== CPU_COLOR || game.status().over) return;
  thinking = true;
  render();
  // 画面を一度描画してから考え始める
  setTimeout(() => {
    const mv = chooseCpuMove(game.state);
    thinking = false;
    if (mv) game.play(mv.promote ? { ...mv, promotion: 'Q' } : mv);
    render();
  }, 50);
}

function askPromotion(color) {
  return new Promise(resolve => {
    promoChoicesEl.innerHTML = '';
    for (const type of PROMOTION_CHOICES) {
      const btn = document.createElement('button');
      btn.className = 'piece ' + (color === 'w' ? 'white' : 'black');
      btn.textContent = PIECES[type].symbol;
      btn.title = PIECES[type].name;
      btn.onclick = () => { promoEl.classList.add('hidden'); resolve(type); };
      promoChoicesEl.appendChild(btn);
    }
    promoEl.onclick = (e) => { if (e.target === promoEl) { promoEl.classList.add('hidden'); resolve(null); } };
    promoEl.classList.remove('hidden');
  });
}

document.getElementById('btn-new').onclick = () => {
  if (thinking) return;
  game.reset();
  selected = null; selectedMoves = [];
  render();
  maybeCpuTurn();
};

undoBtn.onclick = () => {
  if (thinking) return;
  game.undo();
  // CPU 対戦中は自分の番まで戻す
  if (cpuEnabled && game.state.turn === CPU_COLOR) game.undo();
  selected = null; selectedMoves = [];
  render();
};

document.getElementById('btn-flip').onclick = () => { flipped = !flipped; render(); };

document.getElementById('cpu-toggle').onchange = (e) => {
  cpuEnabled = e.target.checked;
  render();
  maybeCpuTurn();
};

render();
