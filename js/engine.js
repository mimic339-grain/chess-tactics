// =====================================================================
//  ルールエンジン（タクティクス版）
// =====================================================================
//  盤面は board[y][x]。y = 0 が上（黒側）、x = 0 が左（a列）。
//  キャラは { type, color, hp, maxHp, moveHp, ammo, facing, buffs, moved, acted }。
//  行動する関数はすべて「新しい state を返す」。元の state は変えない（一手戻しのため）。

const FILES = 'abcdefghijklmnop';
const COLOR_NAME = { w: '白', b: '黒' };

function opposite(color) { return color === 'w' ? 'b' : 'w'; }
function boardWidth(board) { return board[0].length; }
function boardHeight(board) { return board.length; }
function inBounds(board, x, y) { return x >= 0 && y >= 0 && x < boardWidth(board) && y < boardHeight(board); }
function squareName(board, x, y) { return FILES[x] + (boardHeight(board) - y); }
function cloneState(state) { return JSON.parse(JSON.stringify(state)); }
function chebyshev(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
function emptyGrid() { return INITIAL_LAYOUT.map(row => row.split('').map(() => null)); }

let nextUnitId = 1;

function makeUnit(type, color) {
  const def = UNITS[type];
  return {
    id: 'u' + nextUnitId++, // 隊長虫の部隊などでキャラを見分けるための番号
    type, color, hp: def.hp, maxHp: def.hp,
    moveHp: def.moveHp, ammo: def.ammo ? (def.ammo.start ?? def.ammo.max) : null,
    ammoMax: def.ammo ? def.ammo.max : null, // 最大MP（マナウィッチ・めぐみんはターンごとに増える）
    cooldowns: {},                           // スキル名 → 使えるようになるまでのターン
    deathThreshold: def.doom ? def.doom.start : null, // オーバーロード：即死の呪いが効くHPの割合
    repairs: def.repairs ?? null,            // 建物の修理回数
    evo: 0, atkBonus: 0, // 進化した回数と、進化で上がった攻撃力
    freeUsed: false,     // 「タダで使える」スキルを今ターン使ったか
    squad: [],           // 隊長虫の部隊（キャラの id）
    facing: def.shield ? (color === 'w' ? [0, -1] : [0, 1]) : null, // シールドの向き（最初は敵の方）
    buffs: [],
    charge: def.charge ? 0 : null, // 龍呼びの巫女の祈りの回数
    hitRunPending: false,          // ヒット＆アウェイ：攻撃のあとの2回目の移動が残っているか
    moved: false, acted: false,
  };
}

// decks = { w: { 'x,y': 'F', ... }, b: {...} }。省略すると INITIAL_LAYOUT の並び
function createInitialState(decks) {
  const board = INITIAL_LAYOUT.map((row, y) => row.split('').map((ch, x) => {
    const color = campOwner(x, y);
    if (!color) return null;
    const type = decks && decks[color] ? decks[color][x + ',' + y] : (ch === '.' ? null : ch.toUpperCase());
    return type ? makeUnit(type, color) : null;
  }));
  // 王龍ゼノ：置いた場所は霊廟になり、ゼノ本人は霊廟の前（相手側）の空いているマスに立つ
  board.forEach((row, y) => row.forEach((u, x) => {
    if (!u || !UNITS[u.type].mausoleum) return;
    row[x] = makeUnit(UNITS[u.type].mausoleum, u.color);
    const spot = nearestFree(board, u.color, x, y);
    if (spot) board[spot[1]][spot[0]] = u;
  }));
  // 移動速度の合計が大きい側が先攻（同じなら白）
  const speeds = { w: 0, b: 0 };
  board.flat().forEach(u => { if (u) speeds[u.color] += unitSpeed(u.type); });
  const first = speeds.b > speeds.w ? 'b' : 'w';
  return {
    board, turn: first, first, speeds,
    actionsLeft: RULES.firstTurnActions ?? RULES.actionsPerTurn, round: 1, // 先攻の最初だけ少ない
    points: { w: 0, b: 0 }, reinforced: { w: false, b: false }, // ポイントと、今ターン増援を呼んだか
    lastCombatRound: 1,
    respawns: [], respawnCount: { w: 0, b: 0 }, // 王龍ゼノの復活待ちと、倒された回数   // 最後にダメージが入った巡（CPU が「しばらく戦っていない」を判断するのに使う）
    oneways: [],          // 二刀流の一方通行エリア { x, y, dir, color, ownerId, turns }
    scorched: emptyGrid(), // 一刀の黒刀で壊されたマス（何も置けない）
    fortresses: [], fortressBuilds: [], // セミラミスの浮遊要塞と、建造中のもの
    territory: initialTerritory(),
    flags: [], // 陣取りルークの旗 { id, color, x, y, wall, castle, build }
    supply: emptyGrid(), // 補給路 supply[y][x] = 'w' | 'b' | null
    warps: { w: [], b: [] }, // クイーンのワープ地点
    traps: [], alerts: [], // 罠・アラート
    descents: [], // バハムート降臨の予約 { color, turns, spot, unit }
    winReason: null,
    winner: null, lastAction: null, effects: [],
    log: [
      { color: null, text: `移動速度の合計 白 ${speeds.w} ／ 黒 ${speeds.b} → ${COLOR_NAME[first]}が先攻` },
      { color: null, text: `― ${COLOR_NAME[first]}のターン（1巡目）―` },
    ],
  };
}

// (x, y) に一番近い空きマス（同じ距離なら相手側＝前を優先）
function nearestFree(board, color, x, y) {
  let best = null;
  for (let ny = 0; ny < board.length; ny++)
    for (let nx = 0; nx < board[0].length; nx++) {
      if (board[ny][nx] || (nx === x && ny === y)) continue;
      const d = chebyshev(x, y, nx, ny) * 10 + (color === 'w' ? ny : board.length - 1 - ny) * 0.1;
      if (!best || d < best[0]) best = [d, nx, ny];
    }
  return best ? [best[1], best[2]] : null;
}

// 移動速度：満タンの移動HPで何マス動けるか
function unitSpeed(type) {
  const def = UNITS[type];
  if (def.move.type === 'area') return def.move.max;
  if (def.move.type === 'none') return 0;
  return Math.floor(def.moveHp / (def.stepCost ?? RULES.stepCost));
}

// ---------------------------------------------------------------------
//  デッキ（試合前の配置）
// ---------------------------------------------------------------------
// 陣営（キャラを置けるマス）。盤の手前側から CAMP.depth 行、中央の CAMP.width 列
function campOwner(x, y) {
  const W = INITIAL_LAYOUT[0].length, H = INITIAL_LAYOUT.length;
  const left = Math.floor((W - CAMP.width) / 2);
  if (x < left || x >= left + CAMP.width) return null;
  if (y >= H - CAMP.depth) return 'w';
  if (y < CAMP.depth) return 'b';
  return null;
}
function isCampOf(color, x, y) { return campOwner(x, y) === color; }
function isEnemyCamp(color, x, y) { return isCampOf(opposite(color), x, y); }

function defaultDeck(color) {
  const deck = {};
  INITIAL_LAYOUT.forEach((row, y) => row.split('').forEach((ch, x) => {
    if (ch !== '.' && isCampOf(color, x, y)) deck[x + ',' + y] = ch.toUpperCase();
  }));
  return deck;
}

// デッキの問題点を文章で返す（空なら OK）
function deckErrors(deck, color) {
  const errors = [], counts = {};
  for (const [key, type] of Object.entries(deck)) {
    const [x, y] = key.split(',').map(Number);
    if (!UNITS[type]) { errors.push(`知らないキャラ ${type}`); continue; }
    if (UNITS[type].summonOnly) { errors.push(`${UNITS[type].name} は召喚専用`); continue; }
    if (!INITIAL_LAYOUT[y] || !isCampOf(color, x, y)) errors.push(`${UNITS[type].name} が陣営の外にいる`);
    counts[type] = (counts[type] || 0) + 1;
  }
  for (const [type, n] of Object.entries(counts)) {
    const max = UNITS[type].deckMax;
    if (max != null && n > max) errors.push(`${UNITS[type].name} は ${max} 体まで（今 ${n} 体）`);
  }
  // 枠ごとの数はチェスと同じ（キング1・クイーン1・ルーク2・ビショップ2・ナイト2・ポーン8）
  for (const [role, info] of Object.entries(ROLES)) {
    const n = roleCount(deck, role);
    if (n !== info.count) errors.push(`${info.name}は ${info.count} 体（今 ${n} 体）`);
  }
  return errors;
}

function roleCount(deck, role) {
  return Object.values(deck).filter(t => UNITS[t] && UNITS[t].role === role).length;
}

function forEachUnit(state, fn) {
  state.board.forEach((row, y) => row.forEach((u, x) => { if (u) fn(u, x, y); }));
}

// バフ込みの攻撃力
function effectiveAtk(u) {
  const atk = UNITS[u.type].atk + (u.atkBonus || 0) + u.buffs.filter(b => b.stat === 'atk').reduce((n, b) => n + b.amount, 0);
  return u.buffs.some(b => b.stat === 'weaken') ? Math.max(1, Math.floor(atk / 2)) : atk; // 呪術の攻撃力半減
}

// ---------------------------------------------------------------------
//  陣地
// ---------------------------------------------------------------------
//  territory[y][x] = 'w' | 'b' | null。初期配置でキャラがいたマスはその色の陣営で、乗っ取れない。
function isLockedSquare(x, y) { return campOwner(x, y) !== null; }

function initialTerritory() {
  return INITIAL_LAYOUT.map((row, y) => row.split('').map((ch, x) => campOwner(x, y)));
}

function claimSquare(s, color, x, y) {
  if (!inBounds(s.board, x, y) || isLockedSquare(x, y) || s.territory[y][x] === color || s.scorched[y][x]) return 0;
  s.territory[y][x] = color;
  return 1;
}

// 通ったマスと、到着マスの周囲9マスを自陣にする。増えたマス数を返す
function claimTerritory(s, color, path, to) {
  let gained = 0;
  for (const [x, y] of path) gained += claimSquare(s, color, x, y);
  const [tx, ty] = to;
  for (let y = ty - 1; y <= ty + 1; y++)
    for (let x = tx - 1; x <= tx + 1; x++) gained += claimSquare(s, color, x, y);
  return gained;
}

function countTerritory(state, color) {
  return state.territory.flat().filter(c => c === color).length;
}

// ---------------------------------------------------------------------
//  補給路
// ---------------------------------------------------------------------
// 敵が踏んだ補給路を壊し、そこから先の「自陣とつながっていない部分」も壊す
function breakSupply(s, mover, cells) {
  const broken = new Set();
  for (const [x, y] of cells) {
    const c = s.supply[y][x];
    if (c && c !== mover.color) { s.supply[y][x] = null; broken.add(c); }
  }
  for (const color of broken) pruneSupply(s, color);
  return broken.size > 0;
}

// 自陣（陣地）に接している補給路から上下左右にたどれないマスを消す。消したマス数を返す
function pruneSupply(s, color) {
  const W = boardWidth(s.board), H = boardHeight(s.board);
  const isOwn = (x, y) => inBounds(s.board, x, y) && s.supply[y][x] === color;
  const touchesHome = (x, y) => s.territory[y][x] === color ||
    ORTHO.some(([dx, dy]) => inBounds(s.board, x + dx, y + dy) && s.territory[y + dy][x + dx] === color);
  const keep = new Set(), queue = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (isOwn(x, y) && touchesHome(x, y)) { keep.add(x + ',' + y); queue.push([x, y]); }
  while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if (isOwn(nx, ny) && !keep.has(k)) { keep.add(k); queue.push([nx, ny]); }
    }
  }
  let removed = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (isOwn(x, y) && !keep.has(x + ',' + y)) { s.supply[y][x] = null; removed++; }
  return removed;
}

// 自分の補給路の上で止まったときの補給
function applySupply(s, u, x, y) {
  if (!isSupplyFor(s, u.color, x, y)) return '';
  const def = UNITS[u.type], got = [];
  let general = false; // 兵站将軍がいれば回復量1.5倍
  forEachUnit(s, t => { if (t.color === u.color && t.type === 'L' && t.evolved) general = true; });
  const m = general ? 1.5 : 1, base = RULES.supply;
  const sp = { moveHp: Math.round(base.moveHp * m), ammo: Math.round(base.ammo * m), hp: Math.round(base.hp * m) };
  const mh = Math.min(sp.moveHp, def.moveHp - u.moveHp);
  if (mh > 0) { u.moveHp += mh; got.push(`移動HP+${mh}`); }
  if (def.ammo) {
    const a = Math.min(sp.ammo, u.ammoMax - u.ammo);
    if (a > 0) { u.ammo += a; got.push(`${def.ammo.name}+${a}`); }
  }
  const h = Math.min(sp.hp, u.maxHp - u.hp);
  if (h > 0) { u.hp += h; got.push(`HP+${h}`); }
  if (got.length) s.effects.push({ x, y, text: '補給', kind: 'supply' });
  return got.length ? `、補給（${got.join(' ')}）` : '';
}

// ---------------------------------------------------------------------
//  シールド
// ---------------------------------------------------------------------
// color 側のシールドを線分 [x1, y1, x2, y2]（マスの中心が整数座標）で返す
function shieldSegments(state, color) {
  const segs = [];
  forEachUnit(state, (u, x, y) => {
    const sh = UNITS[u.type].shield;
    if (u.color !== color || !sh) return;
    const [fx, fy] = u.facing, w = (u.evolved ? 5 : sh.width) / 2;
    if (u.evolved) { // 後ろ側にも張る
      if (fx === 0) segs.push([x - w, y - fy / 2, x + w, y - fy / 2]);
      else segs.push([x - fx / 2, y - w, x - fx / 2, y + w]);
    }
    if (fx === 0) segs.push([x - w, y + fy / 2, x + w, y + fy / 2]);
    else segs.push([x + fx / 2, y - w, x + fx / 2, y + w]);
  });
  return segs;
}

function segmentsCross(ax, ay, bx, by, [cx, cy, dx, dy]) {
  const side = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return side(ax, ay, bx, by, cx, cy) * side(ax, ay, bx, by, dx, dy) < 0 &&
         side(cx, cy, dx, dy, ax, ay) * side(cx, cy, dx, dy, bx, by) < 0;
}

// 攻撃の射線が相手のシールドを横切るか
function isShielded(state, attacker, ax, ay, tx, ty) {
  if (chebyshev(ax, ay, tx, ty) < RULES.shieldMinRange) return false;
  return shieldSegments(state, opposite(attacker.color)).some(seg => segmentsCross(ax, ay, tx, ty, seg));
}

// ---------------------------------------------------------------------
//  行動できるかどうか
// ---------------------------------------------------------------------
function hasStarted(u) { return u.moved || u.acted; }
function isDone(u) {
  if (u.hitRunPending) return false; // ヒット＆アウェイの2回目の移動が残っている
  return u.acted || (u.moved && !RULES.moveAndAct);
}

// このキャラに今ターン命令できるか（新しく動かすなら残り人数が必要）
function canCommand(state, u) {
  if (!u || state.winner || u.color !== state.turn || isDone(u) || isBuilding(u) || UNITS[u.type].immobile) return false;
  return hasStarted(u) || state.actionsLeft > 0 || !!UNITS[u.type].freeActor;
}
// レオニダスの陣形：使うたびに行動回数を1使う。レオニダスがもう行動していても、行動回数が残っていれば何回でも使える
function canUsePassive(state, u) {
  return !!u && !state.winner && u.color === state.turn && state.actionsLeft > 0 && !isBuilding(u) && UNITS[u.type].skills.some(sk => sk.passive);
}
function canMove(state, x, y) {
  const u = state.board[y][x];
  if (!canCommand(state, u) || isSnared(u) || hasBuff(u, 'rooted')) return false;
  if (u.hitRunPending) return true; // ヒット＆アウェイの2回目
  return !u.moved && !u.acted;
}
function canUseSkill(state, x, y) {
  const u = state.board[y][x];
  return canCommand(state, u) && !u.acted;
}

