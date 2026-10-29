// =====================================================================
//  画面表示と操作
// =====================================================================

const CPU_COLOR = 'b';
let cpuDelay = 700;   // CPU が1手ごとに待つ時間（ミリ秒）。観戦中に速さを変えられる
let spectate = false; // CPU 同士の対戦を観戦中

let phase = 'setup';       // 'setup'（デッキ構築）| 'play'（試合中）
let setupColor = 'w';      // デッキ構築中の側
let decks = { w: loadDeck('w'), b: loadDeck('b') };
let pick = null;           // デッキ構築で選んでいるキャラ
let S = createInitialState(decks);
let history = [];          // 一手戻し用
let selected = null;       // 選択中のマス [x, y]
let mode = null;           // 'move' | 'route' | スキル番号 | null
let routePath = [];        // 補給ナイトが作っている途中の道
let formationAnchor = null; // レオニダスの陣形移動・二刀流の一方通行で選んだ基準のマス
let reinforcePick = null;   // 増援で選んでいるキャラ
let confirmTarget = null;   // 範囲スキルで「この場所でいい？」と確認中のマス
let inspected = null;       // 観戦中・CPU の番に押して、詳しく見ているマス
let tracePath = [];         // 「なぞる」移動で作っている途中の道
let tracing = false;        // なぞる移動をドラッグ中
let reviveGrave = null;     // 蘇生で選んだ墓（S.graves の番号）
let moveInput = 'tap';      // 移動のしかた：'tap'（行き先を押す）/ 'trace'（道をなぞる）
try { moveInput = localStorage.getItem('chess-tactics-move-input') || 'tap'; } catch (e) { /* 無視 */ }
let reinforceOpen = false;  // 増援の一覧を開いているか
let menuPos = loadMenuPos(); // 行動メニューをドラッグした位置（null = キャラの横に自動で出す）
var hover = null;          // カーソルが乗っているマス
let flipped = false;
let cpuEnabled = false;
let cpuBusy = false;
let fieldChoice = 'random'; // 戦場の選択（'random' なら試合ごとに選ぶ）
try { fieldChoice = localStorage.getItem('chess-tactics-field') || 'random'; } catch (e) { /* 保存できない環境 */ }
let net = null;             // ネット対戦中：{ code, color: 'w' | 'b' | 'watch', version, ... }（net.js）

const boardEl = document.getElementById('board');
const menuEl = document.getElementById('menu');
const statusEl = document.getElementById('status');
const pipsEl = document.getElementById('pips');
const territoryEl = document.getElementById('territory');
const infoEl = document.getElementById('info');
const logEl = document.getElementById('log');
const undoBtn = document.getElementById('btn-undo');
const endBtn = document.getElementById('btn-end');

// 画面を見ている側。CPU 対戦なら人間（白）、2人対戦なら今の手番
const viewer = () => (spectate ? 'all' : net ? (net.color === 'watch' ? 'all' : net.color) : cpuEnabled ? opposite(CPU_COLOR) : S.turn); // 観戦中は全部見える
// 見えているキャラだけ返す（相手の透明キャラは見えない）
const unitAt = (pos) => {
  const u = pos ? S.board[pos[1]][pos[0]] : null;
  return u && (viewer() === 'all' || !isHiddenFrom(u, viewer())) ? u : null;
};
const samePos = (a, x, y) => a && a[0] === x && a[1] === y;
const hasPos = (list, x, y) => list.some(p => p[0] === x && p[1] === y);
const cpuTurn = () => phase === 'play' && !S.winner && !net && (spectate || (cpuEnabled && S.turn === CPU_COLOR));
// ネット対戦で相手の番（または観戦）なので操作できない
const netWait = () => !!net && phase === 'play' && !S.winner && (net.color === 'watch' || S.turn !== net.color);
const locked = () => cpuTurn() || netWait();

// 画面上の位置（盤を反転していても正しい場所を返す）
function screenPos(x, y) {
  const W = boardWidth(S.board), H = boardHeight(S.board);
  return flipped ? [W - 1 - x, H - 1 - y] : [x, y];
}

function currentTargets() {
  const none = { targets: [], area: [], kind: null };
  if (reinforcePick) return { targets: reinforceSquares(S, S.turn), area: [], kind: 'reinforce' };
  if (!selected || mode === null || !unitAt(selected)) return none;
  const [x, y] = selected;
  if (mode === 'move' && usesTrace(unitAt(selected))) return canMove(S, x, y) ? { targets: traceNextSteps(S, selected, tracePath), area: [], kind: 'trace' } : none;
  if (mode === 'move') return canMove(S, x, y) ? { targets: moveTargets(S, x, y), area: [], kind: 'move' } : none;
  if (mode === 'revive') return { targets: reviveSquares(S, x, y), area: [], kind: 'revive' };
  if (mode === 'route') return canMove(S, x, y) ? { targets: routeNextSteps(S, selected, routePath), area: [], kind: 'route' } : none;
  const skill = effSkill(unitAt(selected), UNITS[unitAt(selected).type].skills[mode]);
  if (!(skill.passive ? canUsePassive(S, unitAt(selected)) : canUseSkill(S, x, y))) return none; // 何回でも使えるスキルは行動済みでも使える
  if (skill.kind === 'formation') {
    const color = unitAt(selected).color;
    // 1段階目：動かすグループの基準を選ぶ / 2段階目：基準の行き先を選ぶ
    if (!formationAnchor) return { targets: formationAnchors(S, color, skill.shape), area: [], kind: 'formation-pick' };
    return {
      targets: formationTargets(S, color, skill, formationAnchor),
      area: formationMembers(S, color, skill.shape, formationAnchor), kind: 'formation',
    };
  }
  if (skill.kind === 'oneway') {
    // 1段階目：3×3の中心を選ぶ / 2段階目：進める向き（中心の隣のマス）を選ぶ
    if (!formationAnchor) return { targets: skillTargets(S, x, y, skill), area: [], kind: 'oneway-pick' };
    const [ax, ay] = formationAnchor;
    return {
      targets: ORTHO.map(([dx, dy]) => [ax + dx, ay + dy]).filter(([nx, ny]) => inBounds(S.board, nx, ny)),
      area: aoeSquares(S, ax, ay, { aoe: 1 }), kind: 'oneway',
    };
  }
  // 範囲効果のスキルは、効果が及ぶ範囲を表示する
  const area = skill.aoe != null ? aoeSquares(S, x, y, skill) : skillArea(S, x, y, skill);
  return { targets: skillTargets(S, x, y, skill), area, kind: skill.kind };
}

const AIM_CLASS = {
  move: 'reach', route: 'reach', formation: 'reach', heal: 'aim-heal', buff: 'aim-heal', cleanse: 'aim-heal',
  rotate: 'aim-rotate', warp: 'aim-rotate', 'formation-pick': 'aim-pick', charge: 'aim-heal', summon: 'aim-rotate',
  push: 'aim', spawn: 'aim-rotate', squad: 'aim-pick', pierce: 'aim', hook: 'aim',
  trap: 'aim-rotate', alert: 'aim-rotate', descentPoint: 'aim-rotate',
  blueflame: 'aim', 'oneway-pick': 'aim-pick', oneway: 'aim-rotate', blackblade: 'aim', transfer: 'aim-heal',
  explosion: 'aim', doom: 'aim', fortressMove: 'aim-rotate', reinforce: 'aim-heal',
  trace: 'reach', revive: 'aim-heal', hex: 'aim', ward: 'aim-rotate', swamp: 'aim-rotate', haste: 'aim-heal',
  siege: 'aim', catapult: 'aim', recall: 'aim-heal', facility: 'aim-rotate', fortRepair: 'aim-heal',
};
const AREA_CLASS = { heal: 'area-heal', buff: 'area-heal', cleanse: 'area-heal', rotate: 'area-rotate', formation: 'area-group', oneway: 'area-group' };

// 「なぞる」設定で、歩くタイプのキャラなら道をなぞって動かす
function usesTrace(u) { return moveInput === 'trace' && u && UNITS[u.type].move.type === 'points'; }

// 今選んでいるスキル（なければ null）
function currentSkill() {
  if (!selected || typeof mode !== 'number' || !unitAt(selected)) return null;
  return effSkill(unitAt(selected), UNITS[unitAt(selected).type].skills[mode]);
}

// 画面上の上下左右 → 盤面上のずれ
function screenDir(side) {
  const d = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[side];
  return flipped ? [-d[0], -d[1]] : d;
}

// シールドの縁を描く場所 { 'x,y': [{ side, color }] }
function shieldEdges() {
  const edges = {};
  forEachUnit(S, (u, x, y) => {
    if (!UNITS[u.type].shield) return;
    const [fx, fy] = u.facing;
    let side = fx === 0 ? (fy < 0 ? 'n' : 's') : (fx > 0 ? 'e' : 'w');
    if (flipped) side = { n: 's', s: 'n', e: 'w', w: 'e' }[side];
    const half = (UNITS[u.type].shield.width - 1) / 2;
    for (let i = -half; i <= half; i++) {
      const [cx, cy] = fx === 0 ? [x + i, y] : [x, y + i];
      if (!inBounds(S.board, cx, cy)) continue;
      (edges[cx + ',' + cy] = edges[cx + ',' + cy] || []).push({ side, color: u.color });
    }
  });
  return edges;
}

