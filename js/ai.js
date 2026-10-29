// =====================================================================
//  簡易 CPU：その場で一番点数の高い行動を1つずつ選ぶ（先読みなし）
// =====================================================================
//  方針：相手のキングを狙う／味方とまとまって前に出る／しばらく戦闘がないと攻撃的になる

// 攻撃性の倍率：戦闘のない巡が続くほど上がる（1 〜 AI.maxAggression）
const AI = {
  kingPull: 0.45,      // 相手のキングに1マス近づくごとの加点
  enemyPull: 0.15,     // 一番近い敵に1マス近づくごとの加点
  cohesion: 0.35,      // 周り2マスにいる味方1体ごとの加点（3体まで）
  aheadPenalty: 0.6,   // 味方の平均より3マス以上前に突出したときの1マスごとの減点
  danger: 0.35,        // 次の相手ターンに受けそうなダメージ1あたりの減点
  counterFear: 0.5,    // 攻撃したときに返ってくる反撃ダメージ1あたりの減点
  idleStep: 0.35,      // 戦闘のない巡1つごとに増える攻撃性
  lateStep: 0.04,      // 巡が進むごとに増える攻撃性（終盤ほど決着をつけにいく）
  focusFire: 2,        // 弱っている敵ほど優先して殴る（HPが減っている割合 × これ）
  maxAggression: 3,
};

function aggression(state) {
  const idle = state.round - (state.lastCombatRound || 1);
  return Math.min(AI.maxAggression, 1 + Math.max(0, idle - 1) * AI.idleStep + state.round * AI.lateStep);
}

// t を攻撃して t が生き残ったとき、(x, y) の u に返ってくる反撃ダメージ
function counterRisk(state, x, y, t, tx, ty) {
  if (!RULES.counter || isSnared(t) || isBuilding(t)) return 0;
  for (const sk of UNITS[t.type].skills) {
    if (sk.kind !== 'damage' || sk.aoe != null || sk.targetSquare) continue;
    if (skillTargets(state, tx, ty, sk).some(p => p[0] === x && p[1] === y)) return sk.power ?? effectiveAtk(t);
  }
  return 0;
}

function unitsOf(state, color) {
  const res = [];
  forEachUnit(state, (u, x, y) => { if (u.color === color) res.push([u, x, y]); });
  return res;
}

function hasPosition(list, x, y) { return list.some(p => p[0] === x && p[1] === y); }

// color 側のキャラが、敵から何回狙われているか（シールドで防げているものは数えない）
function threatCount(state, color) {
  let n = 0;
  for (const [e, ex, ey] of unitsOf(state, opposite(color)))
    for (const sk of UNITS[e.type].skills)
      if (sk.kind === 'damage' && !sk.targetSquare) n += skillTargets(state, ex, ey, sk).filter(([tx, ty]) => state.board[ty][tx] && state.board[ty][tx].color === color).length;
  return n;
}