// ---------------------------------------------------------------------
//  移動
// ---------------------------------------------------------------------

// 白から見た向きをキャラの色に合わせる
function orient(u, [dx, dy]) { return u.color === 'w' ? [dx, dy] : [dx, -dy]; }

// チェス式の動きで線をたどる。誰かにぶつかったらその方向は終わり。step は何マス目か
function tracePattern(board, x, y, u, moves, visit) {
  for (const m of moves) {
    for (const dir of m.dirs) {
      const [dx, dy] = orient(u, dir);
      let nx = x + dx, ny = y + dy, step = 1;
      while (inBounds(board, nx, ny)) {
        const t = board[ny][nx];
        visit(nx, ny, t, step, m.type);
        if (t || m.type === 'leap') break;
        nx += dx; ny += dy; step++;
      }
    }
  }
}

function stepCostOf(u) { return UNITS[u.type].stepCost ?? RULES.stepCost; }

// そのマスに入るのに払う移動HP（自分の補給路は高速道路でタダ）
function enterCost(state, u, x, y) {
  const slow = u.buffs && u.buffs.some(b => b.stat === 'slow') ? 2 : 1; // 呪術の鈍足は移動コスト2倍
  if (inSwamp(state, x, y)) return stepCostOf(u) * 2 * slow;           // 泥沼は1マス2
  return baseEnterCost(state, u, x, y) * slow;
}
function baseEnterCost(state, u, x, y) {
  const fz = fortressAt(state, x, y);
  if (fz) return fz.color === u.color ? 0 : stepCostOf(u) + SKY.boardCost; // 空にあるので乗り込むのが大変
  if (RULES.supply.freeTravel && state.supply[y][x] === u.color) return 0;
  return stepCostOf(u);
}

// 移動先の一覧 [x, y, 消費する移動HP, 通るマス]。今の移動HPで払える範囲だけ
function moveTargets(state, x, y) {
  const board = state.board, u = board[y][x], mv = unitMoveDef(u);
  const best = new Map();
  const add = (nx, ny, cost, path) => {
    const k = nx + ',' + ny;
    if (cost <= u.moveHp && (!best.has(k) || best.get(k)[2] > cost)) best.set(k, [nx, ny, cost, path]);
  };

  if (mv.type === 'pattern') {
    for (const m of mv.moves) {
      for (const dir of m.dirs) {
        const [dx, dy] = orient(u, dir);
        let nx = x + dx, ny = y + dy, cost = 0;
        const path = [];
        while (inBounds(board, nx, ny) && !board[ny][nx] && stepAllowed(state, nx - dx, ny - dy, nx, ny) && !isWarded(state, u.color, nx, ny)) {
          cost += enterCost(state, u, nx, ny);
          path.push([nx, ny]);
          add(nx, ny, cost, path.slice());
          if (m.type === 'leap') break;
          nx += dx; ny += dy;
        }
      }
    }
  } else if (mv.type === 'area') {
    for (let ny = y - mv.max; ny <= y + mv.max; ny++)
      for (let nx = x - mv.max; nx <= x + mv.max; nx++)
        if (inBounds(board, nx, ny) && !board[ny][nx] && !isWarded(state, u.color, nx, ny)) {
          const free = RULES.supply.freeTravel && state.supply[ny][nx] === u.color;
          add(nx, ny, free ? 0 : chebyshev(x, y, nx, ny) * stepCostOf(u), [[nx, ny]]);
        }
  } else if (mv.type === 'points') {
    // 1歩ずつ歩く。味方はすり抜けられるが敵は通れない
    const cost = { [x + ',' + y]: 0 }, parent = {};
    const queue = [[x, y]];
    while (queue.length) {
      const [cx, cy] = queue.shift();
      for (const [dx, dy] of ORTHO) {
        const nx = cx + dx, ny = cy + dy, key = nx + ',' + ny;
        if (!inBounds(board, nx, ny) || !stepAllowed(state, cx, cy, nx, ny)) continue;
        const nc = cost[cx + ',' + cy] + enterCost(state, u, nx, ny);
        if (nc > u.moveHp || (key in cost && cost[key] <= nc)) continue;
        const t = board[ny][nx];
        if (t && t.color !== u.color && !mv.ignoreUnits) continue;
        if (isWarded(state, u.color, nx, ny)) continue; // 相手の結界には入れない
        cost[key] = nc;
        parent[key] = cx + ',' + cy;
        queue.push([nx, ny]);
      }
    }
    for (const key in cost) {
      const [nx, ny] = key.split(',').map(Number);
      if (board[ny][nx]) continue;
      const path = [];
      for (let k = key; k !== x + ',' + y; k = parent[k]) path.unshift(k.split(',').map(Number));
      add(nx, ny, cost[key], path);
    }
  }
  // ワープゲート：片方のゲートに入ると、もう一方のゲートから出る（5番目の要素 = 実際に着くマス）
  const warps = (state.warps && state.warps[u.color]) || [];
  if (mv.type !== 'route' && warps.length === 2) {
    const otherGate = (gx, gy) => warps.find(w => w[0] !== gx || w[1] !== gy);
    for (const t of best.values()) {
      const [ox, oy] = otherGate(t[0], t[1]);
      const isGate = warps.some(w => w[0] === t[0] && w[1] === t[1]);
      if (isGate && (!board[oy][ox] || (ox === x && oy === y))) t[4] = [ox, oy];
    }
    // ゲートの上に立っているなら、移動HP 0 でもう一方へ
    if (warps.some(w => w[0] === x && w[1] === y)) {
      const [ox, oy] = otherGate(x, y);
      if (!board[oy][ox]) add(ox, oy, 0, [[ox, oy]]);
    }
  }
  // 'route' は moveTargets を使わず、routeNextSteps で1マスずつ決める
  return [...best.values()].filter(t => moveLimitOk(state, u, x, y, t[4] || [t[0], t[1]]));
}

// 一方通行エリアの中・出入りは、決められた向きにしか進めない
function stepAllowed(state, cx, cy, nx, ny) {
  for (const z of state.oneways || []) {
    const touches = chebyshev(z.x, z.y, cx, cy) <= 1 || chebyshev(z.x, z.y, nx, ny) <= 1;
    if (touches && (nx - cx !== z.dir[0] || ny - cy !== z.dir[1])) return false;
  }
  return true;
}

// 山の翁：自分の攻撃範囲にいる敵はその外に出られない ／ セミラミス：要塞から出られない
function moveLimitOk(state, u, x, y, [tx, ty]) {
  if (isWarded(state, u.color, tx, ty)) return false;
  let ok = true;
  forEachUnit(state, (b, bx, by) => {
    if (!ok || b.color === u.color || !UNITS[b.type].binding) return;
    const r = bindRange(b);
    if (chebyshev(bx, by, x, y) <= r && chebyshev(bx, by, tx, ty) > r) ok = false;
  });
  if (ok && UNITS[u.type].skills.some(sk => sk.kind === 'fortressBuild')) {
    const f = (state.fortresses || []).find(f => f.color === u.color);
    if (f && chebyshev(f.x, f.y, tx, ty) > fortRadius(f)) ok = false;
  }
  return ok;
}

function bindRange(b) {
  return Math.max(...UNITS[b.type].skills.filter(sk => sk.kind === 'damage' && sk.range.type === 'area').map(sk => sk.range.max));
}

// 補給ナイト：今の道の続きとして進めるマス
function routeNextSteps(state, from, path) {
  const u = state.board[from[1]][from[0]];
  const [cx, cy] = path.length ? path[path.length - 1] : from;
  const spent = routeCost(state, u, path);
  return ORTHO.map(([dx, dy]) => [cx + dx, cy + dy]).filter(([nx, ny]) =>
    inBounds(state.board, nx, ny) && !state.board[ny][nx] &&
    stepAllowed(state, cx, cy, nx, ny) && moveLimitOk(state, u, from[0], from[1], [nx, ny]) &&
    !path.some(p => p[0] === nx && p[1] === ny) &&
    spent + enterCost(state, u, nx, ny) <= u.moveHp);
}

function routeCost(state, u, path) {
  return path.reduce((n, [x, y]) => n + enterCost(state, u, x, y), 0);
}

// ---------------------------------------------------------------------
//  陣形移動（レオニダス）
// ---------------------------------------------------------------------
//  1. 動かす「基準」を選ぶ：'row' = 好きな味方（その味方と左右につながって並ぶ味方全員）
//                          'area' = 好きなマス（そこを中心にした9マスにいる味方全員）
//  2. 基準の行き先を選ぶ：グループ全員が同じ方向に同じマス数だけ動く

function formationMembers(state, color, shape, [ax, ay]) {
  const ally = (nx, ny) => inBounds(state.board, nx, ny) && state.board[ny][nx] && state.board[ny][nx].color === color && !UNITS[state.board[ny][nx].type].immobile;
  const res = [];
  if (shape === 'row') {
    if (!ally(ax, ay)) return res;
    res.push([ax, ay]);
    for (const d of [-1, 1]) for (let nx = ax + d; ally(nx, ay); nx += d) res.push([nx, ay]);
  } else {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (ally(ax + dx, ay + dy)) res.push([ax + dx, ay + dy]);
  }
  return res;
}

// 選べる基準のマス
function formationAnchors(state, color, shape) {
  const res = [];
  for (let y = 0; y < boardHeight(state.board); y++)
    for (let x = 0; x < boardWidth(state.board); x++)
      if (formationMembers(state, color, shape, [x, y]).length) res.push([x, y]);
  return res;
}

// 基準の行き先。全員の通り道が空いていて、全員が移動HPを払えること
function formationTargets(state, color, skill, anchor) {
  const members = formationMembers(state, color, skill.shape, anchor);
  const inGroup = new Set(members.map(p => p.join(',')));
  const res = [];
  for (const [dx, dy] of ORTHO) {
    for (let d = 1; d <= skill.maxDist; d++) {
      const ok = members.length > 0 && members.every(([mx, my]) => {
        for (let i = 1; i <= d; i++) {
          const px = mx + dx * i, py = my + dy * i;
          if (!inBounds(state.board, px, py)) return false;
          if (state.board[py][px] && !inGroup.has(px + ',' + py)) return false;
        }
        const mu = state.board[my][mx];
        return skill.passive || mu.moveHp >= d * stepCostOf(mu); // レオニダスの陣形は移動HPを使わない
      });
      if (!ok) break;
      res.push([anchor[0] + dx * d, anchor[1] + dy * d]);
    }
  }
  return res;
}

// 陣形移動を実行する（from = 使うキャラ、anchor = 基準、dest = 基準の行き先）
function performFormation(state, from, skillIndex, anchor, dest) {
  const sk = UNITS[state.board[from[1]][from[0]].type].skills[skillIndex];
  const legal = formationTargets(state, state.board[from[1]][from[0]].color, sk, anchor);
  if (!legal.some(p => p[0] === dest[0] && p[1] === dest[1])) return state; // 動けない行き先は無視
  const s = cloneState(state);
  s.effects = [];
  const [fx, fy] = from;
  const u = s.board[fy][fx], skill = effSkill(u, UNITS[u.type].skills[skillIndex]);
  const who = unitLabel(s.board, u, fx, fy);
  if (skill.passive) s.actionsLeft--; // 陣形は使うたびに行動回数を1使う（レオニダス本人は行動済みにならない）
  else { beginAction(s, u); u.acted = true; }
  const dx = Math.sign(dest[0] - anchor[0]), dy = Math.sign(dest[1] - anchor[1]);
  const d = Math.max(Math.abs(dest[0] - anchor[0]), Math.abs(dest[1] - anchor[1]));
  const members = formationMembers(s, u.color, skill.shape, anchor);
  const movers = members.map(([mx, my]) => s.board[my][mx]);
  members.forEach(([mx, my]) => { s.board[my][mx] = null; });
  members.forEach(([mx, my], i) => {
    const mu = movers[i];
    s.board[my + dy * d][mx + dx * d] = mu;
    if (!skill.passive) mu.moveHp -= d * stepCostOf(mu);
    const path = [];
    for (let k = 1; k <= d; k++) path.push([mx + dx * k, my + dy * k]);
    breakSupply(s, mu, path);
    if (skill.guard) {
      const stat = skill.guard.stat || 'guard';
      mu.buffs = mu.buffs.filter(b => b.stat !== stat);
      mu.buffs.push({ stat, amount: skill.guard.amount || 0, turns: skill.guard.turns, label: skill.guard.label, debuff: false });
    }
  });
  s.lastAction = { from: anchor, to: dest };
  const dirName = { '0,-1': '上', '0,1': '下', '1,0': '右', '-1,0': '左' }[dx + ',' + dy];
  s.log.push({ color: u.color, text: `${who} の${skill.name}：${members.length}人を${dirName}へ ${d} マス` + (skill.guard ? `、${skill.guard.label}` : '') });
  return finishAction(s);
}

// ---------------------------------------------------------------------
//  スキル範囲
// ---------------------------------------------------------------------

// スキルが届くマス（相手がいなくても範囲表示に使う）
function skillArea(state, x, y, skill) {
  const board = state.board, u = board[y][x], res = [];
  if (!skill.range) return res; // 向きで選ぶスキル（黒刀・貫通・フックなど）は射程の表示なし
  if (skill.range.type === 'artemis') return artemisArea(state, u.color);
  if (skill.kind === 'rotate') {
    return ORTHO.filter(d => !(d[0] === u.facing[0] && d[1] === u.facing[1]))
      .map(([dx, dy]) => [x + dx, y + dy]).filter(([nx, ny]) => inBounds(board, nx, ny));
  }
  if (skill.range.type === 'camp') {
    for (let ty = 0; ty < boardHeight(board); ty++)
      for (let tx = 0; tx < boardWidth(board); tx++)
        if (isCampOf(u.color, tx, ty)) res.push([tx, ty]);
    return res;
  }
  if (skill.range.type === 'territory') {
    for (let ty = 0; ty < boardHeight(board); ty++)
      for (let tx = 0; tx < boardWidth(board); tx++)
        if (state.territory[ty][tx] === u.color) res.push([tx, ty]);
    return res;
  }
  if (skill.range.type === 'pattern') {
    tracePattern(board, x, y, u, UNITS[u.type].move.moves, (nx, ny) => res.push([nx, ny]));
    return res;
  }
  // 監視塔の近くなら遠距離の射程 +1
  const max = skill.range.max + (skill.range.max >= 2 && u ? towerRangeBonus(state, u, x, y) : 0);
  for (let ty = 0; ty < boardHeight(board); ty++)
    for (let tx = 0; tx < boardWidth(board); tx++) {
      const d = chebyshev(x, y, tx, ty);
      if (d >= skill.range.min && d <= max) res.push([tx, ty]);
    }
  return res;
}

// 範囲効果（aoe）が及ぶマス
function aoeSquares(state, tx, ty, skill) {
  const res = [];
  for (let y = ty - skill.aoe; y <= ty + skill.aoe; y++)
    for (let x = tx - skill.aoe; x <= tx + skill.aoe; x++)
      if (inBounds(state.board, x, y)) res.push([x, y]);
  return res;
}

// ドラゴンチャージ：自分から dir の方向へ奥行き depth・幅 width のマス
function pushArea(state, x, y, [dx, dy], skill) {
  const res = [], half = (skill.width - 1) / 2, [px, py] = [-dy, dx]; // px, py は横方向
  for (let k = 1; k <= skill.depth; k++)
    for (let l = -half; l <= half; l++) {
      const nx = x + dx * k + px * l, ny = y + dy * k + py * l;
      if (inBounds(state.board, nx, ny)) res.push([nx, ny]);
    }
  return res;
}

// 弾（魔力・矢など）が足りているか
function hasAmmoFor(u, skill) { return !skill.ammoCost || u.ammo >= skill.ammoCost; }