// ---------------------------------------------------------------------
//  描画
// ---------------------------------------------------------------------
// 試合で使う戦場を決める（ランダムならチェス盤以外から）
function pickField() {
  if (FIELDS[fieldChoice]) return fieldChoice;
  const list = Object.keys(FIELDS).filter(f => f !== 'classic');
  return list[Math.floor(Math.random() * list.length)];
}
// マスごとに少しだけ色を変えて、地面らしく見せる（いつも同じ並びになるように位置から決める）
function groundClass(x, y) {
  return 'g' + ((x * 7 + y * 13 + ((x * y) % 5)) % 4);
}
function applyField() {
  const f = phase === 'play' ? (S.field || 'grass') : (FIELDS[fieldChoice] ? fieldChoice : 'grass');
  boardEl.dataset.field = f;
}

function render() {
  applyField();
  if (phase === 'setup') { renderSetup(); return; }
  const W = boardWidth(S.board), H = boardHeight(S.board);
  const { targets, area, kind } = currentTargets();
  const last = S.lastAction;
  const edges = shieldEdges();
  // 選んでいる隊長虫の部隊メンバー
  const squadIds = unitAt(selected) ? unitAt(selected).squad : [];

  boardEl.style.gridTemplateColumns = `repeat(${W}, 1fr)`;
  boardEl.style.gridTemplateRows = `repeat(${H}, 1fr)`;
  boardEl.style.aspectRatio = `${W} / ${H}`;
  boardEl.innerHTML = '';

  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const [x, y] = flipped ? [W - 1 - col, H - 1 - row] : [col, row];
      const sq = document.createElement('div');
      sq.className = 'sq ' + ((x + y) % 2 === 0 ? 'light' : 'dark') + ' ' + groundClass(x, y);
      if (last && (samePos(last.from, x, y) || samePos(last.to, x, y))) sq.classList.add('last');
      if (samePos(selected, x, y)) sq.classList.add('selected');
      if (samePos(inspected, x, y)) sq.classList.add('inspected');
      if ((S.wards || []).some(w => chebyshev(w.x, w.y, x, y) <= 1)) sq.classList.add('ward-zone', 'ward-' + S.wards.find(w => chebyshev(w.x, w.y, x, y) <= 1).color);
      if ((S.swamps || []).some(w => chebyshev(w.x, w.y, x, y) <= 1)) sq.classList.add('swamp-zone');
      for (const w of S.castleWalls || []) {
        const seg = castleWallSegment(S, w);
        if (!seg) continue;
        const [ax, ay, bx, by] = seg;
        const between = ay === by ? (y === ay && x > Math.min(ax, bx) + 1 && x < Math.max(ax, bx) - 1)
          : (x === ax && y > Math.min(ay, by) + 1 && y < Math.max(ay, by) - 1);
        if (between) sq.insertAdjacentHTML('beforeend', `<div class="castle-wall-cell team-${w.color}"></div>`);
      }
      if (hasPos(targets, x, y)) sq.classList.add(AIM_CLASS[kind] || 'aim');
      else if (hasPos(area, x, y)) sq.classList.add(AREA_CLASS[kind] || 'area');

      const owner = S.territory[y][x];
      if (owner) sq.insertAdjacentHTML('beforeend', `<div class="terr ${owner}${isLockedSquare(x, y) ? ' locked' : ''}"></div>`);
      // 補給路：となりの補給路の方向に線をのばす
      const sup = S.supply[y][x];
      if (sup) {
        const arms = ['n', 's', 'e', 'w'].filter(side => {
          const [dx, dy] = screenDir(side);
          return inBounds(S.board, x + dx, y + dy) && S.supply[y + dy][x + dx] === sup;
        }).map(side => `<i class="${side}"></i>`).join('');
        sq.insertAdjacentHTML('beforeend', `<div class="route team-${sup}"><i class="c"></i>${arms}</div>`);
      }
      const ri = (tracePath.length ? tracePath : routePath).findIndex(p => p[0] === x && p[1] === y);
      if (ri >= 0) { sq.classList.add('route-path'); sq.insertAdjacentHTML('beforeend', `<span class="route-step">${ri + 1}</span>`); }
      for (const e of edges[x + ',' + y] || []) sq.insertAdjacentHTML('beforeend', `<div class="shield ${e.side} team-${e.color}"></div>`);
      // 旗の9マス：外周に壁（壊れていなければ）か城壁。中は旗の色で薄く塗る
      for (const f of S.flags || []) {
        if (chebyshev(f.x, f.y, x, y) > 1) continue;
        sq.classList.add('flag-zone', 'flag-' + f.color);
        if (!f.wall && !f.castle) continue;
        const sides = [];
        if (x === f.x - 1) sides.push('w'); if (x === f.x + 1) sides.push('e');
        if (y === f.y - 1) sides.push('n'); if (y === f.y + 1) sides.push('s');
        for (let side of sides) {
          if (flipped) side = { n: 's', s: 'n', e: 'w', w: 'e' }[side];
          sq.insertAdjacentHTML('beforeend', `<div class="barrier ${side} team-${f.color}${f.castle ? ' castle' : ''}"></div>`);
        }
      }
      // 罠・アラートは自分の側のものだけ見える
      if ((S.traps || []).some(t => (viewer() === 'all' || t.color === viewer() || watchedBy(S, viewer(), t.x, t.y)) && t.x === x && t.y === y)) sq.insertAdjacentHTML('beforeend', '<span class="trap">🪤</span>');
      const alert = (S.alerts || []).find(a => (viewer() === 'all' || a.color === viewer()) && chebyshev(a.x, a.y, x, y) <= 1);
      if (alert) {
        sq.classList.add('alert-zone');
        if (alert.x === x && alert.y === y) sq.insertAdjacentHTML('beforeend', '<span class="alert-icon">🔔</span>');
      }
      const desc = (S.descents || []).find(d => (viewer() === 'all' || d.color === viewer()) && d.spot && d.spot[0] === x && d.spot[1] === y);
      if (desc) sq.insertAdjacentHTML('beforeend', '<span class="descent-mark">🐉</span>');
      for (const c of ['w', 'b'])
        if (S.warps[c].some(w => w[0] === x && w[1] === y)) sq.insertAdjacentHTML('beforeend', `<span class="warp team-${c}">🌀</span>`);
      // 旗の真ん中：旗・城・築城中の表示
      if (S.scorched[y][x]) sq.classList.add('scorched');
      const zone = (S.oneways || []).find(z => chebyshev(z.x, z.y, x, y) <= 1);
      if (zone) {
        const d = flipped ? [-zone.dir[0], -zone.dir[1]] : zone.dir;
        sq.classList.add('oneway-zone');
        sq.insertAdjacentHTML('beforeend', `<span class="oneway-arrow">${{ '0,-1': '↑', '0,1': '↓', '1,0': '→', '-1,0': '←' }[d.join(',')]}</span>`);
      }
      const fz = fortressAt(S, x, y);
      if (fz) {
        sq.classList.add('sky', 'sky-' + fz.color);
        if (fz.x === x && fz.y === y) {
          const fac = Object.keys(fz.facilities).map(k => k === 'artemis' ? '🔭' : '🗼').join('');
          sq.insertAdjacentHTML('beforeend', `<span class="sky-icon">🏛️<b>${fz.hp}</b>${fac}${fz.building ? '🏗' : ''}</span>`);
        }
      }
      const flag = (S.flags || []).find(f => f.x === x && f.y === y);
      if (flag) {
        sq.insertAdjacentHTML('beforeend', `<span class="camp ${flag.color}">⚑</span>`);
        if (flag.castle) sq.insertAdjacentHTML('beforeend', `<span class="castle-icon">🏯<b>${flag.castle.hp}</b></span>`);
        if (flag.build) sq.insertAdjacentHTML('beforeend', `<span class="build-icon">🔨${flag.build.turnsLeft}</span>`);
      }
      const u = unitAt([x, y]);
      if (u) sq.insertAdjacentHTML('beforeend', unitHTML(u));
      if (u && hasBuff(u, 'burn')) { sq.classList.add('burning'); sq.insertAdjacentHTML('beforeend', '<span class="burn-mark">🔥</span>'); }
      if (u && squadIds.includes(u.id)) sq.classList.add('squad-member');
      // 移動先には「移動HPをいくつ使うか」を表示
      const reach = kind === 'move' && targets.find(p => p[0] === x && p[1] === y);
      if (reach) sq.insertAdjacentHTML('beforeend', `<span class="cost">-${reach[2]}${reach[4] ? '🌀' : ''}</span>`);
      if (col === 0) sq.insertAdjacentHTML('beforeend', `<span class="coord rank">${H - y}</span>`);
      if (row === H - 1) sq.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[x]}</span>`);
      sq.addEventListener('click', () => { if (!tracing) onSquare(x, y); });
      sq.addEventListener('pointerdown', () => { if (mode === 'move' && usesTrace(unitAt(selected)) && samePos(selected, x, y)) { tracing = true; tracePath = []; } });
      sq.addEventListener('mouseenter', (e) => {
        if (tracing && e.buttons === 1 && hasPos(traceNextSteps(S, selected, tracePath), x, y)) { tracePath.push([x, y]); render(); return; }
        hover = [x, y];
        // 盤を作り直すとクリックが取りこぼされるので、予告表示はクラスの付け替えだけにする
        updateHoverPreview();
        renderInfo();
      });
      boardEl.appendChild(sq);
    }
  }
  updateHoverPreview();
  renderMenu();
  renderStatus();
  renderInfo();
  renderLog();
}

// カーソルを乗せた場所の予告：範囲魔法・ブレスの9マス、ドラゴンチャージの範囲、陣形移動で一緒に動く味方
// 範囲を見てから「決定」するスキル（赤い範囲が出て、もう一度押すか「決定」で発動）
function needsConfirm(sk) {
  return ['blackblade', 'pierce', 'push', 'explosion', 'blueflame', 'ward', 'swamp'].includes(sk.kind) || (sk.aoe != null && sk.targetSquare);
}

function hoverPreviewSquares() {
  const sk = currentSkill();
  const hover = confirmTarget || window.hover; // 確認中はそのマスの範囲を出しっぱなしにする
  if (!sk || !hover) return [];
  const { targets, kind } = currentTargets();
  if (!hasPos(targets, hover[0], hover[1])) return [];
  if (sk.targetSquare && sk.aoe != null)
    return aoeSquares(S, hover[0], hover[1], sk).filter(([px, py]) => !(sk.notEnemyCamp && isEnemyCamp(S.turn, px, py)));
  const dir = [hover[0] - selected[0], hover[1] - selected[1]];
  if (sk.kind === 'push') return pushArea(S, selected[0], selected[1], dir, sk);
  if (sk.kind === 'pierce' || sk.kind === 'hook') return lineSquares(S, selected[0], selected[1], dir, sk.length);
  if (sk.kind === 'alert') return aoeSquares(S, hover[0], hover[1], sk);
  if (sk.kind === 'blueflame' || sk.kind === 'ward' || sk.kind === 'swamp') return aoeSquares(S, hover[0], hover[1], { aoe: 1 });
  if (sk.kind === 'blackblade') return lineSquares(S, selected[0], selected[1], dir, sk.length);
  if (sk.kind === 'explosion') return aoeSquares(S, hover[0], hover[1], { aoe: explosionRadius(unitAt(selected).ammo) });
  if (kind === 'oneway-pick') return aoeSquares(S, hover[0], hover[1], { aoe: 1 });
  if (kind === 'formation-pick') return formationMembers(S, S.turn, sk.shape, hover);
  return [];
}

function updateHoverPreview() {
  if (phase !== 'play') return;
  const W = boardWidth(S.board);
  const cls = currentSkill() && currentSkill().kind === 'formation' ? 'hover-group' : 'aoe-preview';
  for (const el of boardEl.querySelectorAll('.aoe-preview, .hover-group, .confirm-target')) el.classList.remove('aoe-preview', 'hover-group', 'confirm-target');
  for (const [x, y] of hoverPreviewSquares()) {
    const [col, row] = screenPos(x, y);
    const el = boardEl.children[row * W + col];
    if (el) el.classList.add(cls);
  }
  if (confirmTarget) {
    const [col, row] = screenPos(confirmTarget[0], confirmTarget[1]);
    const el = boardEl.children[row * W + col];
    if (el) el.classList.add('confirm-target');
  }
}

// 駒の HUD：右上 = HP / 左上 = 弾（魔力・矢など）/ 下中央 = 移動HP
function unitHTML(u) {
  const def = UNITS[u.type];
  const ratio = Math.max(0, u.hp / u.maxHp);
  const hpLevel = ratio > 0.6 ? 'high' : ratio > 0.3 ? 'mid' : 'low';
  // 自分の番で、もう命令できないキャラは暗くする
  const dim = u.color === S.turn && !S.winner && !canCommand(S, u);
  return `
    <div class="unit ${u.color === 'w' ? 'white' : 'black'}${dim ? ' done' : ''}${def.royal ? ' royal' : ''}${u.evo ? ' evolved' : ''}${hasBuff(u, 'stealth') ? ' stealth' : ''}">
      <span class="icon">${def.icon}</span>
    </div>
    <span class="badge hp ${hpLevel}" title="HP">${u.hp}</span>
    ${def.ammo ? `<span class="badge ammo" title="${def.ammo.name}">${u.ammo}</span>` : ''}
    ${def.charge ? chargeBadge(u, def) : ''}
    ${hasBuff(u, 'doom') ? '<span class="badge buff doom" title="即死の呪い">💀</span>'
      : hasBuff(u, 'burn') ? '<span class="badge buff burn" title="蒼炎">🔥</span>'
      : isBuilding(u) ? '<span class="badge buff snare" title="築城中：動けない・ダメージ2倍">🔨</span>'
      : isSnared(u) ? '<span class="badge buff snare" title="罠：動けない">⛓</span>'
      : u.buffs.some(b => !b.debuff && b.stat !== 'stealth') ? '<span class="badge buff" title="強化中">▲</span>' : ''}
    <span class="badge mhp${u.moveHp < stepCostOf(u) ? ' empty' : ''}" title="移動HP">${u.moveHp}</span>`;
}

// 龍呼びの巫女：祈りの回数、降臨待ちならあと何ターンか
function chargeBadge(u, def) {
  const d = pendingDescent(S, u.color);
  if (d) return `<span class="badge charge full" title="降臨まで">⏳${d.turns}</span>`;
  return `<span class="badge charge" title="${def.charge.name}">${u.charge}/${def.charge.max}</span>`;
}

// 選んだキャラの横に出る行動メニュー
function renderMenu() {
  const u = unitAt(selected);
  if (!u || locked() || !(canCommand(S, u) || canUsePassive(S, u))) { menuEl.classList.add('hidden'); return; }
  const [x, y] = selected;
  placeMenu();

  menuEl.innerHTML = '';
  // つまみ：ドラッグで好きな場所へ。ダブルクリックでキャラの横に戻す
  const grip = document.createElement('div');
  grip.className = 'menu-grip';
  grip.textContent = '⠿ ' + UNITS[u.type].name;
  grip.title = 'ドラッグで移動／ダブルクリックで元の位置に戻す';
  grip.addEventListener('pointerdown', startMenuDrag);
  grip.addEventListener('dblclick', () => { menuPos = null; saveMenuPos(); placeMenu(); });
  menuEl.appendChild(grip);
  const addBtn = (label, enabled, active, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = !enabled;
    if (active) b.classList.add('active');
    b.onclick = (e) => { e.stopPropagation(); onClick(); };
    menuEl.appendChild(b);
  };
  if (UNITS[u.type].move.type === 'route') {
    // 補給ナイト：1マスずつ道を決めて「決定」で進む
    if (mode === 'route' && routePath.length) {
      addBtn(`決定（移動HP -${routeCost(S, u, routePath)}）`, true, true, () => {
        const path = routePath;
        routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
        act(performRoute(S, selected, path), path[path.length - 1]);
      });
      addBtn('1マス戻す', true, false, () => { routePath.pop(); render(); });
    } else {
      addBtn('補給路を作る', canMove(S, x, y) && routeNextSteps(S, selected, []).length > 0, mode === 'route', () => { mode = 'route'; render(); });
    }
  } else if (mode === 'move' && usesTrace(u) && tracePath.length) {
    // なぞる移動：道を決めて「決定」
    addBtn(`決定（移動HP -${traceCost(S, u, tracePath)}）`, canEndTrace(S, selected, tracePath), true, () => {
      const path = tracePath;
      tracePath = [];
      act(performMovePath(S, selected, path), path[path.length - 1]);
    });
    addBtn('1マス戻す', true, false, () => { tracePath.pop(); render(); });
  } else {
    addBtn('移動', canMove(S, x, y) && moveTargets(S, x, y).length > 0, mode === 'move', () => { mode = 'move'; tracePath = []; render(); });
  }
  UNITS[u.type].skills.forEach((sk, i) => {
    const weak = u.moved && (sk.kind === 'damage' || sk.kind === 'push') && RULES.movedAttackRate < 1;
    const label = sk.name + (weak ? `（移動後 ×${RULES.movedAttackRate}）` : '') + (sk.passive ? '（行動1回）' : '');
    addBtn(label, (sk.passive ? canUsePassive(S, u) : canUseSkill(S, x, y)) && skillTargets(S, x, y, sk).length > 0, mode === i, () => {
      routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
      if (isSelfSkill(sk)) { act(performSkill(S, selected, selected, i), selected); return; }
      mode = i;
      render();
    });
  });
  if ((u.moved && !u.acted) || u.hitRunPending) addBtn(u.hitRunPending ? '待機（もう動かない）' : '待機', true, false, () => act(performWait(S, selected), selected));
  // 旗の9マスの中なら築城・修理
  for (const a of fortActions(S, x, y)) {
    addBtn(a.label, true, false, () => act(a.kind === 'build' ? performBuild(S, selected)
      : a.kind === 'wall' ? performWallBuild(S, selected, a.other) : performRepair(S, selected), selected));
  }
  // 蘇生の司祭：倒れた味方の名前が並ぶ（1試合に1回）
  for (const o of reviveOptions(S, x, y)) {
    const d = UNITS[o.g.unit.type];
    addBtn(`蘇生：${d.name}${o.g.unit.evo ? '★' : ''}`, reviveSquares(S, x, y).length > 0, mode === 'revive' && reviveGrave === o.i, () => {
      mode = 'revive'; reviveGrave = o.i; render();
    });
  }
  if (confirmTarget) {
    addBtn('決定', true, true, () => {
      const t = confirmTarget;
      confirmTarget = null;
      act(performSkill(S, selected, t, mode), selected);
    });
  }
  addBtn('やめる', true, false, deselect);
  const hint = menuHint();
  if (hint) menuEl.insertAdjacentHTML('beforeend', `<div class="menu-hint">${hint}</div>`);
  menuEl.classList.remove('hidden');
}

// メニューの位置：ドラッグした位置があればそこ、なければ選んだキャラの横
// 今どこを押せばいいかの案内
// 味方への攻撃か
function isAllyHit(sk, x, y) {
  const t = unitAt([x, y]);
  return !!sk && sk.kind === 'damage' && !!t && t.color === S.turn && !samePos(selected, x, y);
}

function menuHint() {
  const sk = currentSkill();
  if (confirmTarget && isAllyHit(sk, confirmTarget[0], confirmTarget[1])) return '味方を攻撃する？ よければもう一度同じ味方か「決定」。他を押すとやめる（反撃はされない）';
  if (confirmTarget) return '赤い範囲でよければ、もう一度同じマスか「決定」。他を押すとやめる';
  if (mode === 'move' && usesTrace(unitAt(selected))) return tracePath.length ? '続けて隣のマスを押す（ドラッグでもOK）→「決定」' : '隣のマスを押して道をなぞる（ドラッグでもOK）';
  if (mode === 'move') return '青いマスを押して移動';
  if (mode === 'revive') return '蘇らせるマスを押す';
  if (sk && sk.kind === 'hex') return '弱らせる敵を押す';
  if (sk && (sk.kind === 'ward' || sk.kind === 'swamp')) return '9マスの中心を押す';
  if (sk && sk.kind === 'haste') return '2回行動させる味方を押す';
  if (sk && sk.kind === 'siege') return 'たたく旗・砦・要塞の真ん中を押す';
  if (sk && sk.kind === 'catapult') return '撃つ相手か、旗・砦・要塞の真ん中を押す';
  if (sk && sk.kind === 'recall') return '呼び寄せる味方を押す';
  if (sk && sk.kind === 'facility') return sk.facility === 'artemis' ? '砲台を置く土台の端を押す（向きは外側）' : '建てる土台のマスを押す';
  if (sk && sk.kind === 'fortRepair') return '修理する建物を押す';
  if (mode === 'route') return routePath.length ? '続けて隣のマスを押す →「決定」' : '隣のマスを押して道を作る';
  if (!sk) return '';
  if (sk.kind === 'formation') return formationAnchor ? '青いマスを押して行き先を決める' : `動かす${sk.shape === 'row' ? '列の味方' : '9マスの中心'}を押す`;
  if (sk.kind === 'oneway') return formationAnchor ? '進める向き（中心の隣のマス）を押す' : '一方通行にする3×3の中心を押す';
  if (sk.kind === 'blueflame') return '燃やす旗の真ん中を押す';
  if (sk.kind === 'blackblade') return '向きを選ぶ（隣のマス）';
  if (sk.kind === 'transfer') return 'MPを渡す味方を押す';
  if (sk.kind === 'explosion') return '爆発の中心を押す（MPを全部使う）';
  if (sk.kind === 'doom') return sk.aoe != null ? '呪いの範囲の中心を押す' : '呪う相手を押す';
  if (sk.kind === 'fortressMove') return '動かす向き（要塞の隣）を押す';
  if (sk.kind === 'push' || sk.kind === 'pierce' || sk.kind === 'hook') return '向きを選ぶ（隣のマス）';
  if (sk.kind === 'trap') return '罠を置く隣のマスを押す';
  if (sk.kind === 'alert') return 'アラートの中心にするマスを押す';
  if (sk.kind === 'descentPoint') return 'バハムートが降りる陣営のマスを押す';
  if (sk.kind === 'rotate') return 'シールドを向ける方向を押す';
  if (sk.kind === 'warp') return 'ワープを置く自陣のマスを押す';
  if (sk.kind === 'spawn' || sk.kind === 'summon') return '産む／呼ぶマスを押す';
  if (sk.kind === 'squad') return '部隊に入れる虫を押す';
  if (sk.targetSquare) return '中心にするマスを押す';
  return '色のついたマスの相手を押す';
}

// 自分の足元にしか使えないスキル（祈り・範囲ヒールなど）は、マスを選ばずにすぐ使う
function isSelfSkill(sk) {
  if (sk.kind === 'facility') return sk.facility === 'turret' || sk.facility === 'expand';
  return ['charge', 'stealth', 'doomUp', 'fortressBuild', 'load'].includes(sk.kind) || (sk.range && sk.range.type === 'area' && sk.range.max === 0);
}

function placeMenu() {
  menuEl.style.right = menuEl.style.bottom = 'auto';
  if (menuPos) {
    menuEl.classList.add('floating');
    const r = menuEl.getBoundingClientRect();
    const left = Math.min(Math.max(0, menuPos.left), window.innerWidth - Math.max(r.width, 100));
    const top = Math.min(Math.max(0, menuPos.top), window.innerHeight - Math.max(r.height, 60));
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
    return;
  }
  menuEl.classList.remove('floating');
  const W = boardWidth(S.board), H = boardHeight(S.board);
  const [col, row] = screenPos(selected[0], selected[1]);
  // 下の方のマスならメニューを上向きに出す（盤からはみ出さないように）
  if (row < H - 3) menuEl.style.top = (row / H * 100) + '%';
  else { menuEl.style.bottom = ((H - row - 1) / H * 100) + '%'; menuEl.style.top = 'auto'; }
  if (col < W - 2) menuEl.style.left = ((col + 1) / W * 100) + '%';
  else { menuEl.style.right = ((W - col) / W * 100) + '%'; menuEl.style.left = 'auto'; }
}

function startMenuDrag(e) {
  e.preventDefault();
  const r = menuEl.getBoundingClientRect();
  const offX = e.clientX - r.left, offY = e.clientY - r.top;
  const move = (ev) => {
    menuPos = { left: ev.clientX - offX, top: ev.clientY - offY };
    placeMenu();
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    saveMenuPos();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function loadMenuPos() {
  try { return JSON.parse(localStorage.getItem('chess-tactics-menu-pos')); } catch (e) { return null; }
}
function saveMenuPos() {
  try { localStorage.setItem('chess-tactics-menu-pos', JSON.stringify(menuPos)); } catch (e) { /* 無視 */ }
}

function renderStatus() {
  if (S.winner) {
    statusEl.textContent = `キング撃破！ ${COLOR_NAME[S.winner]}の勝ち`;
    statusEl.className = 'status over';
  } else {
    statusEl.textContent = `${COLOR_NAME[S.turn]}のターン（${S.round}巡目）` + (cpuTurn() ? ' CPU 行動中…' : '') + (net ? netStatusText() : '');
    statusEl.className = 'status ' + (S.turn === 'w' ? 'turn-w' : 'turn-b');
  }
  pipsEl.innerHTML = `<span>動かせるキャラ</span>` + Array.from({ length: RULES.actionsPerTurn },
    (_, i) => `<i class="${i < S.actionsLeft ? 'on' : ''}"></i>`).join('') + `<b>${S.actionsLeft} / ${RULES.actionsPerTurn}</b>`;
  renderReinforce();
  territoryEl.innerHTML = `<div class="field-line">戦場：${FIELDS[S.field] || '草原'}</div>旗　<span class="tw">白 ${S.flags.filter(f => f.color === 'w').length}</span>　<span class="tb">黒 ${S.flags.filter(f => f.color === 'b').length}</span>　`
    + `陣地　<span class="tw">白 ${countTerritory(S, 'w')}</span>　<span class="tb">黒 ${countTerritory(S, 'b')}</span>`
    + (S.descents || []).map(d => `<div class="descent-line">${COLOR_NAME[d.color]}：${UNITS[d.unit].name}降臨まで あと ${d.turns} ターン</div>`).join('')
    + (S.respawns || []).map(r => `<div class="descent-line">${COLOR_NAME[r.color]}：${UNITS[r.type].name} 復活待ち（次の${COLOR_NAME[r.color]}のターン）</div>`).join('');
  endBtn.disabled = !!S.winner || locked();
  undoBtn.disabled = cpuBusy || history.length === 0 || !!net;
}

// ポイントと増援の一覧
function renderReinforce() {
  const el = document.getElementById('reinforce');
  const c = S.turn;
  let html = `<div class="points-line">ポイント　<span class="tw">白 ${S.points.w}</span>　<span class="tb">黒 ${S.points.b}</span>　<small>（毎ターン +${RULES.points.perTurn}）</small></div>`;
  if (!S.winner && !locked()) {
    html += `<details id="rf-details"${reinforceOpen ? ' open' : ''}><summary>増援を呼ぶ（1ターン1回・自分の陣地に出る）${S.reinforced[c] ? ' ― 今ターンは済み' : ''}</summary><div class="rf-list">`;
    for (const t of reinforceTypes()) {
      const def = UNITS[t], cost = reinforceCost(t);
      html += `<button class="rf-btn${reinforcePick === t ? ' active' : ''}" data-type="${t}" ${canReinforce(S, t) ? '' : 'disabled'}>${def.icon} ${def.name}<b>${cost}</b></button>`;
    }
    html += '</div></details>';
  }
  el.innerHTML = html;
  const det = document.getElementById('rf-details');
  if (det) det.addEventListener('toggle', () => { reinforceOpen = det.open; });
  for (const b of el.querySelectorAll('.rf-btn')) {
    b.onclick = () => { reinforcePick = reinforcePick === b.dataset.type ? null : b.dataset.type; selected = null; mode = null; render(); };
  }
}

function rangeText(skill) {
  if (skill.range.type === 'pattern') return '移動と同じ線上';
  if (skill.range.type === 'artemis') return `砲台の向きの扇形・${SKY.facilities.artemis.range}マス`;
  if (skill.range.type === 'territory') return '自陣のどこでも';
  if (skill.aoe != null && skill.targetSquare) return `${skill.range.max}マス以内の好きな場所の周囲9マス`;
  if (skill.aoe != null) return `自分の周囲${skill.aoe}マス全員`;
  const { min, max } = skill.range;
  return min === max ? `${max}マス` : `${min}〜${max}マス`;
}

// 旗（城）の情報
function flagInfo(pos) {
  const f = pos && flagAt(S, pos[0], pos[1]);
  if (!f) return '';
  const parts = [`${COLOR_NAME[f.color]}の旗（${squareName(S.board, f.x, f.y)}）`, f.wall ? '壁あり' : '壁なし'];
  if (f.castle) parts.push(`${f.castle.name} HP ${f.castle.hp}/${f.castle.maxHp}・修理あと${f.castle.repairs}回`);
  if (f.build) parts.push(`築城中 あと${f.build.turnsLeft}ターン`);
  return `<div class="info-flag">⚑ ${parts.join('　')}</div>`;
}

// 進化するとどうなるか
function evolutionText(u) {
  const def = UNITS[u.type], g = def.growth, r = def.respawn, ev = EVOLUTIONS[u.type];
  if (ev) {
    if (u.evolved) return `進化済み（${ev.name}）：${ev.text}`;
    const how = ev.by === 'kill' ? '敵を倒すと' : `スキルをあと${EVOLVE.skillUses - (u.skillUses || 0)}回使うと`;
    return `進化：${how}${ev.name}に（最大HP+${EVOLVE.maxHp}）→ ${ev.text}`;
  }
  if (g) {
    const left = g.max - u.evo;
    if (left <= 0) return '進化：もう最大まで進化した';
    return `進化：敵を倒すと HP+${g.heal} 回復・攻撃+${g.atk}・最大HP+${g.maxHp}（あと${left >= 90 ? '何' : left}回）→ 攻撃 ${effectiveAtk(u) + g.atk}・最大HP ${u.maxHp + g.maxHp}`;
  }
  if (r) return `復活で強化：倒されるたびに最大HP+${r.maxHp}・攻撃+${r.atk}（次は最大HP ${u.maxHp + r.maxHp}・攻撃 ${effectiveAtk(u) + r.atk}）`;
  return '進化：なし';
}

// キャラの今の状態を短い言葉で並べる
function statusList(u) {
  const list = [];
  if (u.color === S.turn && !S.winner) list.push(isDone(u) ? '行動済み' : hasStarted(u) ? '行動中' : '未行動');
  if (u.hp <= u.maxHp * 0.3) list.push('瀕死');
  if (hasBuff(u, 'stealth')) list.push('透明');
  if (isSnared(u)) list.push('罠で動けない');
  if (hasBuff(u, 'building')) list.push('築城中（無防備）');
  if (hasBuff(u, 'fortbuild')) list.push('建設中');
  if (hasBuff(u, 'rooted')) list.push('動けない');
  if (hasBuff(u, 'doom')) list.push('即死の呪い');
  if (hasBuff(u, 'burn')) list.push('炎上');
  if (hasBuff(u, 'nocounter')) list.push('反撃不可');
  if (hasBuff(u, 'slow')) list.push('鈍足');
  if (hasBuff(u, 'weaken')) list.push('攻撃力半減');
  if (hasBuff(u, 'immune')) list.push('遠距離無効');
  if (hasBuff(u, 'guard')) list.push('遠距離半減');
  if (hasBuff(u, 'loaded')) list.push('装填済み');
  if (u.extraAction || hasBuff(u, 'haste')) list.push('2回行動');
  if (u.evo) list.push(`進化★${u.evo}`);
  if ((S.recalls || []).some(r => r.unitId === u.id)) list.push('招集中');
  return list;
}

function renderInfo() {
  const pos = unitAt(hover) ? hover : unitAt(inspected) ? inspected : selected;
  const u = unitAt(pos);
  if (!u) {
    infoEl.innerHTML = flagInfo(hover) || '<p class="muted">キャラをクリックで選択、カーソルを合わせると詳細が出ます</p>';
    return;
  }
  const def = UNITS[u.type];
  const moveText = def.moveText || ({ points: '上下左右に歩く', none: '動かない' }[def.move.type] || 'チェスと同じ動き');
  const bar = (cls, label, now, max, extra = '') =>
    `<div class="info-bar ${cls}"><div class="fill" style="width:${now / max * 100}%"></div><span>${label} ${now} / ${max}${extra}</span></div>`;
  let state = '';
  if (u.color === S.turn && !S.winner) state = isDone(u) ? '行動済み' : hasStarted(u) ? '行動中' : canCommand(S, u) ? '行動可能' : '今ターンは動かせない';
  const atk = effectiveAtk(u);
  const skillText = (sk) => {
    if (sk.kind === 'rotate') return '前後左右から向きを選ぶ';
    if (sk.kind === 'hex') return `敵1体に「${sk.debuff.label}」を1ターン／射程 ${rangeText(sk)}・呪術は${sk.cooldown}ターンに1回`;
    if (sk.kind === 'ward') return `9マスを${sk.turns}ターン守る（相手は攻撃も侵入もできない）／${sk.cooldown}ターンに1回`;
    if (sk.kind === 'swamp') return `9マスを${sk.turns}ターン泥沼に（入るのに1マス2）／${def.ammo.name} ${sk.ammoCost}`;
    if (sk.kind === 'haste') return `味方1体をこのターン2回行動に／${sk.cooldown}ターンに1回`;
    if (sk.kind === 'siege') return `2マス以内の旗・砦・浮遊要塞に ${atk * def.siegeMult} ダメージ`;
    if (sk.kind === 'load') return '装填する（次のターンに発射できる）';
    if (sk.kind === 'catapult') return `装填した次のターンにタダで発射。6マス先まで射線なしで${atk}ダメージ、砦などには${atk * sk.fortMult}`;
    if (sk.kind === 'recall') return `味方1体を、次の自分のターンに目の前へ呼び寄せる／${sk.cooldown}ターンに1回`;
    if (sk.kind === 'blueflame') return `近くの旗・砦の9マスにいる全員を${sk.burn.turns}ターン燃やす（毎ターン${sk.burn.amount}）／${sk.cooldown}ターンに1回`;
    if (sk.kind === 'oneway') return `3×3を${sk.duration}ターン一方通行に。そのあいだ自分は動けず遠距離無効／${def.ammo.name} ${sk.ammoCost}`;
    if (sk.kind === 'blackblade') return `前後左右に幅1・長さ${sk.length}を破壊エリアに／${def.ammo.name} ${sk.ammoCost}・${sk.cooldown}ターンに1回`;
    if (sk.kind === 'transfer') return `近くの味方に MP を最大${sk.amount}渡す`;
    if (sk.kind === 'explosion') return `MPを全部使う。ダメージ = 使ったMP、範囲はMP10で5×5・20で7×7（今 MP ${u.ammo}）`;
    if (sk.kind === 'doom') return `HP ${Math.round(u.deathThreshold * 100)}% 以下の敵に即死の呪い${sk.aoe != null ? `（${2 * sk.aoe + 1}×${2 * sk.aoe + 1}）` : ''}／${def.ammo.name} ${sk.ammoCost}`;
    if (sk.kind === 'doomUp') return `即死の効くHP割合を +${Math.round(def.doom.step * 100)}%（最大${Math.round(def.doom.max * 100)}%）／ポイント ${sk.pointCost}・タダ`;
    if (sk.kind === 'fortressBuild') return `その場に魔導国家を建てる（${SKY.buildTurns}ターン動けない）`;
    if (sk.kind === 'fortressMove') return '魔導国家を1マス動かす（乗っているキャラも一緒）';
    if (sk.kind === 'facility') {
      const info = SKY.facilities[sk.facility];
      if (sk.facility === 'expand') return `土台を1マス広げる（n回目は ${info.turnsPer}n ターン・最大 ${2 * info.maxRadius + 1}×${2 * info.maxRadius + 1}）`;
      if (sk.facility === 'artemis') return `土台の端（角と真ん中以外）に砲台を建てる（${info.turns}ターン）。外向きの扇形にだけ撃てる・HP ${UNITS.artemisCannon.hp}`;
      if (sk.facility === 'generator') return `土台にエネルギー生成所を建てる（${info.turns}ターン）。毎ターン MP +${info.mpPerTurn}・HP ${UNITS.generator.hp}`;
      return `${info.name}を建てる（${info.turns}ターン）`;
    }
    if (sk.kind === 'fortRepair') return `土台の建物（砲台・生成所）を HP +${SKY.repairAmount} 修理`;
    if (sk.kind === 'warp') return '自陣にワープ地点を置く（2か所まで）';
    if (sk.kind === 'pierce') return `8方向のどれかへ一直線に${sk.length}マス、射線上の敵全員に${atk}ダメージ／${def.ammo.name} ${sk.ammoCost}`;
    if (sk.kind === 'hook') return `前後左右に${sk.length}マス先まで投げ、最初に当たったキャラを目の前に引き寄せる`;
    if (sk.kind === 'trap') return `隣のマスに罠（${sk.maxTraps}個まで）。踏んだ敵はそこで止まり、1ターン動けず反撃もできない`;
    if (sk.kind === 'alert') return `${sk.range.max}マス以内に置く。周囲9マスに入った敵の透明化を解く（1か所まで）`;
    if (sk.kind === 'stealth') return `${sk.turns}ターン相手から見えなくなる／${def.ammo.name} ${sk.ammoCost}`;
    if (sk.kind === 'descentPoint') return '降臨待ちのあいだ、バハムートが降りる陣営のマスを決める（タダ）';
    if (sk.kind === 'push') return `前後左右のどれかへ奥行き${sk.depth}・幅${sk.width}に${atk}ダメージ、範囲の全員（味方も）を奥行き${sk.pushTo}まで押し出す／${def.ammo.name} ${sk.ammoCost}`;
    if (sk.kind === 'spawn') return `隣に${UNITS[sk.unit].name}を産む${sk.free ? '（1ターン1回タダ・行動回数を使わない）' : `／${def.ammo.name} ${sk.ammoCost}`}`;
    if (sk.kind === 'squad') return `近くの虫を部隊に入れる／外す（${u.squad.length}/${def.squadMax}・タダ）`;
    if (sk.kind === 'charge') return `${def.charge.name}を1回（${def.charge.max}回で${def.charge.descendTurns}ターン後に${UNITS[def.charge.unit].name}降臨。続けなくてよい）`;
    if (sk.kind === 'summon') return `${def.charge.name}が${def.charge.max}たまったら、自分の陣営に${UNITS[sk.unit].name}を呼ぶ`;
    if (sk.kind === 'formation') return `好きな場所の${sk.shape === 'row' ? '横一列' : '9マス'}の味方をまとめて最大${sk.maxDist}マス${sk.guard ? `／${sk.guard.label}` : ''}${sk.passive ? '／使うたびに行動回数を1使う。レオニダスが行動済みでも、行動回数が残っていれば何回でも使える' : ''}`;
    if (sk.kind === 'cleanse') return `弱体化を解除／射程 ${rangeText(sk)}`;
    if (sk.kind === 'buff') return `攻撃力 +${sk.buff.amount}（${sk.buff.turns}ターン）／射程 ${rangeText(sk)}`;
    const label = sk.kind === 'heal' ? '回復' : '攻撃';
    return `${label} ${sk.power ?? atk}／射程 ${rangeText(sk)}${sk.ammoCost ? `／${def.ammo.name} ${sk.ammoCost}` : ''}`;
  };
  const skills = def.skills.map(sk => effSkill(u, sk)).map(sk => `<li><b>${sk.name}</b> ${skillText(sk)}</li>`).join('');
  const buffs = u.buffs.map(b => `${b.debuff ? '弱体' : '強化'}：${b.label}（残り${b.turns}ターン）`).join('<br>');
  infoEl.innerHTML = `
    <div class="info-head"><span class="info-icon ${u.color === 'w' ? 'white' : 'black'}">${def.icon}</span>
      <div><div class="info-name">${COLOR_NAME[u.color]}の${unitName(u)}${def.royal ? '（倒されたら負け）' : ''}</div>
      ${def.leader ? `<div class="muted">${def.leader.family}系・${def.leader.ability}</div>` : ''}
      <div class="muted">${squareName(S.board, pos[0], pos[1])}　${state}</div></div></div>
    ${bar('hp', 'HP', u.hp, u.maxHp)}
    ${bar('mhp', '移動HP', u.moveHp, def.moveHp, `（毎ターン +${def.moveRegen ?? RULES.moveHpRegen}）`)}
    ${def.ammo ? bar('ammo', def.ammo.name, u.ammo, u.ammoMax || def.ammo.max, `（毎ターン +${def.ammo.regen}）`) : ''}
    ${def.charge ? bar('charge', def.charge.name, u.charge, def.charge.max, u.charge >= def.charge.max ? '（召喚できる）' : '') : ''}
    <div class="info-stats">攻撃力 ${atk}${atk !== def.atk ? `（基本 ${def.atk}）` : ''}　／　${moveText}（1マス 移動HP ${stepCostOf(u)}・速度 ${unitSpeed(u.type)}）</div>
    ${Object.keys(u.cooldowns || {}).length ? `<div class="info-buffs">使えるまで：${Object.entries(u.cooldowns).map(([k, v]) => `${k} ${v}ターン`).join('・')}</div>` : ''}
    <div class="info-status"><b>状態</b>　${statusList(u).join('・') || 'ふつう'}</div>
    ${buffs ? `<div class="info-buffs">${buffs}</div>` : ''}
    ${u.moved && !u.acted && u.color === S.turn && RULES.movedAttackRate < 1 ? `<div class="info-buffs">移動したので、このターンの攻撃はダメージ ×${RULES.movedAttackRate}</div>` : ''}
    ${u.evo ? `<div class="info-buffs">進化 ★${u.evo}（攻撃 +${u.atkBonus}・最大HP ${u.maxHp}）</div>` : ''}
    <div class="info-evo">${evolutionText(u)}</div>
    ${def.structure && u.repairs != null ? `<div class="info-stats">修理あと ${u.repairs} 回</div>` : ''}
    <ul class="info-skills">${skills}</ul>
    ${def.note ? `<div class="info-note">${def.note}</div>` : ''}
    ${flagInfo(pos)}`;
}

function renderLog() {
  logEl.innerHTML = S.log.slice(-200).map(e =>
    `<li class="${e.color === 'w' ? 'log-w' : e.color === 'b' ? 'log-b' : 'log-sys'}">${e.text}</li>`).join('');
  logEl.scrollTop = logEl.scrollHeight;
}

// ダメージ・回復の数字を浮かび上がらせる
// 盤の上に大きな文字を出す（バハムート降臨など）
function showBanner(text) {
  const el = document.createElement('div');
  el.className = 'banner';
  el.textContent = text;
  document.querySelector('.board-wrap').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function showEffects(effects) {
  for (const e of effects || []) if (e.kind === 'banner') showBanner(e.text);
  const W = boardWidth(S.board);
  for (const e of effects || []) {
    const [col, row] = screenPos(e.x, e.y);
    const sq = boardEl.children[row * W + col];
    if (!sq) continue;
    if (e.kind === 'damage') sq.classList.add('hit');
    const d = document.createElement('div');
    d.className = 'fx ' + e.kind;
    d.textContent = e.text;
    sq.appendChild(d);
    setTimeout(() => d.remove(), 1000);
  }
}

// ---------------------------------------------------------------------
//  操作
// ---------------------------------------------------------------------
function deselect() { selected = null; mode = null; routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null; reinforcePick = null; render(); }

function defaultMode(x, y) {
  if (UNITS[S.board[y][x].type].move.type === 'route') {
    if (canMove(S, x, y) && routeNextSteps(S, [x, y], []).length) return 'route';
  } else if (canMove(S, x, y) && moveTargets(S, x, y).length) return 'move';
  if (canUseSkill(S, x, y)) {
    // 最初から選ぶスキルは、味方しか狙えない攻撃は除く（味方を押したら攻撃になってしまうので）
    const color = S.board[y][x].color;
    const i = UNITS[S.board[y][x].type].skills.findIndex(sk => skillTargets(S, x, y, sk)
      .some(([tx, ty]) => sk.kind !== 'damage' || !S.board[ty][tx] || S.board[ty][tx].color !== color));
    if (i >= 0) return i;
  }
  return null; // 恒常スキルはボタンで選ぶ
}

function onSquare(x, y) {
  if (locked() || S.winner) {
    inspected = unitAt([x, y]) ? [x, y] : null; // 観戦中・CPU の番でも、押せばそのキャラの詳しい状態が見える
    render();
    return;
  }
  inspected = null;
  // 増援：選んだキャラを自分の陣地に出す
  if (reinforcePick) {
    const type = reinforcePick;
    reinforcePick = null;
    if (hasPos(reinforceSquares(S, S.turn), x, y)) { act(performReinforce(S, type, x, y), [x, y]); return; }
    render();
    return;
  }
  // 補給路づくり：となりのマスを押すと1マス進む、最後のマスを押すと1マス戻る
  if (mode === 'revive' && hasPos(currentTargets().targets, x, y)) {
    const g = reviveGrave;
    reviveGrave = null;
    act(performRevive(S, selected, g, [x, y]), selected);
    return;
  }
  if (mode === 'move' && usesTrace(unitAt(selected))) {
    const last = tracePath[tracePath.length - 1];
    if (samePos(last, x, y)) {
      // 最後のマスをもう一度押す：止まれるなら決定、だめなら1マス戻す
      if (canEndTrace(S, selected, tracePath)) { const path = tracePath; tracePath = []; act(performMovePath(S, selected, path), path[path.length - 1]); }
      else { tracePath.pop(); render(); }
      return;
    }
    if (hasPos(currentTargets().targets, x, y)) { tracePath.push([x, y]); render(); return; }
    if (tracePath.length) return; // 作りかけの道があるときは他を押しても消さない
  }
  if (mode === 'route') {
    const lastStep = routePath[routePath.length - 1];
    if (samePos(lastStep, x, y)) { routePath.pop(); render(); return; }
    if (hasPos(currentTargets().targets, x, y)) { routePath.push([x, y]); render(); return; }
    if (routePath.length) return; // 作りかけの道があるときは他のマスを押しても消さない
  }
  const sk = currentSkill();
  if (sk && sk.kind === 'oneway') {
    const { targets } = currentTargets();
    if (!formationAnchor && hasPos(targets, x, y)) { formationAnchor = [x, y]; render(); return; }
    if (formationAnchor && hasPos(targets, x, y)) {
      const [ax, ay] = formationAnchor;
      formationAnchor = null; confirmTarget = null;
      act(performSkill(S, selected, [ax, ay, x - ax, y - ay], mode), selected);
      return;
    }
  }
  if (sk && sk.kind === 'formation') {
    const { targets } = currentTargets();
    if (!formationAnchor && hasPos(targets, x, y)) { formationAnchor = [x, y]; render(); return; }
    if (formationAnchor && hasPos(targets, x, y)) {
      const anchor = formationAnchor;
      formationAnchor = null; confirmTarget = null;
      act(performFormation(S, selected, mode, anchor, [x, y]), selected);
      return;
    }
    // 別の基準を選び直す
    if (formationAnchor && formationAnchors(S, S.turn, sk.shape).some(p => p[0] === x && p[1] === y)) {
      formationAnchor = [x, y]; render(); return;
    }
  }
  if (selected && mode !== null && hasPos(currentTargets().targets, x, y)) {
    if (mode === 'move') {
      const t = currentTargets().targets.find(p => p[0] === x && p[1] === y);
      act(performMove(S, selected, [x, y]), t[4] || [x, y]); // ゲートに入ったら出口の位置
      return;
    }
    // 範囲スキル：1回目は赤い範囲を出すだけ。同じマスをもう一度押すと発動
    // 範囲スキルと、味方への攻撃は確認する（味方を選ぶつもりで押してしまわないように）
    if ((needsConfirm(sk) || isAllyHit(sk, x, y)) && !samePos(confirmTarget, x, y)) { confirmTarget = [x, y]; render(); return; }
    confirmTarget = null;
    act(performSkill(S, selected, [x, y], mode), selected);
    return;
  }
  // スキルを選んでいるときに対象でないところを押したら、スキルをやめて移動に戻る
  if (typeof mode === 'number' && unitAt(selected) && !(unitAt([x, y]) && !samePos(selected, x, y))) {
    routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
    mode = canMove(S, selected[0], selected[1]) ? defaultMode(selected[0], selected[1]) : null;
    if (mode !== null && typeof mode === 'number') mode = null; // 移動できないなら何も選ばない
    render();
    return;
  }
  routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
  if (unitAt([x, y]) && !samePos(selected, x, y)) {
    selected = [x, y];
    mode = defaultMode(x, y);
  } else {
    selected = null;
    mode = null;
  }
  render();
}

// 行動を確定する。unitPos は行動後のキャラの位置
function act(next, unitPos) {
  history.push(S);
  S = next;
  // まだ同じキャラで行動できる（移動後にスキルが使える設定など）なら選んだままにする
  const u = unitAt(unitPos);
  if (u && (canCommand(S, u) || canUsePassive(S, u))) { selected = unitPos; mode = defaultMode(unitPos[0], unitPos[1]); }
  else { selected = null; mode = null; }
  render();
  showEffects(S.effects);
  if (net) netSendState();
  runCpu();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runCpu() {
  if (cpuBusy) return;
  cpuBusy = true;
  while (cpuTurn()) {
    render();
    await sleep(cpuDelay);
    if (!cpuTurn()) break; // 待っている間に新しいゲームなどが押された
    const a = cpuChooseAction(S);
    history.push(S);
    S = a ? applyCpuAction(S, a) : endTurn(S);
    selected = null;
    mode = null;
    render();
    showEffects(S.effects);
  }
  cpuBusy = false;
  render();
}

endBtn.onclick = () => {
  if (S.winner || locked()) return;
  history.push(S);
  S = endTurn(S);
  selected = null; mode = null;
  render();
  showEffects(S.effects);
  if (net) netSendState();
  runCpu();
};

undoBtn.onclick = () => {
  if (cpuBusy || !history.length || net) return;
  S = history.pop();
  // CPU 対戦中は自分の番まで戻す
  while (cpuEnabled && S.turn === CPU_COLOR && history.length) S = history.pop();
  selected = null; mode = null; routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
  render();
};

// 新しいゲーム（観戦中でも押せる。CPU は次の手の前に止まる）
document.getElementById('btn-new').onclick = () => {
  if (net) { netRestart(); return; }
  startSetup();
  setMode(playMode);
};

document.getElementById('btn-flip').onclick = () => { flipped = !flipped; render(); };

document.getElementById('cpu-toggle').onchange = (e) => {
  cpuEnabled = e.target.checked;
  render();
  runCpu();
};

// ---------------------------------------------------------------------
//  デッキ構築（試合前の配置）
// ---------------------------------------------------------------------
const setupPanel = document.getElementById('setup-panel');
const playPanel = document.getElementById('play-panel');
const paletteEl = document.getElementById('palette');
const setupMsgEl = document.getElementById('setup-msg');
const readyBtn = document.getElementById('btn-ready');

function loadDeck(color) {
  try {
    const d = JSON.parse(localStorage.getItem('chess-tactics-deck-' + color));
    if (d && deckErrors(d, color).length === 0) return d;
  } catch (e) { /* 保存できない環境でもそのまま遊べる */ }
  return defaultDeck(color);
}
function saveDeck(color) {
  try { localStorage.setItem('chess-tactics-deck-' + color, JSON.stringify(decks[color])); } catch (e) { /* 無視 */ }
}

function startSetup() {
  phase = 'setup';
  spectate = false;
  setupColor = 'w';
  flipped = false;
  pick = null;
  selected = null; mode = null; routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
  setupPanel.classList.remove('hidden');
  playPanel.classList.add('hidden');
  menuEl.classList.add('hidden');
  render();
}

// gameDecks を渡すとそのデッキで始める（観戦用。自分のデッキは上書きしない）
function startGame(gameDecks) {
  phase = 'play';
  flipped = false;
  S = createInitialState(gameDecks || decks);
  S.field = pickField();
  history = [];
  if (net && net.color === 'b') flipped = true;
  selected = null; mode = null; routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
  setupPanel.classList.add('hidden');
  playPanel.classList.remove('hidden');
  render();
  runCpu();
}

// ランダム編成：枠の数はチェスと同じ、置く場所も陣営の中でランダム
function randomDeck(color) {
  const squares = [];
  for (let y = 0; y < boardHeight(S.board); y++)
    for (let x = 0; x < boardWidth(S.board); x++) if (isCampOf(color, x, y)) squares.push(x + ',' + y);
  squares.sort(() => Math.random() - 0.5);
  for (let tries = 0; tries < 50; tries++) {
    const deck = {};
    let i = 0;
    for (const [role, info] of Object.entries(ROLES)) {
      const pool = Object.keys(UNITS).filter(t => UNITS[t].role === role && !UNITS[t].summonOnly);
      for (let n = 0; n < info.count; n++) deck[squares[i++]] = pool[Math.floor(Math.random() * pool.length)];
    }
    if (!deckErrors(deck, color).length) return deck;
  }
  return defaultDeck(color);
}

// CPU 同士の対戦を観戦する
// option: 'default' = 両方おまかせ / 'random' = 両方ランダム / 'mine' = 白は自分のデッキ・黒はランダム
function startSpectate(option) {
  spectate = true;
  const d = option === 'random' ? { w: randomDeck('w'), b: randomDeck('b') }
    : option === 'mine' ? { w: decks.w, b: randomDeck('b') }
    : { w: defaultDeck('w'), b: defaultDeck('b') };
  startGame(d);
}

function deckCount(type) {
  return Object.values(decks[setupColor]).filter(t => t === type).length;
}

function renderSetup() {
  const W = boardWidth(S.board), H = boardHeight(S.board);
  const deck = decks[setupColor];
  boardEl.style.gridTemplateColumns = `repeat(${W}, 1fr)`;
  boardEl.style.gridTemplateRows = `repeat(${H}, 1fr)`;
  boardEl.style.aspectRatio = `${W} / ${H}`;
  boardEl.innerHTML = '';
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const [x, y] = flipped ? [W - 1 - col, H - 1 - row] : [col, row];
      const sq = document.createElement('div');
      sq.className = 'sq ' + ((x + y) % 2 === 0 ? 'light' : 'dark') + ' ' + groundClass(x, y);
      if (isCampOf(setupColor, x, y)) sq.classList.add('slot');
      else if (isEnemyCamp(setupColor, x, y)) sq.classList.add('enemy-slot');
      const type = deck[x + ',' + y];
      if (type) sq.insertAdjacentHTML('beforeend', unitHTML(makeUnit(type, setupColor)));
      if (col === 0) sq.insertAdjacentHTML('beforeend', `<span class="coord rank">${H - y}</span>`);
      if (row === H - 1) sq.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[x]}</span>`);
      sq.addEventListener('click', () => onSetupSquare(x, y));
      sq.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); removeFromDeck(x, y); });
      boardEl.appendChild(sq);
    }
  }

  const title = document.getElementById('setup-title');
  const speed = Object.values(deck).reduce((n, t) => n + unitSpeed(t), 0);
  title.textContent = `${COLOR_NAME[setupColor]}のデッキ（${Object.keys(deck).length} 体・移動速度の合計 ${speed}）`;
  title.className = 'status ' + (setupColor === 'w' ? 'turn-w' : 'turn-b');

  // キャラ一覧：枠（キング・クイーン・ルーク・ビショップ・ナイト・ポーン）ごと
  paletteEl.innerHTML = '';
  for (const [role, info] of Object.entries(ROLES)) {
    const used = roleCount(deck, role);
    paletteEl.insertAdjacentHTML('beforeend',
      `<div class="pal-role${used === info.count ? ' full' : ''}">${info.name} <b>${used} / ${info.count}</b></div>`);
    for (const type of Object.keys(UNITS).filter(t => UNITS[t].role === role)) {
      const def = UNITS[type];
      const b = document.createElement('button');
      b.className = 'pal' + (pick === type ? ' active' : '') + (def.royal ? ' royal' : '');
      const atMax = def.deckMax != null && deckCount(type) >= def.deckMax; // めぐみん・山の翁は1体まで
      b.disabled = (used >= info.count || atMax) && pick !== type;
      b.innerHTML = `<span class="pal-icon">${def.icon}</span>
        <span class="pal-body"><b>${def.name}</b>${def.leader ? `<small>${def.leader.family}系・${def.leader.ability}</small>` : ''}
        <small>HP ${def.hp}／攻撃 ${def.atk}／移動HP ${def.moveHp}／速度 ${unitSpeed(type)}${def.ammo ? `／${def.ammo.name} ${def.ammo.max}` : ''}</small></span>
        <span class="pal-count">${deckCount(type)}</span>`;
      b.title = def.note || '';
      b.onclick = () => { pick = pick === type ? null : type; render(); };
      paletteEl.appendChild(b);
    }
  }

  const errors = deckErrors(deck, setupColor);
  setupMsgEl.innerHTML = errors.length ? errors.map(e => `<div>⚠ ${e}</div>`).join('') : '<div class="ok">準備OK</div>';
  readyBtn.disabled = errors.length > 0;
  readyBtn.textContent = net ? (net.deckSent ? '相手の配置を待っています…' : '配置完了 → 相手を待つ')
    : setupColor === 'w' && !cpuEnabled ? '配置完了 → 黒の番へ' : '配置完了 → 試合開始';
  if (net && net.deckSent) readyBtn.disabled = true;
}