// スキルを使ったときの点数
function skillScore(state, x, y, tx, ty, skill) {
  const u = state.board[y][x];
  if (skill.kind === 'rotate') {
    // 向きを変えて、狙われる回数が減るなら加点
    const s = cloneState(state);
    s.board[y][x].facing = [tx - x, ty - y];
    return (threatCount(state, u.color) - threatCount(s, u.color)) * 1.5;
  }
  if (skill.kind === 'summon') return 8; // 呼べるならほぼ最優先
  // まだ CPU が使いこなせないスキル
  if (['squad', 'hook', 'trap', 'alert', 'stealth', 'descentPoint', 'blueflame', 'oneway', 'blackblade',
    'transfer', 'explosion', 'doomUp', 'fortressBuild', 'fortressMove', 'facility', 'ward', 'swamp', 'haste', 'recall', 'fortRepair'].includes(skill.kind)) return -1;
  if (skill.kind === 'siege') return 3 + effectiveAtk(u) * 0.3;  // 固い守りを割る
  if (skill.kind === 'load') { // 6マス以内に敵がいれば装填しておく
    let near = false;
    forEachUnit(state, (e, ex, ey) => { if (e.color !== u.color && chebyshev(x, y, ex, ey) <= 6) near = true; });
    return near ? 1.5 : -1;
  }
  if (skill.kind === 'catapult') {
    const t = state.board[ty][tx];
    if (!t || t.color === u.color) return 3; // 砦・要塞
    const power = effectiveAtk(u);
    return t.hp <= power ? (UNITS[t.type].royal ? 1000 : 5 + UNITS[t.type].value * 0.8) : power * 0.6 + UNITS[t.type].value * 0.1 + 1;
  }
  if (skill.kind === 'hex') { // 強い敵を弱らせる
    const t = state.board[ty][tx];
    return t ? 0.5 + UNITS[t.type].value * 0.1 + (skill.debuff.stat === 'weaken' ? effectiveAtk(t) * 0.2 : 0) : -1;
  }
  if (skill.kind === 'doom') {
    // 即死の呪い：効く敵の大事さで点数
    const cells = skill.aoe != null ? aoeSquares(state, tx, ty, skill) : [[tx, ty]];
    let score = -1;
    for (const [cx, cy] of cells) {
      const t = state.board[cy][cx];
      if (t && t.color !== u.color && doomable(u, t)) score += UNITS[t.type].royal ? 50 : 4 + UNITS[t.type].value * 0.8;
    }
    return score;
  }
  if (skill.kind === 'pierce') {
    const power = movedDamage(u, skill.power ?? effectiveAtk(u));
    let score = -1;
    for (const [ax, ay] of lineSquares(state, x, y, [tx - x, ty - y], skill.length)) {
      const t = state.board[ay][ax];
      if (!t || t.color === u.color || isHiddenFrom(t, u.color)) continue;
      const tdef = UNITS[t.type];
      score += t.hp <= power ? (tdef.royal ? 1000 : 5 + tdef.value * 0.8) : power * 0.6 + tdef.value * 0.1;
    }
    return score;
  }
  if (skill.kind === 'spawn') return skill.free ? 3 : 2.5;
  if (skill.kind === 'push') {
    // なぎ払いに入る敵へのダメージを合計
    const power = movedDamage(u, skill.power ?? effectiveAtk(u)); // 移動後は弱くなる
    let score = -1;
    for (const [ax, ay] of pushArea(state, x, y, [tx - x, ty - y], skill)) {
      const t = state.board[ay][ax];
      if (!t || t.color === u.color) continue;
      const tdef = UNITS[t.type];
      score += t.hp <= power ? (tdef.royal ? 1000 : 5 + tdef.value * 0.8) : power * 0.6 + tdef.value * 0.1;
    }
    return score;
  }
  if (skill.kind === 'charge') return 1.2 + u.charge * 0.5; // ためるほど途切れさせたくない
  const agg = aggression(state);
  const cells = skill.aoe != null ? aoeSquares(state, tx, ty, skill) : [[tx, ty]];
  const power = movedDamage(u, skill.power ?? effectiveAtk(u)) * (skill.hits || 1); // 移動後は弱くなる・二連撃は2倍
  let score = 0;
  for (const [cx, cy] of cells) {
    const t = state.board[cy][cx];
    if (!t) continue;
    const tdef = UNITS[t.type];
    if (skill.kind === 'heal' && t.color === u.color) {
      score += Math.min(power, t.maxHp - t.hp) * 0.8 + (tdef.royal && t.hp < t.maxHp ? 1 : 0);
    } else if (skill.kind === 'buff' && t.color === u.color) {
      // 攻撃できる相手がいるキャラを強化すると良い
      const canHit = tdef.skills.some(sk => sk.kind === 'damage' && skillTargets(state, cx, cy, sk).length);
      const already = t.buffs.some(b => b.stat === skill.buff.stat && !b.debuff);
      score += already ? -1 : (canHit ? 1.5 : 0.3);
    } else if (skill.kind === 'cleanse' && t.color === u.color) {
      score += t.buffs.filter(b => b.debuff).length * 2;
    } else if (skill.kind === 'damage' && t.color !== u.color && !(skill.notEnemyCamp && isEnemyCamp(u.color, cx, cy))) {
      if (t.hp <= power) { score += tdef.royal ? 1000 : 5 + tdef.value * 0.8; continue; } // 倒せるなら最優先
      score += power * 0.6 + tdef.value * 0.1 + (tdef.royal ? 3 * agg : 0); // キングは削るだけでも価値がある
      score += (1 - t.hp / t.maxHp) * AI.focusFire; // 弱っている敵を集中して狙う
      // 単体攻撃は反撃を受けるかもしれない
      if (skill.aoe == null) {
        const back = counterRisk(state, x, y, t, cx, cy);
        score -= back >= u.hp ? 6 : back * AI.counterFear / agg;
      }
    }
  }
  return score > 0 ? score : -1;
}