function isFriendlySkill(skill) { return skill.kind === 'heal' || skill.kind === 'buff' || skill.kind === 'cleanse'; }

// ---------------------------------------------------------------------
//  見え方（透明）・射線・防壁
// ---------------------------------------------------------------------
function hasBuff(u, stat) { return u.buffs.some(b => b.stat === stat); }
function isSnared(u) { return hasBuff(u, 'snare'); }

// viewer 側から見えないキャラか（相手の透明キャラ）
function isHiddenFrom(u, viewer) { return u.color !== viewer && hasBuff(u, 'stealth'); }

// (ax, ay) と (bx, by) の間にあるマス（両端は含まない）
function squaresBetween(ax, ay, bx, by) {
  const res = [], seen = new Set([ax + ',' + ay, bx + ',' + by]);
  const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 4;
  for (let i = 1; i < n; i++) {
    const x = Math.round(ax + (bx - ax) * i / n), y = Math.round(ay + (by - ay) * i / n);
    const k = x + ',' + y;
    if (!seen.has(k)) { seen.add(k); res.push([x, y]); }
  }
  return res;
}

// 射線が通っているか（間に誰もいない）
function hasLineOfSight(state, ax, ay, bx, by) {
  return squaresBetween(ax, ay, bx, by).every(([x, y]) => !state.board[y][x]);
}

// 旗の9マスの外周（壁・城の線）
function barrierSides(b) {
  const l = b.x - 1.5, r = b.x + 1.5, t = b.y - 1.5, d = b.y + 1.5;
  return [[l, t, r, t], [r, t, r, d], [l, d, r, d], [l, t, l, d]];
}
// attackerColor から見て、射線をふさぐ相手の旗（壁か城が残っているもの）。なければ null
function fortBetween(state, attackerColor, ax, ay, tx, ty) {
  return (state.flags || []).find(f => f.color !== attackerColor && (f.wall || f.castle) &&
    barrierSides(f).some(seg => segmentsCross(ax, ay, tx, ty, seg))) || null;
}

// ---------------------------------------------------------------------
//  旗と城
// ---------------------------------------------------------------------
let nextFlagId = 1;

// (x, y) を9マスに含む旗（color を指定するとその側の旗だけ）
function flagAt(state, x, y, color) {
  return (state.flags || []).find(f => chebyshev(f.x, f.y, x, y) <= 1 && (!color || f.color === color)) || null;
}

function plantFlag(s, color, x, y, wallHits) {
  if (s.scorched[y][x]) return; // 破壊エリアには旗を立てられない
  const old = s.flags.find(f => f.x === x && f.y === y);
  if (old) { old.color = color; old.wall = wallHits || true; return; }
  s.flags.push({ id: 'f' + nextFlagId++, color, x, y, wall: wallHits || true, castle: null, build: null });
}

function isBuilding(u) { return hasBuff(u, 'building') || hasBuff(u, 'fortbuild'); } // fortbuild は陣取りルーク（無防備ではない）

// このキャラが今できる築城・修理（メニューに並ぶ）
function fortActions(state, x, y) {
  const u = state.board[y][x];
  if (!u || !canUseSkill(state, x, y) || isBuilding(u)) return [];
  const f = flagAt(state, x, y, u.color);
  if (!f || f.build) return [];
  const res = [];
  const next = FORT.levels[f.castle ? f.castle.level : 0];
  if (next) {
    const self = UNITS[u.type].plantsFlag;
    res.push({ kind: 'build', label: self ? `築城：${next.name}（${FORT.rookBuildTurns}ターン）` : `築城：${next.name}（${next.buildTurns}ターン無防備）` });
  }
  for (const o of castleWallOptions(state, f))
    res.push({ kind: 'wall', other: o.other.id, label: `城壁：${squareName(state.board, o.other.x, o.other.y)}の砦まで（${o.turns}ターン）` });
  if (f.castle && f.castle.repairs > 0 && f.castle.hp < f.castle.maxHp)
    res.push({ kind: 'repair', label: `修理 +${FORT.repairAmount}（残り${f.castle.repairs}回）` });
  return res;
}

// 築城を始める：建て終わるまでそのキャラは動けず、受けるダメージ2倍
function performBuild(state, from) {
  const s = cloneState(state);
  s.effects = [];
  const [x, y] = from, u = s.board[y][x];
  const f = flagAt(s, x, y, u.color);
  const next = FORT.levels[f.castle ? f.castle.level : 0];
  beginAction(s, u);
  u.acted = true;
  const self = UNITS[u.type].plantsFlag; // 陣取りルーク自身なら早くて無防備にならない
  const turns = self ? FORT.rookBuildTurns : next.buildTurns;
  f.build = { builderId: u.id, turnsLeft: turns, level: next.level };
  u.buffs.push(self ? { stat: 'fortbuild', turns: 999, label: '砦を建設中（動けない・無防備ではない）', debuff: false }
    : { stat: 'building', turns: 999, label: `築城中（無防備：ダメージ${FORT.defenselessRate}倍）`, debuff: false });
  s.effects.push({ x, y, text: '築城開始', kind: 'buff' });
  s.log.push({ color: u.color, text: `${unitLabel(s.board, u, x, y)} が${next.name}を建て始めた（${turns}ターン${self ? '' : '、そのあいだ無防備'}）` });
  return finishAction(s);
}

function performRepair(state, from) {
  const s = cloneState(state);
  s.effects = [];
  const [x, y] = from, u = s.board[y][x];
  const f = flagAt(s, x, y, u.color);
  beginAction(s, u);
  u.acted = true;
  const add = Math.min(FORT.repairAmount, f.castle.maxHp - f.castle.hp);
  f.castle.hp += add;
  f.castle.repairs--;
  s.effects.push({ x: f.x, y: f.y, text: '修理 +' + add, kind: 'heal' });
  s.log.push({ color: u.color, text: `${unitLabel(s.board, u, x, y)} が${f.castle.name}を修理（HP ${f.castle.hp}/${f.castle.maxHp}・残り${f.castle.repairs}回）` });
  return finishAction(s);
}

// 自分のターンの始め：築城の進み・補給路からの材料・旗の奪取
function fortTurnStart(s, color) {
  for (const f of s.flags) {
    // 築城の進み
    if (f.color === color && f.build) {
      let builder = null, bx = 0, by = 0;
      forEachUnit(s, (u, x, y) => { if (u.id === f.build.builderId) { builder = u; bx = x; by = y; } });
      if (!builder) { f.build = null; continue; } // 建てていたキャラが倒された
      f.build.turnsLeft--;
      if (f.build.turnsLeft <= 0) {
        const lv = FORT.levels[f.build.level - 1];
        const hp = builder.type === 'T' && builder.evolved ? 15 : lv.hp; // 築城王なら HP 15
        f.castle = { level: lv.level, name: lv.name, hp, maxHp: hp, repairs: lv.repairs };
        f.build = null;
        builder.buffs = builder.buffs.filter(b => b.stat !== 'building' && b.stat !== 'fortbuild');
        s.effects.push({ x: f.x, y: f.y, text: lv.name + '完成！', kind: 'supply' });
        s.log.push({ color, text: `${COLOR_NAME[color]}の${lv.name}が完成（HP ${lv.hp}・修理${lv.repairs}回）` });
      }
    }
    // 補給路が9マスに届いていれば修理の材料が増える
    if (f.color === color && f.castle) {
      let supplied = false;
      for (let y = f.y - 1; y <= f.y + 1; y++)
        for (let x = f.x - 1; x <= f.x + 1; x++)
          if (inBounds(s.board, x, y) && s.supply[y][x] === color) supplied = true;
      if (supplied && f.castle.repairs < FORT.maxRepairs) f.castle.repairs = Math.min(FORT.maxRepairs, f.castle.repairs + FORT.supplyRepairBonus);
    }
    // 奪取：相手の旗の9マスに自分のキャラだけがいる
    if (f.color !== color) {
      let mine = 0, theirs = 0;
      forEachUnit(s, (u, x, y) => {
        if (chebyshev(f.x, f.y, x, y) > 1) return;
        if (u.color === color) mine++; else theirs++;
      });
      if (mine && !theirs) {
        f.color = color;
        f.wall = true; // 壊れた壁は元に戻る
        f.build = null;
        for (let y = f.y - 1; y <= f.y + 1; y++)
          for (let x = f.x - 1; x <= f.x + 1; x++) claimSquare(s, color, x, y);
        s.effects.push({ x: f.x, y: f.y, text: '奪取！', kind: 'supply' });
        s.log.push({ color, text: `${COLOR_NAME[color]}が ${squareName(s.board, f.x, f.y)} の旗を奪った` + (f.castle ? `（${f.castle.name}ごと）` : '') });
      }
    }
  }
}

// 単体攻撃の届く相手か（透明・遠距離無効・シールド・射線を確認）
function canHitTarget(state, u, x, y, tx, ty, skill, allowAlly) {
  const t = state.board[ty][tx];
  if (!t || (t.color === u.color && !allowAlly) || isHiddenFrom(t, u.color)) return false;
  if (t.color === u.color) { // 味方：遠くからは射線が必要、遠距離無効の味方は撃てない
    const farAlly = chebyshev(x, y, tx, ty) >= RULES.shieldMinRange;
    if (farAlly && (hasBuff(t, 'immune') || UNITS[t.type].rangedImmune)) return false;
    return !(farAlly && skill.range && skill.range.type === 'area' && !hasLineOfSight(state, x, y, tx, ty));
  }
  const far = chebyshev(x, y, tx, ty) >= RULES.shieldMinRange;
  if (far && (hasBuff(t, 'immune') || UNITS[t.type].rangedImmune)) return false;
  if (isWarded(state, u.color, tx, ty)) return false;
  if (isShielded(state, u, x, y, tx, ty)) return false;
  // 2マス以上離れた弓・魔法は射線が必要（チェス式の線攻撃は最初にぶつかった相手だけなので不要）
  if (far && skill.range && skill.range.type === 'area' && !hasLineOfSight(state, x, y, tx, ty)) return false;
  return true;
}

// 一直線のマス（貫通・フック用）
function lineSquares(state, x, y, [dx, dy], length) {
  const res = [];
  for (let k = 1; k <= length; k++) {
    const nx = x + dx * k, ny = y + dy * k;
    if (!inBounds(state.board, nx, ny)) break;
    res.push([nx, ny]);
  }
  return res;
}

// フックが最初に当たるキャラ（2マス以上先のみ。すぐ隣はもう目の前なので引けない）
function hookTarget(state, x, y, dir, length) {
  for (const [nx, ny] of lineSquares(state, x, y, dir, length)) {
    if (state.board[ny][nx]) return chebyshev(x, y, nx, ny) >= 2 && !UNITS[state.board[ny][nx].type].immobile ? [nx, ny] : null;
  }
  return null;
}

function pendingDescent(state, color) { return (state.descents || []).find(d => d.color === color); }

// 透明のキャラが見つかる：相手の陣営に入った・相手のアラートの9マスに入った
function revealCheck(s) {
  forEachUnit(s, (u, x, y) => {
    if (!hasBuff(u, 'stealth')) return;
    const inCamp = isEnemyCamp(u.color, x, y);
    const inAlert = (s.alerts || []).some(a => a.color !== u.color && chebyshev(a.x, a.y, x, y) <= 1) || watchedBy(s, opposite(u.color), x, y);
    if (inCamp || inAlert) {
      u.buffs = u.buffs.filter(b => b.stat !== 'stealth');
      s.effects.push({ x, y, text: '発見！', kind: 'damage' });
      s.log.push({ color: null, text: `${unitLabel(s.board, u, x, y)} が${inCamp ? '陣営に入って' : 'アラートで'}見つかった` });
    }
  });
}

function skillTargets(state, x, y, skill) {
  const u = state.board[y][x];
  skill = effSkill(u, skill);
  if (!hasAmmoFor(u, skill)) return [];
  if ((u.cooldowns || {})[skill.cooldownGroup || skill.name] > 0) return [];
  if (skill.pointCost && (state.points || {})[u.color] < skill.pointCost) return [];
  if (skill.requiresFacility === 'artemis' && !findOwnStructure(state, u.color, 'artemisCannon')) return [];
  const extra = specialTargets(state, x, y, skill);
  if (extra) return extra;
  const repeatable = skill.kind === 'squad' || skill.kind === 'descentPoint';
  const freeLimit = u.evolved && u.type === 'E' && skill.kind === 'spawn' ? 2 : 1; // 女王蜂は2回
  if (skill.free && !repeatable && (u.freeUsed || 0) >= freeLimit) return []; // タダのスキルは1ターン1回
  if (skill.kind === 'rotate') return skillArea(state, x, y, skill);
  if (skill.kind === 'push') {
    // 向きは隣のマスで選ぶ。範囲に敵が1体以上いる向きだけ
    return ORTHO.filter(d => pushArea(state, x, y, d, skill).some(([ax, ay]) => {
      const t = state.board[ay][ax];
      return t && t.color !== u.color && !isHiddenFrom(t, u.color);
    })).map(([dx, dy]) => [x + dx, y + dy]).filter(([nx, ny]) => inBounds(state.board, nx, ny));
  }
  if (skill.kind === 'pierce') {
    // 8方向のどれか。射線上に見えている敵が1体以上いる向きだけ
    return ALL8.filter(d => lineSquares(state, x, y, d, skill.length).some(([ax, ay]) => {
      const t = state.board[ay][ax];
      return t && t.color !== u.color && !isHiddenFrom(t, u.color);
    })).map(([dx, dy]) => [x + dx, y + dy]);
  }
  if (skill.kind === 'hook') {
    return ORTHO.filter(d => hookTarget(state, x, y, d, skill.length))
      .map(([dx, dy]) => [x + dx, y + dy]);
  }
  if (skill.kind === 'trap') {
    const traps = state.traps || [];
    return skillArea(state, x, y, skill).filter(([tx, ty]) => !state.board[ty][tx] && !state.scorched[ty][tx] && !traps.some(t => t.x === tx && t.y === ty));
  }
  if (skill.kind === 'alert') return skillArea(state, x, y, skill);
  if (skill.kind === 'stealth') return hasBuff(u, 'stealth') ? [] : [[x, y]];
  if (skill.kind === 'spawn') return skillArea(state, x, y, skill).filter(([tx, ty]) => !state.board[ty][tx]);
  if (skill.kind === 'squad') {
    // 部隊に入れられる虫（もう入っている虫を選ぶと外す）
    return skillArea(state, x, y, skill).filter(([tx, ty]) => {
      const t = state.board[ty][tx];
      if (!t || t.color !== u.color || !UNITS[t.type].bug || UNITS[t.type].squadMax) return false;
      return u.squad.includes(t.id) || u.squad.length < UNITS[u.type].squadMax;
    });
  }
  if (skill.kind === 'formation') return formationAnchors(state, u.color, skill.shape); // まず基準を選ぶ
  if (skill.kind === 'charge') return pendingDescent(state, u.color) ? [] : [[x, y]];
  if (skill.kind === 'descentPoint') return pendingDescent(state, u.color) ? skillArea(state, x, y, skill) : [];
  if (skill.kind === 'warp') {
    const mine = state.warps[u.color];
    return skillArea(state, x, y, skill).filter(([tx, ty]) => !state.scorched[ty][tx] && !mine.some(w => w[0] === tx && w[1] === ty));
  }
  // 誰もいないマスも狙えるスキル（範囲魔法）
  if (skill.targetSquare) {
    return skillArea(state, x, y, skill).filter(([tx, ty]) => !(skill.notEnemyCamp && isEnemyCamp(u.color, tx, ty)));
  }
  const list = skillArea(state, x, y, skill).filter(([tx, ty]) => {
    const t = state.board[ty][tx];
    if (!t) return false;
    if (skill.kind === 'cleanse') return t.color === u.color && t.buffs.some(b => b.debuff);
    if (isFriendlySkill(skill)) return t.color === u.color;
    return canHitTarget(state, u, x, y, tx, ty, skill, skill.kind === 'damage'); // 通常攻撃は味方にも撃てる
  });
  // 挑発ルーク：近くにいる敵は、単体攻撃をこのルークにしか向けられない（届くなら）
  if (skill.kind === 'damage' && skill.aoe == null && !skill.targetSquare) {
    const taunters = list.filter(([tx, ty]) => {
      const t = state.board[ty][tx], d = tauntOf(t);
      return d && t.color !== u.color && chebyshev(x, y, tx, ty) <= d;
    });
    if (taunters.length) return taunters;
  }
  return list;
}