function onSetupSquare(x, y) {
  if (!isCampOf(setupColor, x, y)) return;
  const deck = decks[setupColor], key = x + ',' + y;
  if (pick) {
    // 枠がいっぱいなら置けない（同じ枠のキャラと入れ替えるのは OK）
    const role = UNITS[pick].role, info = ROLES[role];
    const replacing = deck[key] && UNITS[deck[key]].role === role ? 1 : 0;
    if (roleCount(deck, role) - replacing >= info.count) return;
    const max = UNITS[pick].deckMax;
    if (max != null && deckCount(pick) - (deck[key] === pick ? 1 : 0) >= max) return;
    deck[key] = pick;
    if (roleCount(deck, role) >= info.count) pick = null;
  } else if (deck[key]) {
    pick = deck[key]; // 持ち上げて別のマスに置き直せる
    delete deck[key];
  }
  render();
}

function removeFromDeck(x, y) {
  delete decks[setupColor][x + ',' + y];
  render();
}

// ---------------------------------------------------------------------
//  モード選択：1人で遊ぶ（CPUと対戦）／2人で遊ぶ／観戦（CPU同士）
// ---------------------------------------------------------------------
let playMode = 'cpu';
try { playMode = localStorage.getItem('chess-tactics-mode') || 'cpu'; } catch (e) { /* 保存できない環境 */ }