// (x, y) のキャラが (tx, ty) にいたらどれくらい良い位置か
function positionScore(state, x, y, tx, ty) {
  const s = { ...state, board: state.board.map(row => row.slice()) };
  const u = s.board[y][x];
  s.board[y][x] = null;
  s.board[ty][tx] = u;
  const def = UNITS[u.type];
  const enemies = unitsOf(s, opposite(u.color)).filter(([e]) => !isHiddenFrom(e, u.color)); // 透明の敵は見えない
  if (!enemies.length) return 0;
  const agg = aggression(state);

  // 次の相手ターンに受けそうなダメージ（相手は移動してから殴れるので、移動HP＋射程で届く敵を数える）
  let danger = 0;
  for (const [e, ex, ey] of enemies) {
    const reach = RULES.moveAndAct ? Math.floor(e.moveHp / stepCostOf(e)) : 0;
    for (const sk of UNITS[e.type].skills) {
      if (sk.kind !== 'damage' || sk.targetSquare) continue;
      const power = sk.power ?? effectiveAtk(e);
      if (hasPosition(skillTargets(s, ex, ey, sk), tx, ty)) { danger += power; break; }
      if (reach && sk.range.type === 'area' && chebyshev(ex, ey, tx, ty) <= sk.range.max + reach) {
        danger += Math.max(1, Math.round(power * RULES.movedAttackRate));
        break;
      }
    }
  }
  danger = finalDamage(u, 0, 0, 0, 0, danger); // 築城中などの倍率
  const lethal = danger >= u.hp;
  const nearest = Math.min(...enemies.map(([, ex, ey]) => chebyshev(tx, ty, ex, ey)));
  const allies = unitsOf(s, u.color).filter(([a]) => a !== u);
  const alliesNear = allies.filter(([, ax, ay]) => chebyshev(ax, ay, tx, ty) <= 2).length;

  // キング：危ないところに行かず、味方のそばにいる
  if (def.royal) return Math.min(nearest, 4) * 0.4 - (lethal ? 50 : danger * 0.8) + Math.min(alliesNear, 4) * 0.3;

  let score = 0;
  // 相手のキングを狙う
  const king = enemies.find(([e]) => UNITS[e.type].royal);
  if (king) score -= chebyshev(tx, ty, king[1], king[2]) * AI.kingPull * agg;
  // 近くの敵へ向かう
  score -= nearest * AI.enemyPull * agg;
  // まとまって前に出る：味方のそばは加点、1体だけ突出すると減点
  const H = boardHeight(s.board);
  const fwd = (yy) => (u.color === 'w' ? H - 1 - yy : yy);
  const others = allies.filter(([a]) => !UNITS[a.type].royal);
  if (others.length) {
    const avg = others.reduce((n, [, , ay]) => n + fwd(ay), 0) / others.length;
    const ahead = fwd(ty) - avg;
    if (ahead > 2) score -= (ahead - 2) * AI.aheadPenalty / agg;
  }
  score += Math.min(alliesNear, 3) * AI.cohesion;
  // 危険：しびれを切らすほど気にしなくなる
  score -= (lethal ? 3 + def.value * 0.5 : danger * AI.danger) / agg;
  // 遠距離キャラは敵の隣に寄りすぎない
  const reachMax = Math.max(0, ...def.skills.filter(sk => sk.kind === 'damage' && sk.range && sk.range.type === 'area').map(sk => sk.range.max));
  if (reachMax >= 2 && nearest <= 1) score -= 1.5;
  // 攻撃できる位置（移動してからそのまま殴れる）
  for (const sk of def.skills) {
    if (sk.kind !== 'damage' || sk.targetSquare) continue;
    const targets = skillTargets(s, tx, ty, sk);
    if (!targets.length) continue;
    const hitsKing = targets.some(([ex, ey]) => UNITS[s.board[ey][ex].type].royal);
    score += 2 + (hitsKing ? 3 : 0) + Math.max(...targets.map(([ex, ey]) => UNITS[s.board[ey][ex].type].value)) * 0.05;
    break;
  }
  // 移動HP が減っているなら補給路の上は加点
  if (isSupplyFor(state, u.color, tx, ty)) score += (def.moveHp - u.moveHp) * 0.1;
  return score;
}