// ---------------------------------------------------------------------
//  行動（すべて新しい state を返す）
// ---------------------------------------------------------------------
function unitName(u) { return u.evolved && EVOLUTIONS[u.type] ? EVOLUTIONS[u.type].name : UNITS[u.type].name; } // 進化したら名前が変わる
function unitLabel(board, u, x, y) {
  return `${COLOR_NAME[u.color]}の${unitName(u)}(${squareName(board, x, y)})`;
}

function beginAction(s, u) {
  if (!hasStarted(u) && !UNITS[u.type].freeActor && !u.freeAction) s.actionsLeft--;
}

// 移動したあとの攻撃は弱くなる（RULES.movedAttackRate 倍）
function movedDamage(u, dmg) {
  return u.moved ? Math.max(1, Math.round(dmg * RULES.movedAttackRate)) : dmg;
}

// 遠距離（2マス以上）からの攻撃への守り：陣形移動は無効、ファランクスは半分
function finalDamage(t, ax, ay, x, y, dmg) {
  if (hasBuff(t, 'building')) dmg *= FORT.defenselessRate; // 築城中は無防備
  if (t.evolved && t.type === 'taunter') dmg = Math.max(0, dmg - 1); // 不動の要塞
  if (chebyshev(ax, ay, x, y) < RULES.shieldMinRange) return dmg;
  if (hasBuff(t, 'immune') || UNITS[t.type].rangedImmune) return 0;
  if (hasBuff(t, 'guard')) return Math.max(1, Math.floor(dmg / 2));
  return dmg;
}

// 敵を倒したとき：倒したキャラが進化（回復して強くなる）。虫が倒したらマザーの MP が増える
function onKill(s, killer, kx, ky) {
  const def = UNITS[killer.type], parts = [];
  if (EVOLUTIONS[killer.type] && EVOLUTIONS[killer.type].by === 'kill') { const t = evolveUnit(s, killer, kx, ky); if (t) parts.push(t); }
  const g = def.growth;
  if (g && killer.evo < g.max) {
    killer.evo++;
    killer.atkBonus += g.atk;
    killer.maxHp += g.maxHp;
    killer.hp = Math.min(killer.maxHp, killer.hp + g.heal);
    s.effects.push({ x: kx, y: ky, text: '進化！', kind: 'supply' });
    parts.push(`${def.name} が進化（攻撃+${g.atk}・最大HP+${g.maxHp}・HP+${g.heal}）`);
  }
  if (def.bug) {
    forEachUnit(s, m => {
      const mdef = UNITS[m.type];
      if (m.color !== killer.color || !mdef.mother) return;
      const add = Math.min(m.evolved ? 5 : mdef.mother.mpPerKill, m.ammoMax - m.ammo);
      m.ammo += add;
      if (add) parts.push(`${mdef.name} の MP +${add}`);
    });
  }
  return parts;
}

// ダメージを与える（倒したら盤から消して、進化などを処理）。ログ用の文章を返す
function dealDamage(s, attacker, ax, ay, x, y, dmg) {
  const t = s.board[y][x];
  const whom = unitLabel(s.board, t, x, y);
  if (dmg <= 0) return [`${whom} には効かない`];
  s.lastCombatRound = s.round;
  t.hp -= dmg;
  s.effects.push({ x, y, text: '-' + dmg, kind: 'damage' });
  const parts = [`${whom} に ${dmg} ダメージ`];
  if (t.hp <= 0) {
    s.board[y][x] = null;
    addGrave(s, t);
    parts.push(`${whom} を倒した！`);
    if (UNITS[t.type].royal) { s.winner = attacker.color; s.winReason = 'king'; }
    parts.push(...onKill(s, attacker, ax, ay));
    if (UNITS[t.type].respawn) queueRespawn(s, t);
    const conv = UNITS[attacker.type].convertsKills;
    if (conv && !s.winner && !UNITS[t.type].respawn) {
      const dk = makeUnit(conv, attacker.color);
      dk.moved = dk.acted = true;
      s.board[y][x] = dk;
      parts.push(`${UNITS[conv].name}に変えた`);
    }
  }
  return parts.filter(Boolean);
}

// 反撃：攻撃されたキャラが生きていて、相手が自分の射程にいて弾が足りていれば殴り返す（反撃への反撃はない）
function counterAttack(s, def, dx, dy, att, ax, ay) {
  if (!RULES.counter || s.winner || isSnared(def) || isBuilding(def) || hasBuff(def, 'nocounter')) return []; // 罠・築城中・反撃封じ
  if (s.board[dy][dx] !== def || s.board[ay][ax] !== att) return [];
  if (def.color === att.color) return []; // 味方からの攻撃には反撃しない
  for (const sk of UNITS[def.type].skills) {
    if (sk.kind !== 'damage' || sk.aoe != null || sk.targetSquare) continue;
    if (!skillTargets(s, dx, dy, sk).some(p => p[0] === ax && p[1] === ay)) continue;
    if (sk.ammoCost) def.ammo -= sk.ammoCost;
    const dmg = finalDamage(att, dx, dy, ax, ay, sk.power ?? effectiveAtk(def));
    return [`反撃！${UNITS[def.type].name}の${sk.name}`, ...dealDamage(s, def, dx, dy, ax, ay, dmg)];
  }
  return [];
}

// 移動の共通処理：path は通るマス（最後が到着マス）。warpTo があればゲートを通ってそこに出る
function moveAlong(state, from, path, cost, makesRoute, warpTo) {
  const s = cloneState(state);
  s.effects = [];
  const [fx, fy] = from;
  const u = s.board[fy][fx], def = UNITS[u.type];
  // 相手の罠を踏んだら、そこで止まる
  const ti = path.findIndex(([x, y]) => !s.board[y][x] && (s.traps || []).some(t => t.color !== u.color && t.x === x && t.y === y));
  const walk = ti >= 0 ? path.slice(0, ti + 1) : path;
  const [tx, ty] = ti >= 0 ? walk[walk.length - 1] : (warpTo || walk[walk.length - 1]);
  let text = `${unitLabel(s.board, u, fx, fy)} → ${squareName(s.board, tx, ty)} に移動（移動HP -${cost}）`;
  if (warpTo && ti < 0) text += '、ワープゲートを通った';
  beginAction(s, u);
  u.moved = true;
  u.hitRunPending = false;
  u.moveHp -= cost;
  s.board[fy][fx] = null;
  s.board[ty][tx] = u;
  s.lastAction = { from, to: [tx, ty] };

  if (breakSupply(s, u, walk)) text += '、敵の補給路を破壊';
  if (makesRoute) {
    for (const [x, y] of walk) if (!s.scorched[y][x]) s.supply[y][x] = u.color;
    if (u.evolved && u.type === 'L') { // 兵站将軍：歩いたマスの左右にも敷く
      let px = fx, py = fy;
      for (const [x, y] of walk) {
        const dx = x - px, dy = y - py;
        for (const [sx, sy] of [[x - dy, y + dx], [x + dy, y - dx]])
          if (inBounds(s.board, sx, sy) && !s.scorched[sy][sx]) s.supply[sy][sx] = u.color;
        px = x; py = y;
      }
    }
    text += `、補給路 +${walk.length}`;
  } else {
    text += applySupply(s, u, tx, ty);
  }
  if (def.claimsTerritory) {
    text += `、陣地 +${claimTerritory(s, u.color, [], [tx, ty])}`; // 通った道は陣地にしない（止まった9マスだけ）
    if (def.plantsFlag) {
      plantFlag(s, u.color, tx, ty, u.evolved ? 2 : true);
      text += '、旗を立てた';
    }
  }
  if (u.squad.length) text += moveSquad(s, u, tx - fx, ty - fy);
  if (ti >= 0) {
    s.traps = s.traps.filter(t => !(t.x === tx && t.y === ty));
    u.buffs = u.buffs.filter(b => b.stat !== 'snare');
    u.buffs.push({ stat: 'snare', turns: 2, label: '罠：動けない・反撃できない', debuff: true });
    s.effects.push({ x: tx, y: ty, text: '罠！', kind: 'damage' });
    text += '、罠にかかった！（1ターン動けない・反撃できない）';
  }
  s.log.push({ color: u.color, text });
  return finishAction(s);
}

// 隊長虫の部隊：隊長と同じだけずれて一緒に動く（行き先がふさがっている虫はその場に残る）
function moveSquad(s, captain, dx, dy) {
  const members = [];
  forEachUnit(s, (m, x, y) => { if (captain.squad.includes(m.id)) members.push([m, x, y]); });
  captain.squad = members.map(([m]) => m.id); // 倒された虫は部隊から外す
  members.forEach(([m, x, y]) => { s.board[y][x] = null; });
  let moved = 0;
  for (const [m, x, y] of members) {
    const nx = x + dx, ny = y + dy;
    if (inBounds(s.board, nx, ny) && !s.board[ny][nx]) { s.board[ny][nx] = m; moved++; }
    else s.board[y][x] = m;
  }
  return moved ? `、部隊の虫 ${moved} 匹も一緒に移動` : '';
}

function performMove(state, from, to) {
  const t = moveTargets(state, from[0], from[1]).find(p => p[0] === to[0] && p[1] === to[1]);
  return moveAlong(state, from, t[3], t[2], false, t[4]);
}

// 補給ナイト：決めた道を進んで補給路を作る
function performRoute(state, from, path) {
  const u = state.board[from[1]][from[0]];
  return moveAlong(state, from, path, routeCost(state, u, path), true);
}

const ATTACK_KINDS = ['damage', 'push', 'pierce', 'hook'];