function setMode(m) {
  playMode = m;
  try { localStorage.setItem('chess-tactics-mode', m); } catch (e) { /* 無視 */ }
  cpuEnabled = m === 'cpu';
  document.getElementById('cpu-toggle').checked = cpuEnabled;
  for (const b of document.querySelectorAll('.mode-select button')) b.classList.toggle('active', b.dataset.mode === m);
  document.getElementById('deck-builder').classList.toggle('hidden', m === 'watch' || (m === 'net' && !net));
  document.getElementById('watch-panel').classList.toggle('hidden', m !== 'watch');
  document.getElementById('net-panel').classList.toggle('hidden', m !== 'net');
  if (m !== 'net' && net) netLeave();
  if (setupColor === 'b' && m !== 'pvp' && !net) { setupColor = 'w'; flipped = false; } // 2人用で黒の番だったら白に戻す
  render();
}
for (const b of document.querySelectorAll('.mode-select button')) b.onclick = () => setMode(b.dataset.mode);

document.getElementById('btn-watch').onclick = () => {
  const opt = document.querySelector('input[name="watch-deck"]:checked').value;
  const speed = document.getElementById('watch-speed').value;
  cpuDelay = Number(speed);
  document.getElementById('cpu-speed').value = speed;
  startSpectate(opt);
};
const fieldSelect = document.getElementById('field-select');
fieldSelect.value = fieldChoice;
fieldSelect.onchange = (e) => {
  fieldChoice = e.target.value;
  try { localStorage.setItem('chess-tactics-field', fieldChoice); } catch (err) { /* 無視 */ }
  render();
};
document.getElementById('btn-random').onclick = () => { decks[setupColor] = randomDeck(setupColor); pick = null; render(); };
document.getElementById('cpu-speed').onchange = (e) => { cpuDelay = Number(e.target.value); };
document.getElementById('btn-default').onclick = () => { decks[setupColor] = defaultDeck(setupColor); pick = null; render(); };
document.getElementById('btn-clear').onclick = () => { decks[setupColor] = {}; pick = null; render(); };
readyBtn.onclick = () => {
  if (deckErrors(decks[setupColor], setupColor).length) return;
  saveDeck(setupColor);
  pick = null;
  if (net) { netSendDeck(); return; }
  if (setupColor === 'w' && !cpuEnabled) {
    setupColor = 'b';
    flipped = true; // 黒は自分の陣営が手前に来るように
    render();
    return;
  }
  if (cpuEnabled) decks.b = defaultDeck('b');
  startGame();
};

boardEl.addEventListener('mouseleave', () => { hover = null; renderInfo(); });
// なぞる移動：ドラッグを離したら、止まれる道ならそのまま決定
document.addEventListener('pointerup', () => {
  if (!tracing) return;
  setTimeout(() => { tracing = false; }, 0);
  if (tracePath.length && canEndTrace(S, selected, tracePath)) { const path = tracePath; tracePath = []; act(performMovePath(S, selected, path), path[path.length - 1]); }
  else render();
});
document.getElementById('move-input').value = moveInput;
document.getElementById('move-input').onchange = (e) => {
  moveInput = e.target.value;
  try { localStorage.setItem('chess-tactics-move-input', moveInput); } catch (err) { /* 無視 */ }
  tracePath = [];
  render();
};
boardEl.addEventListener('contextmenu', (e) => { e.preventDefault(); if (phase === 'play') deselect(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && phase === 'play') deselect(); });

startSetup();
setMode(playMode);