// 補給ナイト用：上下左右にまっすぐ進む道の候補
function routeCandidates(state, x, y) {
  const res = [];
  for (const [dx, dy] of ORTHO) {
    const path = [];
    for (;;) {
      const next = routeNextSteps(state, [x, y], path).find(p => p[0] === (path.length ? path[path.length - 1][0] : x) + dx
        && p[1] === (path.length ? path[path.length - 1][1] : y) + dy);
      if (!next) break;
      path.push(next);
      res.push(path.slice());
    }
  }
  return res;
}

function cpuChooseAction(state) {
  let best = null;
  const consider = (a) => {
    a.score += Math.random() * 0.05; // 同点のときに毎回同じ手にならないように
    if (!best || a.score > best.score) best = a;
  };
  for (const [u, x, y] of unitsOf(state, state.turn)) {
    const def = UNITS[u.type];
    if (canUseSkill(state, x, y)) {
      def.skills.forEach((sk, i) => {
        for (const [tx, ty] of skillTargets(state, x, y, sk))
          consider({ kind: 'skill', from: [x, y], to: [tx, ty], skill: i, score: skillScore(state, x, y, tx, ty, sk) });
      });
    }
    if (!canMove(state, x, y)) continue;
    const here = positionScore(state, x, y, x, y);
    if (def.move.type === 'route') {
      for (const path of routeCandidates(state, x, y)) {
        const [tx, ty] = path[path.length - 1];
        const fresh = path.filter(([px, py]) => state.supply[py][px] !== u.color).length;
        const score = positionScore(state, x, y, tx, ty) - here + fresh * 0.3 - routeCost(state, u, path) * 0.08;
        consider({ kind: 'route', from: [x, y], path, score });
      }
      continue;
    }
    for (const [tx, ty, cost, path] of moveTargets(state, x, y)) {
      // 移動HPを使い切ると逃げられなくなるので、使う量が多いほど少し減点
      let score = positionScore(state, x, y, tx, ty) - here - cost * 0.08;
      // 陣取りキャラは増える陣地のマス数を加点
      if (def.claimsTerritory) {
        const s = cloneState(state);
        score += claimTerritory(s, u.color, path.slice(0, -1), [tx, ty]) * 0.25;
      }
      consider({ kind: 'move', from: [x, y], to: [tx, ty], score });
    }
  }
  // 良い手がなければ null（ターン終了）
  return best && best.score > 0.1 ? best : null;
}

function applyCpuAction(state, a) {
  if (a.kind === 'route') return performRoute(state, a.from, a.path);
  return a.kind === 'move' ? performMove(state, a.from, a.to) : performSkill(state, a.from, a.to, a.skill);
}