function performSkill(state, from, target, skillIndex) {
  const s = cloneState(state);
  s.effects = [];
  const [fx, fy] = from, [tx, ty] = target;
  const u = s.board[fy][fx], def = UNITS[u.type], skill = effSkill(u, def.skills[skillIndex]);
  // 支援役はスキルを使った回数で進化
  if (EVOLUTIONS[u.type] && EVOLUTIONS[u.type].by === 'skill' && !u.evolved && !ATTACK_KINDS.includes(skill.kind)) {
    u.skillUses = (u.skillUses || 0) + 1;
    if (u.skillUses >= EVOLVE.skillUses) s.log.push({ color: u.color, text: evolveUnit(s, u, fx, fy) });
  }
  const who = unitLabel(s.board, u, fx, fy);
  const repeatable = skill.kind === 'squad' || skill.kind === 'descentPoint';
  if (skill.free) {
    // タダのスキル：行動回数を使わず、このキャラの行動も終わらない
    if (!repeatable) u.freeUsed = (u.freeUsed || 0) + 1;
  } else {
    beginAction(s, u);
    u.acted = true;
    // ヒット＆アウェイ：攻撃のあと、もう一度動ける
    if (def.hitAndRun && ATTACK_KINDS.includes(skill.kind)) u.hitRunPending = true;
  }
  if (skill.ammoCost) u.ammo -= skill.ammoCost;
  if (skill.pointCost) s.points[u.color] -= skill.pointCost;
  if (skill.cooldown) u.cooldowns[skill.cooldownGroup || skill.name] = skill.cooldown;
  s.lastAction = { from, to: [tx, ty] };
  const special = performSpecial(s, u, def, skill, fx, fy, target, who);
  if (special) return special;
  // 攻撃すると透明が解ける
  if (ATTACK_KINDS.includes(skill.kind) && hasBuff(u, 'stealth')) {
    u.buffs = u.buffs.filter(b => b.stat !== 'stealth');
    s.log.push({ color: u.color, text: `${who} が攻撃して姿を現した` });
  }
  // 遠距離攻撃が相手の旗の外周を横切るなら：壁があれば壁が壊れて終わり、城があれば城が代わりにダメージを受ける
  const far = chebyshev(fx, fy, tx, ty) >= RULES.shieldMinRange;
  const guarded = (skill.kind === 'damage' && (far || skill.aoe != null)) || skill.kind === 'pierce';
  if (guarded) {
    const end = skill.kind === 'pierce'
      ? lineSquares(s, fx, fy, [tx - fx, ty - fy], skill.length).slice(-1)[0] : [tx, ty];
    const cw = castleWallBetween(s, u.color, fx, fy, end[0], end[1]);
    if (cw) {
      const dmg = movedDamage(u, skill.power ?? effectiveAtk(u));
      cw.hp -= dmg;
      let text = `${who} の${skill.name} → 城壁に防がれた（城壁に ${dmg} ダメージ、残り ${Math.max(0, cw.hp)}）`;
      if (cw.hp <= 0) { s.castleWalls.splice(s.castleWalls.indexOf(cw), 1); text += '、城壁が崩れた！'; }
      s.log.push({ color: u.color, text });
      return finishAction(s);
    }
    const f = fortBetween(s, u.color, fx, fy, end[0], end[1]);
    if (f) {
      if (f.wall) {
        f.wall = f.wall === 2 ? 1 : false; // 築城王の壁は2回まで
        s.effects.push({ x: f.x, y: f.y, text: '壁が壊れた', kind: 'damage' });
        s.log.push({ color: u.color, text: `${who} の${skill.name} → 旗の壁に防がれた（壁は壊れた）` });
      } else {
        const dmg = movedDamage(u, skill.power ?? effectiveAtk(u));
        f.castle.hp -= dmg;
        s.effects.push({ x: f.x, y: f.y, text: '-' + dmg, kind: 'damage' });
        let text = `${who} の${skill.name} → ${f.castle.name}に ${dmg} ダメージ（残り ${Math.max(0, f.castle.hp)}）`;
        if (f.castle.hp <= 0) { text += `、${f.castle.name}が崩れた！`; f.castle = null; }
        s.log.push({ color: u.color, text });
      }
      return finishAction(s);
    }
  }

  if (skill.kind === 'squad') {
    const t = s.board[ty][tx];
    const inSquad = u.squad.includes(t.id);
    u.squad = inSquad ? u.squad.filter(id => id !== t.id) : [...u.squad, t.id];
    s.log.push({ color: u.color, text: `${who} の部隊${inSquad ? 'から' : 'に'} ${UNITS[t.type].name}(${squareName(s.board, tx, ty)}) を${inSquad ? '外した' : '入れた'}（${u.squad.length}/${def.squadMax}）` });
    return s; // タダなのでターン交代の判定はしない
  }

  if (skill.kind === 'descentPoint') {
    pendingDescent(s, u.color).spot = [tx, ty];
    s.log.push({ color: u.color, text: `${who} がバハムートの降臨地点を ${squareName(s.board, tx, ty)} に決めた` });
    return s;
  }

  if (skill.kind === 'spawn') {
    const born = makeUnit(skill.unit, u.color);
    born.moved = born.acted = true; // 生まれたターンは動けない
    s.board[ty][tx] = born;
    s.effects.push({ x: tx, y: ty, text: '誕生！', kind: 'supply' });
    s.log.push({ color: u.color, text: `${who} が ${squareName(s.board, tx, ty)} に${UNITS[skill.unit].name}を産んだ` + (skill.free ? '（タダ）' : `（MP -${skill.ammoCost}）`) });
    return skill.free ? s : finishAction(s);
  }

  if (skill.kind === 'push') {
    // 奥行き5・幅3をなぎ払う：敵にはダメージ、生き残った全員（味方も）を奥行き pushTo の列まで押し出す
    const dir = [tx - fx, ty - fy];
    const area = pushArea(s, fx, fy, dir, skill);
    const parts = [];
    const power = movedDamage(u, skill.power ?? effectiveAtk(u)) + (skill.bonus || 0); // 竜騎士は+2
    for (const [x, y] of area) {
      const t = s.board[y][x];
      if (t && t.color !== u.color && !isWarded(s, u.color, x, y)) parts.push(...dealDamage(s, u, fx, fy, x, y, finalDamage(t, fx, fy, x, y, power)));
    }
    if (s.winner) {
      s.log.push({ color: u.color, text: `${who} の${skill.name} → ${parts.join('、')}` });
      s.log.push({ color: null, text: winText(s) });
      return s;
    }
    // 押し出し：レーン（横方向のずれ）ごとに、遠い順に奥行き pushTo から空きマスへ
    const [px, py] = [-dir[1], dir[0]];
    const pushed = area.map(([x, y]) => [x, y, s.board[y][x]]).filter(([, , t]) => t && !UNITS[t.type].immobile);
    pushed.forEach(([x, y]) => { s.board[y][x] = null; });
    const depthOf = (x, y) => (x - fx) * dir[0] + (y - fy) * dir[1];
    const laneOf = (x, y) => (x - fx) * px + (y - fy) * py;
    pushed.sort((a, b) => depthOf(b[0], b[1]) - depthOf(a[0], a[1]));
    let moved = 0;
    for (const [x, y, t] of pushed) {
      const lane = laneOf(x, y);
      const sqAt = (k) => [fx + dir[0] * k + px * lane, fy + dir[1] * k + py * lane];
      let placed = null;
      for (let k = skill.pushTo; ; k++) { // まず奥行き pushTo から奥へ
        const [nx, ny] = sqAt(k);
        if (!inBounds(s.board, nx, ny)) break;
        if (!s.board[ny][nx]) { placed = [nx, ny]; break; }
      }
      for (let k = skill.pushTo - 1; !placed && k >= 1; k--) { // 盤の端なら手前の空きマスへ
        const [nx, ny] = sqAt(k);
        if (inBounds(s.board, nx, ny) && !s.board[ny][nx]) placed = [nx, ny];
      }
      const [nx, ny] = placed || [x, y];
      s.board[ny][nx] = t;
      if (nx !== x || ny !== y) moved++;
    }
    parts.push(`${moved} 体を押し出した`);
    s.log.push({ color: u.color, text: `${who} の${skill.name} → ${parts.join('、')}` });
    return finishAction(s);
  }

  if (skill.kind === 'pierce') {
    // 一直線に貫通：射線上の敵全員にダメージ（味方は素通り）
    const dir = [tx - fx, ty - fy];
    const power = movedDamage(u, skill.power ?? effectiveAtk(u));
    const parts = [];
    for (const [x, y] of lineSquares(s, fx, fy, dir, skill.length)) {
      const t = s.board[y][x];
      if (!t || t.color === u.color || isShielded(s, u, fx, fy, x, y) || isWarded(s, u.color, x, y)) continue;
      parts.push(...dealDamage(s, u, fx, fy, x, y, finalDamage(t, fx, fy, x, y, power)));
      parts.push(...counterAttack(s, t, x, y, u, fx, fy));
      if (s.winner) break;
    }
    s.log.push({ color: u.color, text: `${who} の${skill.name} → ${parts.join('、') || '当たらなかった'}` });
    if (s.winner) s.log.push({ color: null, text: winText(s) });
    return finishAction(s);
  }

  if (skill.kind === 'hook') {
    // フック：最初に当たったキャラを自分の目の前へ引き寄せる
    const dir = [tx - fx, ty - fy];
    const hit = hookTarget(s, fx, fy, dir, skill.length);
    const t = s.board[hit[1]][hit[0]];
    const whom = unitLabel(s.board, t, hit[0], hit[1]);
    s.board[hit[1]][hit[0]] = null;
    s.board[ty][tx] = t;
    if (hasBuff(t, 'stealth') && t.color !== u.color) t.buffs = t.buffs.filter(b => b.stat !== 'stealth');
    s.effects.push({ x: tx, y: ty, text: '引き寄せ！', kind: 'buff' });
    s.log.push({ color: u.color, text: `${who} のフック → ${whom} を ${squareName(s.board, tx, ty)} に引き寄せた` });
    return finishAction(s);
  }

  if (skill.kind === 'trap') {
    s.traps = s.traps || [];
    s.traps.push({ color: u.color, x: tx, y: ty, ownerId: u.id });
    const mine = s.traps.filter(t => t.ownerId === u.id);
    if (mine.length > skill.maxTraps) s.traps.splice(s.traps.indexOf(mine[0]), 1); // 古い罠から消える
    s.log.push({ color: u.color, text: `${who} が罠を仕掛けた` }); // 場所はログに出さない
    return finishAction(s);
  }

  if (skill.kind === 'alert') {
    s.alerts = (s.alerts || []).filter(a => a.ownerId !== u.id);
    s.alerts.push({ color: u.color, x: tx, y: ty, ownerId: u.id });
    s.log.push({ color: u.color, text: `${who} がアラートを置いた` });
    return finishAction(s);
  }

  if (skill.kind === 'stealth') {
    u.buffs.push({ stat: 'stealth', turns: skill.turns, label: '透明（相手から見えない）', debuff: false });
    s.effects.push({ x: fx, y: fy, text: '透過', kind: 'buff' });
    s.log.push({ color: u.color, text: `${who} が姿を消した` });
    return finishAction(s);
  }

  if (skill.kind === 'charge') {
    const ch = u.evolved ? { ...def.charge, max: 2, descendTurns: 7 } : def.charge;
    u.charge++;
    let text = `${who} の${skill.name}（${u.charge}/${ch.max}）`;
    if (u.charge >= ch.max) {
      // 3回たまったら降臨の予約。8ターン後に降りてくる
      s.descents = s.descents || [];
      s.descents.push({ color: u.color, turns: ch.descendTurns, spot: null, unit: ch.unit });
      u.charge = 0;
      text += `、${ch.descendTurns}ターン後に${UNITS[ch.unit].name}が降臨する！`;
    }
    s.effects.push({ x: fx, y: fy, text: skill.name, kind: 'buff' });
    s.log.push({ color: u.color, text });
    return finishAction(s);
  }

  if (skill.kind === 'summon') {
    const born = makeUnit(skill.unit, u.color);
    born.moved = born.acted = true; // 呼ばれたターンは動けない
    s.board[ty][tx] = born;
    s.effects.push({ x: tx, y: ty, text: '召喚！', kind: 'supply' });
    s.log.push({ color: u.color, text: `${who} が ${squareName(s.board, tx, ty)} に${UNITS[skill.unit].name}を召喚した！` });
    return finishAction(s);
  }

  if (skill.kind === 'rotate') {
    u.facing = [tx - fx, ty - fy];
    s.log.push({ color: u.color, text: `${who} がシールドの向きを変えた` });
    return finishAction(s);
  }

  if (skill.kind === 'warp') {
    const mine = s.warps[u.color];
    mine.push([tx, ty]);
    if (mine.length > 2) mine.shift(); // 3つ目を置いたら一番古いものが消える
    s.log.push({ color: u.color, text: `${who} が ${squareName(s.board, tx, ty)} にワープ地点を置いた` });
    return finishAction(s);
  }

  // 効果が及ぶ相手（範囲効果なら周囲の全員）
  const cells = skill.aoe != null ? aoeSquares(s, tx, ty, skill) : [[tx, ty]];
  const affected = cells.filter(([x, y]) => {
    const t = s.board[y][x];
    if (!t) return false;
    if (isFriendlySkill(skill)) return t.color === u.color;
    if (t.color === u.color) return skill.kind === 'damage' && skill.aoe == null; // 単体攻撃なら味方にも当たる（範囲攻撃は今まで通り味方に当たらない）
    if (skill.notEnemyCamp && isEnemyCamp(u.color, x, y)) return false;
    if (isWarded(s, u.color, x, y)) return false; // 結界の中は攻撃できない
    return skill.aoe == null || !isShielded(s, u, fx, fy, x, y);
  });
  const power = skill.power ?? effectiveAtk(u);
  const parts = [];

  for (const [x, y] of affected) {
    const t = s.board[y][x];
    if (!t) continue; // 反撃で状況が変わった
    const whom = unitLabel(s.board, t, x, y);
    if (skill.kind === 'heal') {
      const amount = Math.min(power, t.maxHp - t.hp);
      t.hp += amount;
      if (amount) { s.effects.push({ x, y, text: '+' + amount, kind: 'heal' }); parts.push(`${whom} を ${amount} 回復`); }
    } else if (skill.kind === 'buff') {
      t.buffs = t.buffs.filter(b => b.stat !== skill.buff.stat || b.debuff); // 同じバフは上書き
      t.buffs.push({ ...skill.buff, label: `攻撃力 +${skill.buff.amount}`, debuff: false });
      s.effects.push({ x, y, text: '攻撃力↑', kind: 'buff' });
      parts.push(`${whom} の攻撃力 +${skill.buff.amount}（${skill.buff.turns}ターン）`);
    } else if (skill.kind === 'cleanse') {
      t.buffs = t.buffs.filter(b => !b.debuff);
      s.effects.push({ x, y, text: '浄化', kind: 'buff' });
      parts.push(`${whom} の弱体化を解除`);
    } else {
      // 二連撃などは同じ相手に何回か当てる
      const hit = Math.max(1, Math.round(movedDamage(u, power) * attackMult(u, t))); // 破城槌は建物に3倍・キャラに半分
      for (let h = 0; h < (skill.hits || 1) && s.board[y][x] === t; h++)
        parts.push(...dealDamage(s, u, fx, fy, x, y, finalDamage(t, fx, fy, x, y, hit)));
      parts.push(...counterAttack(s, t, x, y, u, fx, fy));
      if (s.winner) break;
    }
  }
  const note = u.moved && skill.kind === 'damage' && RULES.movedAttackRate < 1 ? '（移動後）' : '';
  s.log.push({ color: u.color, text: `${who} の${skill.name}${note} → ${parts.join('、') || '効果なし'}` });
  if (s.winner) s.log.push({ color: null, text: winText(s) });
  return finishAction(s);
}

function winText(s) {
  return `― ${COLOR_NAME[s.winner]}の勝ち！ ―`;
}

// 移動だけして行動を終える（移動後に攻撃しない・ヒット＆アウェイの2回目を使わない）
function performWait(state, from) {
  const s = cloneState(state);
  s.effects = [];
  const u = s.board[from[1]][from[0]];
  beginAction(s, u);
  u.acted = true;
  u.hitRunPending = false;
  return finishAction(s);
}

// 動かせる人数を使い切り、行動途中のキャラもいなければ自動でターン交代
function finishAction(s) {
  revealCheck(s);
  if (s.winner) return s;
  let pending = false;
  forEachUnit(s, u => {
    if (u.color !== s.turn) return;
    if (u.extraAction && hasStarted(u) && isDone(u)) refreshForExtra(u); // 時の加護：もう一度動ける
    if (u.freeAction && !hasStarted(u)) pending = true;
    if (hasStarted(u) && !isDone(u)) pending = true;
    if (UNITS[u.type].freeActor && !hasStarted(u) && canCommand(s, u)) pending = true; // デスナイトは行動回数と関係なく動ける
  });
  return s.actionsLeft <= 0 && !pending ? endTurn(s, true) : s;
}

// バハムート降臨：自分の陣営に降り、両軍の陣地・設置物・補給路をすべて壊す
function landDescent(s, d) {
  const H = boardHeight(s.board), W = boardWidth(s.board);
  const center = d.spot || [Math.floor(W / 2), d.color === 'w' ? H - 2 : 1];
  const spots = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (isCampOf(d.color, x, y) && !s.board[y][x]) spots.push([x, y]);
  if (!spots.length) return false; // 陣営が満員なら次のターンに持ち越し
  spots.sort((a, b) => chebyshev(a[0], a[1], center[0], center[1]) - chebyshev(b[0], b[1], center[0], center[1]));
  const [x, y] = spots[0];
  s.board[y][x] = makeUnit(d.unit, d.color);
  s.territory = initialTerritory();
  s.flags = [];
  s.warps = { w: [], b: [] };
  s.traps = [];
  s.alerts = [];
  s.supply = emptyGrid();
  s.effects.push({ x, y, text: '降臨！', kind: 'supply' });
  s.effects.push({ x, y, text: `${UNITS[d.unit].name}降臨！`, kind: 'banner' });
  s.log.push({ color: d.color, text: `${COLOR_NAME[d.color]}の${UNITS[d.unit].name}が ${squareName(s.board, x, y)} に降臨！ 両軍の陣地・設置物・補給路が消し飛んだ` });
  return true;
}

function endTurn(state, inPlace) {
  const s = inPlace ? state : cloneState(state);
  if (!inPlace) s.effects = [];
  s.turn = opposite(s.turn);
  s.actionsLeft = RULES.actionsPerTurn;
  if (s.turn === (s.first || 'w')) s.round++;
  s.points[s.turn] += RULES.points.perTurn;
  s.reinforced[s.turn] = false;
  forEachUnit(s, (u, x, y) => {
    u.moved = false;
    u.acted = false;
    u.hitRunPending = false;
    u.extraAction = false;
    u.freeAction = false;
    if (u.color !== s.turn) return;
    u.freeUsed = 0;
    const def = UNITS[u.type];
    // 蒼炎：燃えているあいだ毎ターンダメージ
    const burn = u.buffs.find(b => b.stat === 'burn');
    if (burn) {
      u.hp -= burn.amount;
      s.effects.push({ x, y, text: '-' + burn.amount, kind: 'damage' });
      if (u.hp <= 0) { killByEffect(s, u, x, y, null, '蒼炎で'); return; }
    }
    // クールダウンを減らす
    for (const k of Object.keys(u.cooldowns)) if (--u.cooldowns[k] <= 0) delete u.cooldowns[k];
    // バフの残りターンを減らす
    u.buffs = u.buffs.map(b => ({ ...b, turns: b.turns - 1 })).filter(b => b.turns > 0);
    // 最大MP がターンごとに増えるキャラ
    if (def.ammo && def.ammo.grow) u.ammoMax = Math.min(def.ammo.cap, u.ammoMax + def.ammo.grow);
    // ターン開始時の自然回復（HP・移動HP・弾）
    if (RULES.regenPerTurn > 0 && u.hp < u.maxHp) {
      const amount = Math.min(RULES.regenPerTurn, u.maxHp - u.hp);
      u.hp += amount;
      s.effects.push({ x, y, text: '+' + amount, kind: 'heal' });
    }
    u.moveHp = Math.min(def.moveHp, u.moveHp + (def.moveRegen ?? RULES.moveHpRegen));
    if (def.ammo) u.ammo = Math.min(u.ammoMax, u.ammo + def.ammo.regen);
    // 補給路（浮遊要塞の上も）にいると、HP・移動HP・MP・矢がさらに回復
    if (isSupplyFor(s, u.color, x, y)) applySupply(s, u, x, y);
  });
  processRespawns(s, s.turn);
  // 即死の呪い：呪われた側は1ターン生き残り、そのあいだに浄化できる。呪った側のターンが来たら死ぬ
  forEachUnit(s, (u, x, y) => {
    const doom = u.buffs.find(b => b.stat === 'doom');
    if (doom && doom.by === s.turn && !s.winner) killByEffect(s, u, x, y, doom.by, '即死の呪いで');
  });
  s.log.push({ color: null, text: `― ${COLOR_NAME[s.turn]}のターン（${s.round}巡目）―` });
  if (s.winner) { s.log.push({ color: null, text: winText(s) }); return s; }
  fortTurnStart(s, s.turn);
  specialTurnStart(s, s.turn);
  // 降臨のカウントダウン（自分のターンが来るたびに1減る）
  for (const d of [...(s.descents || [])]) {
    if (d.color !== s.turn) continue;
    d.turns--;
    if (d.turns <= 0 && landDescent(s, d)) s.descents.splice(s.descents.indexOf(d), 1);
  }
  return s;
}

// ---------------------------------------------------------------------
//  浮遊要塞（セミラミスの魔導国家）
// ---------------------------------------------------------------------
function fortRadius(f) { return f.radius || 1; }
function fortressAt(state, x, y) {
  return (state.fortresses || []).find(f => chebyshev(f.x, f.y, x, y) <= fortRadius(f)) || null;
}
function ownFortress(state, color) { return (state.fortresses || []).find(f => f.color === color) || null; }

// 補給路として扱うマスか（補給路そのもの、または自分の浮遊要塞の上）
function isSupplyFor(state, color, x, y) {
  if (state.supply[y][x] === color) return true;
  const f = fortressAt(state, x, y);
  return !!f && f.color === color;
}

// 要塞を1マス動かせるか（新しく乗るマスに、要塞の外のキャラがいたら動けない）
function canShiftFortress(state, f, [dx, dy]) {
  const r = fortRadius(f);
  for (let y = f.y + dy - r; y <= f.y + dy + r; y++)
    for (let x = f.x + dx - r; x <= f.x + dx + r; x++) {
      if (!inBounds(state.board, x, y)) return false;
      if (state.board[y][x] && chebyshev(f.x, f.y, x, y) > r) return false;
    }
  return true;
}

// 要塞を動かす。上に乗っているキャラ（敵味方とも）も一緒に動く
function shiftFortress(s, f, [dx, dy]) {
  const riders = [], r = fortRadius(f);
  for (let y = f.y - r; y <= f.y + r; y++)
    for (let x = f.x - r; x <= f.x + r; x++)
      if (inBounds(s.board, x, y) && s.board[y][x]) { riders.push([s.board[y][x], x, y]); s.board[y][x] = null; }
  for (const [r, x, y] of riders) s.board[y + dy][x + dx] = r;
  f.x += dx;
  f.y += dy;
}

// ---------------------------------------------------------------------
//  ポイントと増援
// ---------------------------------------------------------------------
function reinforceCost(type) { return UNITS[type].cost ?? RULES.points.reinforceCost; }
function reinforceTypes() { return Object.keys(UNITS).filter(t => UNITS[t].role === 'pawn' && !UNITS[t].noReinforce); }

// 増援を出せるマス：自分の陣地で、空いていて、破壊エリアでないところ
function reinforceSquares(state, color) {
  const res = [];
  for (let y = 0; y < boardHeight(state.board); y++)
    for (let x = 0; x < boardWidth(state.board); x++)
      if (state.territory[y][x] === color && !state.board[y][x] && !state.scorched[y][x]) res.push([x, y]);
  return res;
}

function canReinforce(state, type) {
  const c = state.turn;
  return !state.winner && !state.reinforced[c] && state.points[c] >= reinforceCost(type);
}

// 増援を出す（1ターン1回・行動回数は使わない・出たターンは動けない）
function performReinforce(state, type, x, y) {
  const s = cloneState(state);
  s.effects = [];
  const c = s.turn, cost = reinforceCost(type);
  s.points[c] -= cost;
  s.reinforced[c] = true;
  const u = makeUnit(type, c);
  u.moved = u.acted = true;
  s.board[y][x] = u;
  s.effects.push({ x, y, text: '増援！', kind: 'supply' });
  s.log.push({ color: c, text: `${COLOR_NAME[c]}が ${squareName(s.board, x, y)} に${UNITS[type].name}を増援（ポイント -${cost}）` });
  return s;
}

// ---------------------------------------------------------------------
//  特殊スキル
// ---------------------------------------------------------------------
function explosionRadius(mp) { return mp >= 20 ? 3 : mp >= 10 ? 2 : 1; }

// 即死の呪いが効く相手か（HP が最大の deathThreshold 以下）
function doomable(u, t) {
  return !hasBuff(t, 'doom') && !UNITS[t.type].immobile && t.hp <= t.maxHp * u.deathThreshold;
}

// 呪い・炎などで倒れる（攻撃したキャラがいない死に方）
function killByEffect(s, u, x, y, byColor, why) {
  s.board[y][x] = null;
  if (UNITS[u.type].respawn) queueRespawn(s, u);
  addGrave(s, u);
  s.effects.push({ x, y, text: '倒れた', kind: 'damage' });
  s.log.push({ color: byColor, text: `${unitLabel(s.board, u, x, y)} が${why}倒れた` });
  if (UNITS[u.type].royal) { s.winner = opposite(u.color); s.winReason = 'king'; return; }
  if (!byColor || UNITS[u.type].respawn) return;
  // オーバーロードの呪いで死んだら、デスナイトになる
  let conv = null;
  forEachUnit(s, m => { if (m.color === byColor && UNITS[m.type].convertsKills) conv = UNITS[m.type].convertsKills; });
  if (conv) {
    const dk = makeUnit(conv, byColor);
    dk.moved = dk.acted = true;
    s.board[y][x] = dk;
    s.log.push({ color: byColor, text: `${UNITS[conv].name}として蘇った` });
  }
}

// 設置物を壊す（罠・アラート・旗・ワープ・補給路）
function destroyPlacedThings(s, inArea) {
  s.traps = s.traps.filter(t => !inArea(t.x, t.y));
  s.alerts = s.alerts.filter(a => !inArea(a.x, a.y));
  s.flags = s.flags.filter(f => !inArea(f.x, f.y));
  for (const c of ['w', 'b']) s.warps[c] = s.warps[c].filter(w => !inArea(w[0], w[1]));
  for (let y = 0; y < boardHeight(s.board); y++)
    for (let x = 0; x < boardWidth(s.board); x++)
      if (inArea(x, y)) s.supply[y][x] = null;
  pruneSupply(s, 'w');
  pruneSupply(s, 'b');
}

// 新しい種類のスキルの対象（該当しなければ null）
function specialTargets(state, x, y, skill) {
  const u = state.board[y][x];
  switch (skill.kind) {
    case 'blueflame': // 近く（2マス以内）の旗・砦
      return (state.flags || []).filter(f => chebyshev(f.x, f.y, x, y) <= 2).map(f => [f.x, f.y]);
    case 'oneway': // まず中心を選ぶ（向きは画面で2回目に選ぶ）
      return skillArea(state, x, y, skill);
    case 'blackblade':
      return ORTHO.map(([dx, dy]) => [x + dx, y + dy]).filter(([nx, ny]) => inBounds(state.board, nx, ny));
    case 'transfer':
      if (!(u.ammo > 0)) return [];
      return skillArea(state, x, y, skill).filter(([tx, ty]) => {
        const t = state.board[ty][tx];
        return t && t !== u && t.color === u.color && t.ammo != null && t.ammo < t.ammoMax;
      });
    case 'explosion':
      return u.ammo >= skill.minMp ? skillArea(state, x, y, skill) : [];
    case 'doom':
      if (skill.aoe != null) return skillArea(state, x, y, skill);
      return skillArea(state, x, y, skill).filter(([tx, ty]) => {
        const t = state.board[ty][tx];
        return t && t.color !== u.color && !isHiddenFrom(t, u.color) && doomable(u, t);
      });
    case 'doomUp':
      return u.deathThreshold < UNITS[u.type].doom.max - 1e-9 ? [[x, y]] : [];
    case 'fortressBuild':
      return ownFortress(state, u.color) || state.fortressBuilds.some(b => b.color === u.color) ? [] : [[x, y]];
    case 'fortressMove': {
      const f = ownFortress(state, u.color);
      if (!f) return [];
      return ORTHO.filter(d => canShiftFortress(state, f, d)).map(([dx, dy]) => [f.x + dx, f.y + dy]);
    }
    case 'facility': {
      const f = ownFortress(state, u.color);
      if (!f || f.building) return [];
      const fac = skill.facility;
      if (fac === 'turret') return f.facilities.turret ? [] : [[x, y]];
      if (fac === 'expand') return fortRadius(f) < SKY.facilities.expand.maxRadius ? [[x, y]] : [];
      if (fac === 'artemis') { // 土台の外周の端（角と真ん中以外）の空きマス。砲は1つまで
        if (findOwnStructure(state, u.color, 'artemisCannon')) return [];
        return fortEdgeSquares(state, f).filter(([tx, ty]) => !state.board[ty][tx]);
      }
      if (fac === 'generator') { // 土台の空きマス（真ん中以外）
        const res = [], r = fortRadius(f);
        for (let ty = f.y - r; ty <= f.y + r; ty++)
          for (let tx = f.x - r; tx <= f.x + r; tx++)
            if (inBounds(state.board, tx, ty) && !state.board[ty][tx] && (tx !== f.x || ty !== f.y)) res.push([tx, ty]);
        return res;
      }
      return [];
    }
    case 'fortRepair': { // 土台の上の自分の建物で、削れていて修理回数が残っているもの
      const res = [];
      forEachUnit(state, (t, tx, ty) => {
        if (t.color === u.color && UNITS[t.type].structure && t.hp < t.maxHp && t.repairs > 0) res.push([tx, ty]);
      });
      return res;
    }
    default:
      return specialTargets2(state, x, y, skill);
  }
}

// 新しい種類のスキルの実行（該当しなければ null）
function performSpecial(s, u, def, skill, fx, fy, target, who) {
  const [tx, ty] = target;
  const log = (text) => s.log.push({ color: u.color, text: `${who} の${skill.name} → ${text}` });
  switch (skill.kind) {
    case 'blueflame': {
      const f = s.flags.find(f => f.x === tx && f.y === ty);
      let n = 0;
      forEachUnit(s, (t, x, y) => {
        if (chebyshev(f.x, f.y, x, y) > 1) return;
        t.buffs = t.buffs.filter(b => b.stat !== 'burn');
        t.buffs.push({ stat: 'burn', amount: skill.burn.amount, turns: skill.burn.turns, label: `蒼炎（毎ターン${skill.burn.amount}ダメージ）`, debuff: true });
        s.effects.push({ x, y, text: '蒼炎', kind: 'damage' });
        n++;
      });
      log(`${squareName(s.board, f.x, f.y)} の旗を青い炎が包んだ（中の ${n} 体が ${skill.burn.turns} ターン燃える）`);
      return finishAction(s);
    }
    case 'oneway': {
      const dir = [target[2], target[3]];
      s.oneways = s.oneways.filter(z => z.ownerId !== u.id);
      s.oneways.push({ x: tx, y: ty, dir, color: u.color, ownerId: u.id, turns: skill.duration });
      u.buffs.push({ stat: 'rooted', turns: skill.duration, label: '一方通行を維持中（動けない）', debuff: false });
      u.buffs.push({ stat: 'immune', turns: skill.duration, label: '遠距離攻撃無効', debuff: false });
      const arrow = { '0,-1': '↑', '0,1': '↓', '1,0': '→', '-1,0': '←' }[dir.join(',')];
      log(`${squareName(s.board, tx, ty)} の周り9マスを一方通行（${arrow}）にした（${skill.duration}ターン）`);
      return finishAction(s);
    }
    case 'blackblade': {
      const line = lineSquares(s, fx, fy, [tx - fx, ty - fy], skill.length);
      const inLine = (x, y) => line.some(p => p[0] === x && p[1] === y);
      for (const [x, y] of line) {
        s.scorched[y][x] = true;
        if (!isLockedSquare(x, y)) s.territory[y][x] = null;
        s.effects.push({ x, y, text: '黒刀', kind: 'damage' });
      }
      destroyPlacedThings(s, inLine);
      log(`${line.length} マスを切り裂き、破壊エリアにした`);
      return finishAction(s);
    }
    case 'transfer': {
      const t = s.board[ty][tx];
      const n = Math.min(skill.amount, u.ammo, t.ammoMax - t.ammo);
      u.ammo -= n;
      t.ammo += n;
      s.effects.push({ x: tx, y: ty, text: 'MP+' + n, kind: 'heal' });
      log(`${unitLabel(s.board, t, tx, ty)} に MP を ${n} 渡した`);
      return finishAction(s);
    }
    case 'explosion': {
      const mp = u.ammo, r = explosionRadius(mp);
      u.ammo = 0;
      const parts = [];
      for (let y = ty - r; y <= ty + r && !s.winner; y++)
        for (let x = tx - r; x <= tx + r && !s.winner; x++) {
          if (!inBounds(s.board, x, y)) continue;
          const t = s.board[y][x];
          if (t && t.color !== u.color && !isWarded(s, u.color, x, y)) parts.push(...dealDamage(s, u, fx, fy, x, y, finalDamage(t, fx, fy, x, y, mp)));
        }
      destroyPlacedThings(s, (x, y) => chebyshev(tx, ty, x, y) <= r);
      // 浮遊要塞にも当たる
      for (const f of [...s.fortresses]) {
        if (f.color === u.color || chebyshev(f.x, f.y, tx, ty) > r + 1) continue;
        f.hp -= mp;
        parts.push(`魔導国家に ${mp} ダメージ（残り ${Math.max(0, f.hp)}）`);
        if (f.hp <= 0) { s.fortresses.splice(s.fortresses.indexOf(f), 1); parts.push('魔導国家が墜落した！'); }
      }
      s.effects.push({ x: tx, y: ty, text: 'エクスプロージョン！', kind: 'damage' });
      log(`MP${mp}・範囲${2 * r + 1}×${2 * r + 1}：${parts.join('、') || '設置物を吹き飛ばした'}`);
      if (s.winner) s.log.push({ color: null, text: winText(s) });
      return finishAction(s);
    }
    case 'doom': {
      const cells = skill.aoe != null ? aoeSquares(s, tx, ty, skill) : [[tx, ty]];
      const hit = [];
      for (const [x, y] of cells) {
        const t = s.board[y][x];
        if (!t || t.color === u.color || !doomable(u, t)) continue;
        t.buffs.push({ stat: 'doom', turns: 99, label: '即死の呪い（相手の次のターンの始めに死ぬ・浄化で解ける）', debuff: true, by: u.color });
        s.effects.push({ x, y, text: '呪い', kind: 'damage' });
        hit.push(unitLabel(s.board, t, x, y));
      }
      log(hit.length ? `${hit.join('、')} に即死の呪い` : '呪いが効く相手がいなかった');
      return finishAction(s);
    }
    case 'doomUp': {
      u.deathThreshold = Math.min(def.doom.max, Math.round((u.deathThreshold + def.doom.step) * 100) / 100);
      log(`即死の呪いが HP ${Math.round(u.deathThreshold * 100)}% 以下の相手に効くようになった（ポイント -${skill.pointCost}）`);
      return s; // タダ（行動回数を使わない）
    }
    case 'fortressBuild': {
      s.fortressBuilds.push({ color: u.color, ownerId: u.id, turnsLeft: SKY.buildTurns });
      u.buffs.push({ stat: 'rooted', turns: 999, label: '魔導国家を建造中（動けない）', debuff: false });
      log(`魔導国家の建造を始めた（${SKY.buildTurns}ターン）`);
      return finishAction(s);
    }
    case 'fortressMove': {
      const f = ownFortress(s, u.color);
      shiftFortress(s, f, [tx - f.x, ty - f.y]);
      log('魔導国家をゆっくり動かした');
      return finishAction(s);
    }
    case 'facility': {
      const f = ownFortress(s, u.color), info = SKY.facilities[skill.facility];
      const turns = skill.facility === 'expand' ? info.turnsPer * ((f.expansions || 0) + 1) : info.turns; // 拡張は 2n ターン
      f.building = { facility: skill.facility, turnsLeft: turns, at: [tx, ty] };
      log(`${info.name}の建造を始めた（${turns}ターン${skill.facility === 'artemis' || skill.facility === 'generator' ? `、${squareName(s.board, tx, ty)}` : ''}）`);
      return finishAction(s);
    }
    case 'fortRepair': {
      const t = s.board[ty][tx];
      const add = Math.min(SKY.repairAmount, t.maxHp - t.hp);
      t.hp += add;
      t.repairs--;
      s.effects.push({ x: tx, y: ty, text: '修理 +' + add, kind: 'heal' });
      log(`${UNITS[t.type].name}を修理（HP ${t.hp}/${t.maxHp}・残り${t.repairs}回）`);
      return finishAction(s);
    }
  }
  return performSpecial2(s, u, def, skill, fx, fy, target, who);
}

// 自分のターンの始め：一方通行の残り・魔導国家と施設の建造・タレット
function specialTurnStart(s, color) {
  turnStart2(s, color);
  s.oneways = s.oneways.filter(z => z.color !== color || --z.turns > 0);
  for (const b of [...s.fortressBuilds]) {
    if (b.color !== color) continue;
    let owner = null, ox = 0, oy = 0;
    forEachUnit(s, (u, x, y) => { if (u.id === b.ownerId) { owner = u; ox = x; oy = y; } });
    if (!owner) { s.fortressBuilds.splice(s.fortressBuilds.indexOf(b), 1); continue; }
    if (--b.turnsLeft > 0) continue;
    s.fortressBuilds.splice(s.fortressBuilds.indexOf(b), 1);
    owner.buffs = owner.buffs.filter(x => x.stat !== 'rooted');
    s.fortresses.push({ color, x: ox, y: oy, hp: SKY.hp, maxHp: SKY.hp, facilities: {}, building: null });
    s.effects.push({ x: ox, y: oy, text: '魔導国家', kind: 'supply' });
    s.log.push({ color, text: `${COLOR_NAME[color]}の魔導国家が ${squareName(s.board, ox, oy)} に浮かび上がった` });
  }
  for (const f of s.fortresses) {
    if (f.color !== color) continue;
    if (f.building && --f.building.turnsLeft <= 0) {
      const fac = f.building.facility, info = SKY.facilities[fac];
      let done = true;
      if (fac === 'expand') { f.radius = fortRadius(f) + 1; f.expansions = (f.expansions || 0) + 1; }
      else if (info.unit) {
        const [bx, by] = f.building.at;
        if (s.board[by][bx]) { done = false; f.building.turnsLeft = 1; } // 置く場所にキャラがいたら、空くまで待つ
        else {
          const b = makeUnit(info.unit, color);
          if (fac === 'artemis') b.facing = [Math.sign(bx - f.x) * (Math.abs(bx - f.x) === fortRadius(f) ? 1 : 0), Math.sign(by - f.y) * (Math.abs(by - f.y) === fortRadius(f) ? 1 : 0)];
          s.board[by][bx] = b;
        }
      } else f.facilities[fac] = true;
      if (done) {
        s.log.push({ color, text: `${info.name}が完成した` + (fac === 'expand' ? `（土台が${2 * fortRadius(f) + 1}×${2 * fortRadius(f) + 1}に）` : '') });
        f.building = null;
      }
    }
    // エネルギー生成所：セミラミスの MP が増える
    const gens = [];
    forEachUnit(s, t => { if (t.color === color && t.type === 'generator') gens.push(t); });
    if (gens.length) forEachUnit(s, t => {
      if (t.color === color && UNITS[t.type].royal && t.ammo != null) t.ammo = Math.min(t.ammoMax, t.ammo + SKY.facilities.generator.mpPerTurn * gens.length);
    });
    if (f.facilities.turret && !s.winner) {
      // タレット：要塞から3マス以内の一番近い敵を撃つ
      const t = SKY.facilities.turret;
      let best = null;
      forEachUnit(s, (e, x, y) => {
        if (e.color === color || isHiddenFrom(e, color)) return;
        const d = chebyshev(f.x, f.y, x, y);
        if (d <= t.range && (!best || d < best[0])) best = [d, x, y];
      });
      if (best) {
        let shooter = null;
        forEachUnit(s, m => { if (m.color === color && UNITS[m.type].royal) shooter = m; });
        if (shooter) s.log.push({ color, text: `タレット → ${dealDamage(s, shooter, f.x, f.y, best[1], best[2], t.damage).join('、')}` });
      }
    }
  }
}

// ---------------------------------------------------------------------
//  王龍ゼノの復活
// ---------------------------------------------------------------------
function queueRespawn(s, u) {
  s.respawnCount[u.color]++;
  s.respawns.push({ color: u.color, type: u.type });
  s.log.push({ color: u.color, text: `${UNITS[u.type].name}は霊廟に還った…次の${COLOR_NAME[u.color]}のターンに蘇る` });
}

// 自分のターンの始め：霊廟のそばで復活（倒された回数だけ強くなる）
function processRespawns(s, color) {
  for (const r of [...s.respawns]) {
    if (r.color !== color) continue;
    let tomb = null;
    forEachUnit(s, (u, x, y) => { if (u.color === color && u.type === UNITS[r.type].mausoleum) tomb = [x, y]; });
    if (!tomb) continue;
    const spot = nearestFree(s.board, color, tomb[0], tomb[1]);
    if (!spot) continue; // 霊廟のまわりが埋まっていたら次のターン
    const g = UNITS[r.type].respawn, n = s.respawnCount[color];
    const u = makeUnit(r.type, color);
    u.maxHp += g.maxHp * n;
    u.hp = u.maxHp;
    u.atkBonus += g.atk * n;
    s.board[spot[1]][spot[0]] = u;
    s.respawns.splice(s.respawns.indexOf(r), 1);
    s.effects.push({ x: spot[0], y: spot[1], text: '復活！', kind: 'supply' });
    s.log.push({ color, text: `${UNITS[r.type].name}が ${squareName(s.board, spot[0], spot[1])} に復活（${n}回目：最大HP ${u.maxHp}・攻撃 ${effectiveAtk(u)}）` });
  }
}

// ---------------------------------------------------------------------
//  結界・泥沼・監視塔・挑発・墓地（蘇生）
// ---------------------------------------------------------------------
// attackerColor から見て、(x, y) が相手の結界の中か（中は攻撃できない・入れない）
function isWarded(state, attackerColor, x, y) {
  return (state.wards || []).some(w => w.color !== attackerColor && chebyshev(w.x, w.y, x, y) <= 1);
}
function inSwamp(state, x, y) {
  return (state.swamps || []).some(w => chebyshev(w.x, w.y, x, y) <= 1);
}

// 監視塔：(x, y) の u の近くに味方の監視塔があれば遠距離の射程 +1
function towerRangeBonus(state, u, x, y) {
  let bonus = 0;
  forEachUnit(state, (t, tx, ty) => {
    const w = watchOf(t);
    if (w && t.color === u.color && chebyshev(tx, ty, x, y) <= w.bonusRadius) bonus = Math.max(bonus, w.rangeBonus);
  });
  return bonus;
}

// color 側の監視塔が見張っているマスか（相手の罠が見える）
function watchedBy(state, color, x, y) {
  let seen = false;
  forEachUnit(state, (t, tx, ty) => {
    const w = watchOf(t);
    if (w && t.color === color && chebyshev(tx, ty, x, y) <= w.reveal) seen = true;
  });
  return seen;
}

// 破城槌・カタパルト：相手によってダメージの倍率が変わる
function isStructure(t) { return !!(UNITS[t.type].immobile || UNITS[t.type].shield); }
function attackMult(u, t) {
  const d = UNITS[u.type];
  if (d.siegeMult) return isStructure(t) ? siegeMultOf(u) : d.unitMult;
  return 1;
}

// 倒れたキャラを墓地へ（蘇生の司祭が呼び戻せる）
function addGrave(s, t) {
  const d = UNITS[t.type];
  if (d.royal || d.respawn || d.structure) return;
  s.graves = s.graves || [];
  s.graves.push({ color: t.color, unit: JSON.parse(JSON.stringify(t)) });
}

// 蘇生の司祭：蘇らせられる味方（新しい順）
function reviveOptions(state, x, y) {
  const u = state.board[y][x];
  if (!u || !UNITS[u.type].revive || (u.reviveUsed || 0) >= (u.evolved ? 2 : 1) || !canUseSkill(state, x, y)) return [];
  return (state.graves || []).map((g, i) => ({ g, i })).filter(o => o.g.color === u.color).reverse().slice(0, 6);
}
function reviveSquares(state, x, y) {
  const res = [];
  for (let ny = y - 2; ny <= y + 2; ny++)
    for (let nx = x - 2; nx <= x + 2; nx++)
      if (inBounds(state.board, nx, ny) && !state.board[ny][nx] && (nx !== x || ny !== y)) res.push([nx, ny]);
  return res;
}
function performRevive(state, from, graveIndex, [tx, ty]) {
  const s = cloneState(state);
  s.effects = [];
  const [x, y] = from, u = s.board[y][x];
  const g = s.graves[graveIndex];
  beginAction(s, u);
  u.acted = true;
  u.reviveUsed = (u.reviveUsed || 0) + 1;
  // 支援役の進化：蘇生もスキル1回として数える
  if (EVOLUTIONS[u.type] && !u.evolved) { u.skillUses = (u.skillUses || 0) + 1; if (u.skillUses >= EVOLVE.skillUses) s.log.push({ color: u.color, text: evolveUnit(s, u, x, y) }); }
  const r = g.unit;
  r.id = 'u' + nextUnitId++;
  r.hp = u.evolved ? r.maxHp : Math.min(r.maxHp, 10); // 聖人なら満タン
  r.buffs = [];
  r.moveHp = UNITS[r.type].moveHp;
  r.moved = r.acted = true; // 蘇ったターンは動けない
  r.hitRunPending = false;
  s.board[ty][tx] = r;
  s.graves.splice(graveIndex, 1);
  s.effects.push({ x: tx, y: ty, text: '蘇生！', kind: 'supply' });
  s.log.push({ color: u.color, text: `${unitLabel(s.board, u, x, y)} が${UNITS[r.type].name}${r.evo ? '（進化）' : ''}を蘇らせた（HP ${r.hp}）` });
  return finishAction(s);
}

// ---------------------------------------------------------------------
//  陣取りルーク：砦が2つ並んだら間に城壁
// ---------------------------------------------------------------------
// 同じ縦か横の列にある自分の砦の組で、間のマス数が FORT.castleWall.turnsByGap にあるもの
function castleWallOptions(state, f) {
  const res = [];
  for (const g of state.flags || []) {
    if (g === f || g.color !== f.color || !g.castle || !f.castle) continue;
    if (g.x !== f.x && g.y !== f.y) continue;
    const gap = Math.max(Math.abs(g.x - f.x), Math.abs(g.y - f.y)) - 3; // 旗の9マスどうしの間
    const turns = FORT.castleWall.turnsByGap[gap];
    if (!turns) continue;
    const exists = (state.castleWalls || []).some(w => (w.a === f.id && w.b === g.id) || (w.a === g.id && w.b === f.id));
    const building = (state.wallBuilds || []).some(w => (w.a === f.id && w.b === g.id) || (w.a === g.id && w.b === f.id));
    if (!exists && !building) res.push({ other: g, gap, turns });
  }
  return res;
}

function performWallBuild(state, from, otherId) {
  const s = cloneState(state);
  s.effects = [];
  const [x, y] = from, u = s.board[y][x];
  const f = flagAt(s, x, y, u.color);
  const opt = castleWallOptions(s, f).find(o => o.other.id === otherId);
  beginAction(s, u);
  u.acted = true;
  s.wallBuilds = s.wallBuilds || [];
  s.wallBuilds.push({ color: u.color, a: f.id, b: otherId, turnsLeft: opt.turns, builderId: u.id });
  const self = UNITS[u.type].plantsFlag;
  u.buffs.push(self ? { stat: 'fortbuild', turns: 999, label: '城壁を建設中（動けない・無防備ではない）', debuff: false }
    : { stat: 'building', turns: 999, label: `城壁を建設中（無防備：ダメージ${FORT.defenselessRate}倍）`, debuff: false });
  s.log.push({ color: u.color, text: `${unitLabel(s.board, u, x, y)} が ${squareName(s.board, opt.other.x, opt.other.y)} の砦までの城壁を建て始めた（${opt.turns}ターン）` });
  return finishAction(s);
}

// 城壁の線分（旗の真ん中どうしを結ぶ）
function castleWallSegment(state, w) {
  const a = state.flags.find(f => f.id === w.a), b = state.flags.find(f => f.id === w.b);
  return a && b ? [a.x, a.y, b.x, b.y] : null;
}
// attackerColor の遠距離攻撃をさえぎる相手の城壁
function castleWallBetween(state, attackerColor, ax, ay, tx, ty) {
  return (state.castleWalls || []).find(w => {
    if (w.color === attackerColor) return false;
    const seg = castleWallSegment(state, w);
    return seg && segmentsCross(ax, ay, tx, ty, seg);
  }) || null;
}

// ---------------------------------------------------------------------
//  新しいスキル（その2）
// ---------------------------------------------------------------------
function specialTargets2(state, x, y, skill) {
  const u = state.board[y][x];
  const enemyVisible = (t) => t && t.color !== u.color && !isHiddenFrom(t, u.color);
  switch (skill.kind) {
    case 'hex':
      return skillArea(state, x, y, skill).filter(([tx, ty]) => enemyVisible(state.board[ty][tx]) && !isWarded(state, u.color, tx, ty));
    case 'ward':
    case 'swamp':
      return skillArea(state, x, y, skill);
    case 'haste':
      return skillArea(state, x, y, skill).filter(([tx, ty]) => {
        const t = state.board[ty][tx];
        return t && t.color === u.color && t !== u && !UNITS[t.type].immobile && !t.extraAction;
      });
    case 'siege': { // 2マス以内の相手の旗（壁か砦があるもの）・浮遊要塞
      const reach = skill.reach || 2; // 攻城塔は3マス
      const res = (state.flags || []).filter(f => f.color !== u.color && (f.wall || f.castle) && chebyshev(f.x, f.y, x, y) <= reach).map(f => [f.x, f.y]);
      for (const f of state.fortresses || []) if (f.color !== u.color && chebyshev(f.x, f.y, x, y) <= reach) res.push([f.x, f.y]);
      return res;
    }
    case 'load':
      return hasBuff(u, 'loaded') ? [] : [[x, y]];
    case 'catapult': { // 前のターンまでに装填していれば、6マス先まで射線なし
      const ld = u.buffs.find(b => b.stat === 'loaded');
      if (!ld || ld.turns !== 1) return [];
      const res = skillArea(state, x, y, skill).filter(([tx, ty]) => {
        const t = state.board[ty][tx];
        return enemyVisible(t) && !isWarded(state, u.color, tx, ty) && !UNITS[t.type].rangedImmune && !hasBuff(t, 'immune');
      });
      for (const f of state.flags || []) if (f.color !== u.color && (f.wall || f.castle) && chebyshev(f.x, f.y, x, y) <= skill.range.max && !hasPos2(res, f.x, f.y)) res.push([f.x, f.y]);
      for (const f of state.fortresses || []) if (f.color !== u.color && chebyshev(f.x, f.y, x, y) <= skill.range.max && !hasPos2(res, f.x, f.y)) res.push([f.x, f.y]);
      return res;
    }
    case 'recall': {
      const res = [];
      forEachUnit(state, (t, tx, ty) => {
        if (t !== u && t.color === u.color && !UNITS[t.type].immobile && chebyshev(tx, ty, x, y) >= 2 &&
          !(state.recalls || []).some(r => r.unitId === t.id)) res.push([tx, ty]);
      });
      return res;
    }
    default:
      return null;
  }
}
function hasPos2(list, x, y) { return list.some(p => p[0] === x && p[1] === y); }

function performSpecial2(s, u, def, skill, fx, fy, target, who) {
  const [tx, ty] = target;
  const log = (text) => s.log.push({ color: u.color, text: `${who} の${skill.name} → ${text}` });
  switch (skill.kind) {
    case 'hex': {
      const t = s.board[ty][tx];
      t.buffs = t.buffs.filter(b => b.stat !== skill.debuff.stat);
      t.buffs.push({ stat: skill.debuff.stat, turns: 2, label: skill.debuff.label, debuff: true }); // 相手の次のターンのあいだ
      if (skill.extra) { // 大呪術師：もう1つ同時にかかる
        const more = skill.debuff.stat === 'nocounter' ? { stat: 'slow', label: '鈍足（移動コスト2倍）' } : { stat: 'nocounter', label: '反撃できない' };
        t.buffs = t.buffs.filter(b => b.stat !== more.stat);
        t.buffs.push({ ...more, turns: 2, debuff: true });
      }
      s.effects.push({ x: tx, y: ty, text: skill.name, kind: 'damage' });
      log(`${unitLabel(s.board, t, tx, ty)} に「${skill.debuff.label}」（1ターン）`);
      return finishAction(s);
    }
    case 'ward': {
      s.wards = (s.wards || []).filter(w => w.ownerId !== u.id);
      s.wards.push({ x: tx, y: ty, color: u.color, ownerId: u.id, turns: skill.turns, heal: skill.heal || 0 });
      log(`${squareName(s.board, tx, ty)} の周り9マスに結界（${skill.turns}ターン、相手は攻撃も侵入もできない）`);
      return finishAction(s);
    }
    case 'swamp': {
      s.swamps = s.swamps || [];
      s.swamps.push({ x: tx, y: ty, color: u.color, ownerId: u.id, turns: skill.turns });
      log(`${squareName(s.board, tx, ty)} の周り9マスを泥沼にした（${skill.turns}ターン、入るのに1マス2）`);
      return finishAction(s);
    }
    case 'haste': {
      const t = s.board[ty][tx];
      t.extraAction = true;
      t.buffs.push({ stat: 'haste', turns: 1, label: 'このターン2回行動できる', debuff: false });
      if (hasStarted(t) && isDone(t)) refreshForExtra(t); // もう動き終わっていたら、すぐもう一度動ける
      if (skill.extraTarget) { // 時の賢者：相手の隣の味方1体にも
        let other = null;
        forEachUnit(s, (o, ox, oy) => { if (!other && o !== t && o !== u && o.color === u.color && !UNITS[o.type].immobile && chebyshev(ox, oy, tx, ty) <= 1 && !o.extraAction) other = o; });
        if (other) { other.extraAction = true; other.buffs.push({ stat: 'haste', turns: 1, label: 'このターン2回行動できる', debuff: false }); if (hasStarted(other) && isDone(other)) refreshForExtra(other); }
      }
      s.effects.push({ x: tx, y: ty, text: '2回行動', kind: 'buff' });
      log(`${unitLabel(s.board, t, tx, ty)} がこのターン2回行動できるようになった`);
      return finishAction(s);
    }
    case 'siege': {
      const power = effectiveAtk(u) * siegeMultOf(u);
      const flag = s.flags.find(f => f.x === tx && f.y === ty && f.color !== u.color);
      const fort = s.fortresses.find(f => f.x === tx && f.y === ty && f.color !== u.color);
      log(hitStructure(s, flag, fort, power));
      return finishAction(s);
    }
    case 'load': {
      u.buffs.push({ stat: 'loaded', turns: 2, label: '装填済み（次のターンに発射できる）', debuff: false });
      log('石を装填した（次のターンに発射できる）');
      return finishAction(s);
    }
    case 'catapult': {
      u.buffs = u.buffs.filter(b => b.stat !== 'loaded');
      const t = s.board[ty][tx];
      const flag = s.flags.find(f => f.x === tx && f.y === ty && f.color !== u.color && (f.wall || f.castle));
      const fort = s.fortresses.find(f => f.x === tx && f.y === ty && f.color !== u.color);
      const power = effectiveAtk(u);
      if (flag || fort) log(hitStructure(s, flag, fort, power * skill.fortMult));
      else log(dealDamage(s, u, fx, fy, tx, ty, power).join('、'));
      if (skill.splash) { // トレビュシェット：着弾地点の周り3×3にも
        const parts = [];
        for (let y = ty - 1; y <= ty + 1; y++)
          for (let x = tx - 1; x <= tx + 1; x++) {
            if ((x === tx && y === ty) || !inBounds(s.board, x, y)) continue;
            const e = s.board[y][x];
            if (e && e.color !== u.color && !isWarded(s, u.color, x, y)) parts.push(...dealDamage(s, u, fx, fy, x, y, power));
          }
        if (parts.length) log('巻き込み：' + parts.join('、'));
      }
      s.effects.push({ x: tx, y: ty, text: '着弾', kind: 'damage' });
      if (s.winner) s.log.push({ color: null, text: winText(s) });
      return skill.free ? s : finishAction(s);
    }
    case 'recall': {
      const t = s.board[ty][tx];
      s.recalls = s.recalls || [];
      if (u.evolved) { // 天馬の戦乙女：すぐ目の前に来る
        s.board[ty][tx] = null;
        const fy2 = fy + (u.color === 'w' ? -1 : 1);
        const spot = inBounds(s.board, fx, fy2) && !s.board[fy2][fx] ? [fx, fy2] : nearestFree(s.board, u.color, fx, fy);
        s.board[spot[1]][spot[0]] = t;
        log(`${UNITS[t.type].name}がすぐに駆けつけた（${squareName(s.board, spot[0], spot[1])}）`);
        return finishAction(s);
      }
      s.recalls.push({ color: u.color, unitId: t.id, callerId: u.id });
      log(`${unitLabel(s.board, t, tx, ty)} を呼び寄せる（次の${COLOR_NAME[u.color]}のターンに目の前へ）`);
      return finishAction(s);
    }
  }
  return null;
}

// 旗（壁・砦）や浮遊要塞にダメージ。ログの文章を返す
function hitStructure(s, flag, fort, power) {
  if (flag) {
    const parts = [];
    if (flag.wall) { flag.wall = false; parts.push('旗の壁を壊した'); } // 城攻め兵器は一撃で壊す
    if (flag.castle) {
      flag.castle.hp -= power;
      parts.push(`${flag.castle.name}に ${power} ダメージ（残り ${Math.max(0, flag.castle.hp)}）`);
      if (flag.castle.hp <= 0) { parts.push(`${flag.castle.name}が崩れた！`); flag.castle = null; }
    }
    s.effects.push({ x: flag.x, y: flag.y, text: '-' + power, kind: 'damage' });
    return parts.join('、') || '効果なし';
  }
  if (fort) {
    fort.hp -= power;
    s.effects.push({ x: fort.x, y: fort.y, text: '-' + power, kind: 'damage' });
    const text = `魔導国家に ${power} ダメージ（残り ${Math.max(0, fort.hp)}）`;
    if (fort.hp <= 0) { s.fortresses.splice(s.fortresses.indexOf(fort), 1); return text + '、魔導国家が墜落した！'; }
    return text;
  }
  return '効果なし';
}

// 2回行動：動き終わったキャラをもう一度動けるようにする（行動回数は使わない）
function refreshForExtra(t) {
  t.extraAction = false;
  t.moved = t.acted = false;
  t.hitRunPending = false;
  t.freeAction = true;
}

// 自分のターンの始め：結界・泥沼の残り、呼び寄せ、城壁の建設
function turnStart2(s, color) {
  for (const w of s.wards || []) { // 聖域の守護者の結界：中の味方は回復
    if (w.color !== color || !w.heal) continue;
    forEachUnit(s, (t, x, y) => { if (t.color === color && chebyshev(w.x, w.y, x, y) <= 1 && t.hp < t.maxHp) t.hp = Math.min(t.maxHp, t.hp + w.heal); });
  }
  s.wards = (s.wards || []).filter(w => w.color !== color || --w.turns > 0);
  s.swamps = (s.swamps || []).filter(w => w.color !== color || --w.turns > 0);
  // 戦乙女の招集：呼ばれた味方が目の前に来る
  for (const r of [...(s.recalls || [])]) {
    if (r.color !== color) continue;
    let caller = null, cx = 0, cy = 0, unit = null, ux = 0, uy = 0;
    forEachUnit(s, (t, x, y) => {
      if (t.id === r.callerId) { caller = t; cx = x; cy = y; }
      if (t.id === r.unitId) { unit = t; ux = x; uy = y; }
    });
    s.recalls.splice(s.recalls.indexOf(r), 1);
    if (!caller || !unit) continue;
    s.board[uy][ux] = null;
    const fy = cy + (color === 'w' ? -1 : 1); // まず真正面、ふさがっていれば一番近い空きマス（戦乙女）
    const spot = inBounds(s.board, cx, fy) && !s.board[fy][cx] ? [cx, fy] : nearestFree(s.board, color, cx, cy);
    if (!spot) { s.board[uy][ux] = unit; continue; }
    s.board[spot[1]][spot[0]] = unit;
    s.effects.push({ x: spot[0], y: spot[1], text: '招集', kind: 'buff' });
    s.log.push({ color, text: `${UNITS[unit.type].name}が戦乙女のもとへ駆けつけた（${squareName(s.board, spot[0], spot[1])}）` });
  }
  // 城壁の建設
  for (const w of [...(s.wallBuilds || [])]) {
    if (w.color !== color) continue;
    let builder = null;
    forEachUnit(s, t => { if (t.id === w.builderId) builder = t; });
    if (!builder) { s.wallBuilds.splice(s.wallBuilds.indexOf(w), 1); continue; }
    if (--w.turnsLeft > 0) continue;
    s.wallBuilds.splice(s.wallBuilds.indexOf(w), 1);
    builder.buffs = builder.buffs.filter(b => b.stat !== 'building' && b.stat !== 'fortbuild');
    s.castleWalls = s.castleWalls || [];
    s.castleWalls.push({ color, a: w.a, b: w.b, hp: FORT.castleWall.hp });
    s.log.push({ color, text: `${COLOR_NAME[color]}の城壁が完成した（HP ${FORT.castleWall.hp}・遠距離攻撃を防ぐ）` });
  }
  // 両端の砦がなくなった城壁は消える
  s.castleWalls = (s.castleWalls || []).filter(w => {
    const a = s.flags.find(f => f.id === w.a), b = s.flags.find(f => f.id === w.b);
    return a && b && a.castle && b.castle && a.color === w.color && b.color === w.color;
  });
}

// ---------------------------------------------------------------------
//  なぞる移動：1マスずつ決めた道を歩く（歩くタイプのキャラだけ）
// ---------------------------------------------------------------------
function traceCost(state, u, path) { return path.reduce((n, [x, y]) => n + enterCost(state, u, x, y), 0); }

function traceNextSteps(state, from, path) {
  const u = state.board[from[1]][from[0]], mv = UNITS[u.type].move;
  const [cx, cy] = path.length ? path[path.length - 1] : from;
  const spent = traceCost(state, u, path);
  return ORTHO.map(([dx, dy]) => [cx + dx, cy + dy]).filter(([nx, ny]) => {
    if (!inBounds(state.board, nx, ny) || (nx === from[0] && ny === from[1]) || path.some(p => p[0] === nx && p[1] === ny)) return false;
    const t = state.board[ny][nx];
    if (t && t.color !== u.color && !mv.ignoreUnits) return false;
    if (isWarded(state, u.color, nx, ny) || !stepAllowed(state, cx, cy, nx, ny)) return false;
    return spent + enterCost(state, u, nx, ny) <= u.moveHp;
  });
}

// その道で止まれるか（最後のマスが空いていて、拘束などに引っかからない）
function canEndTrace(state, from, path) {
  if (!path.length) return false;
  const [tx, ty] = path[path.length - 1];
  const u = state.board[from[1]][from[0]];
  return !state.board[ty][tx] && moveLimitOk(state, u, from[0], from[1], [tx, ty]);
}

function performMovePath(state, from, path) {
  const u = state.board[from[1]][from[0]];
  return moveAlong(state, from, path, traceCost(state, u, path), false);
}

// ---------------------------------------------------------------------
//  セミラミスの土台の建物
// ---------------------------------------------------------------------
function findOwnStructure(state, color, type) {
  let found = null;
  forEachUnit(state, (t, x, y) => { if (t.color === color && t.type === type) found = [t, x, y]; });
  return found;
}

// 土台の外周のうち、角と真ん中以外のマス（アルテミス砲を置ける端）
function fortEdgeSquares(state, f) {
  const r = fortRadius(f), res = [];
  for (let ty = f.y - r; ty <= f.y + r; ty++)
    for (let tx = f.x - r; tx <= f.x + r; tx++) {
      if (!inBounds(state.board, tx, ty)) continue;
      const ex = Math.abs(tx - f.x) === r, ey = Math.abs(ty - f.y) === r;
      if (ex !== ey) res.push([tx, ty]); // 外周で、角ではない
    }
  return res;
}

// アルテミス砲が撃てるマス：砲から外向きの扇形（90度）で、7マスまで
function artemisArea(state, color) {
  const c = findOwnStructure(state, color, 'artemisCannon');
  if (!c) return [];
  const [cannon, cx, cy] = c, [dx, dy] = cannon.facing || [0, color === 'w' ? -1 : 1];
  const max = SKY.facilities.artemis.range, res = [];
  for (let ty = 0; ty < boardHeight(state.board); ty++)
    for (let tx = 0; tx < boardWidth(state.board); tx++) {
      const along = (tx - cx) * dx + (ty - cy) * dy;       // 向いている方向にどれだけ先か
      const side = Math.abs((tx - cx) * dy - (ty - cy) * dx); // 横にどれだけずれているか
      if (along >= 1 && along <= max && side <= along) res.push([tx, ty]);
    }
  return res;
}

// ---------------------------------------------------------------------
//  ルーク・ビショップ・ナイト・クイーン枠の進化
// ---------------------------------------------------------------------
function evolveUnit(s, u, x, y) {
  const ev = EVOLUTIONS[u.type];
  if (!ev || u.evolved) return '';
  u.evolved = true;
  u.evo = Math.max(u.evo || 0, 1);
  u.maxHp += EVOLVE.maxHp;
  u.hp = Math.min(u.maxHp, u.hp + EVOLVE.maxHp);
  s.effects.push({ x, y, text: '進化！', kind: 'supply' });
  return `${UNITS[u.type].name}が${ev.name}に進化した！`;
}

// 進化していたらスキルの数値を変えたものを返す（変わらなければそのまま）
function effSkill(u, sk) {
  if (!u || !u.evolved || !sk) return sk;
  switch (u.type) {
    case 'empress': return sk.kind === 'formation' ? { ...sk, maxDist: 2, guard: { stat: 'atk', amount: 1, label: '攻撃+1', turns: 1 } } : sk;
    case 'ram': return sk.kind === 'siege' ? { ...sk, reach: 3 } : sk;
    case 'catapult': return sk.kind === 'catapult' ? { ...sk, range: { ...sk.range, max: 8 }, splash: 1 } : sk;
    case 'H':
      if (sk.name === '範囲ヒール') return { ...sk, power: 3 };
      if (sk.kind === 'cleanse') return { ...sk, aoe: 2 };
      return sk;
    case 'hexer': return sk.kind === 'hex' ? { ...sk, cooldown: 2, extra: true } : sk;
    case 'warder': return sk.kind === 'ward' ? { ...sk, turns: 3, heal: 1 } : sk;
    case 'timepriest': return sk.kind === 'haste' ? { ...sk, cooldown: 2, extraTarget: true } : sk;
    case 'C': return sk.kind === 'push' ? { ...sk, ammoCost: 4, bonus: 2 } : sk;
    default: return sk;
  }
}

// 進化で変わる移動・数値
function unitMoveDef(u) {
  if (u.evolved && u.type === 'valkyrie') return { type: 'area', max: 3 }; // 天馬で飛ぶ
  return UNITS[u.type].move;
}
function siegeMultOf(u) { return u.evolved && u.type === 'ram' ? 4 : UNITS[u.type].siegeMult; }
function watchOf(t) {
  const w = UNITS[t.type].watch;
  return w && t.evolved ? { ...w, reveal: 6, rangeBonus: 2 } : w;
}
function tauntOf(t) { const d = UNITS[t.type].taunt; return d && t.evolved ? 3 : d; }
