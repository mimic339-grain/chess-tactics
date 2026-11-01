// =====================================================================
//  ネット対戦：合言葉の部屋で、白（部屋を作った人）と黒（入った人）が戦う
//  自分のサーバーはいらない。ブラウザ同士を PeerJS（WebRTC）で直接つなぐ
//  部屋を作った人のブラウザが部屋の持ち主になり、デッキと盤面を全員に配る
//  行動した側が、行動のたびに盤面を丸ごと送る
// =====================================================================
const netLobbyEl = document.getElementById('net-lobby');
const netRoomEl = document.getElementById('net-room');
const netMsgEl = document.getElementById('net-msg');
const netErrorEl = document.getElementById('net-error');
const PEER_PREFIX = 'chess-tactics-room-';
let peer = null;      // 自分の PeerJS
let hostRoom = null;  // 部屋の持ち主だけが持つ部屋の中身
let hostConns = [];   // 部屋の持ち主：つながっている相手
let hostConn = null;  // 入った人：部屋の持ち主へのつながり
let netGen = 0;       // 部屋を出たら古いつながりの処理を止める

function netShowError(msg) { netErrorEl.innerHTML = msg ? `<div>⚠ ${msg}</div>` : ''; }

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 見間違えやすい I O 0 1 は使わない
  return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

// このタブの名札（読み込み直しても同じ色に戻れるように）
function netCid() {
  let cid = null;
  try { cid = sessionStorage.getItem('chess-tactics-cid'); } catch (e) { /* 無視 */ }
  if (!cid) {
    cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('chess-tactics-cid', cid); } catch (e) { /* 無視 */ }
  }
  return cid;
}

function peerReady() {
  if (typeof Peer === 'undefined') { netShowError('通信の部品を読み込めませんでした。ネットにつながっているか確かめてください'); return false; }
  return true;
}

// ---------------------------------------------------------------------
//  部屋の持ち主（白）
// ---------------------------------------------------------------------
function netCreate(resume) {
  if (!peerReady()) return;
  const gen = ++netGen;
  const code = resume ? resume.code : newCode();
  let tries = 0;
  const open = () => {
    const p = new Peer(PEER_PREFIX + code);
    p.on('open', () => {
      if (gen !== netGen) { p.destroy(); return; }
      peer = p;
      hostRoom = resume ? resume.room : { version: 0, decks: {}, state: null, joined: { w: true, b: false }, watchers: 0, members: {} };
      hostConns = [];
      if (!resume || !net) netEnter(code, 'w', true);
      hostPublish();
    });
    p.on('connection', (conn) => hostAccept(conn, gen));
    p.on('error', (e) => {
      if (gen !== netGen) return;
      if (e.type === 'unavailable-id') {
        p.destroy();
        // 読み込み直した直後は前のつながりが残っていることがあるので少し待ってやり直す
        if (resume && ++tries < 10) { netMsgEl.textContent = '部屋をつなぎ直しています…'; setTimeout(open, 3000); return; }
        if (!resume) { netCreate(); return; } // 合言葉がかぶったら作り直す
      }
      if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') netMsgEl.textContent = '通信できません。ネットのつながりを確かめてください';
      else if (!net) netShowError('部屋を作れませんでした（' + e.type + '）');
    });
    p.on('disconnected', () => { if (gen === netGen && !p.destroyed) p.reconnect(); });
  };
  open();
}

function hostAccept(conn, gen) {
  conn.on('data', (msg) => { if (gen === netGen) hostHandle(conn, msg); });
  conn.on('close', () => { hostConns = hostConns.filter(c => c !== conn); });
}

function hostHandle(conn, msg) {
  const r = hostRoom;
  if (!r || !msg) return;
  if (msg.type === 'hello') {
    // 2人目が黒、3人目からは観戦。前に入ったことのある人は同じ色に戻す
    let color = r.members[msg.cid];
    if (!color) {
      if (!r.joined.b) { color = 'b'; r.joined.b = true; } else { color = 'watch'; r.watchers++; }
      r.members[msg.cid] = color;
    }
    conn.color = color;
    hostConns = hostConns.filter(c => c !== conn).concat(conn);
    conn.send({ type: 'welcome', color });
    hostPublish();
    return;
  }
  if (msg.type === 'deck' && (conn.color === 'w' || conn.color === 'b')) r.decks[conn.color] = msg.deck;
  else if (msg.type === 'state' && conn.color !== 'watch') r.state = msg.state;
  else if (msg.type === 'reset' && conn.color !== 'watch') { r.state = null; r.decks = {}; }
  else return;
  hostPublish();
}

// 部屋の中身が変わったら、全員（自分も）に配る
function hostPublish() {
  const r = hostRoom;
  r.version++;
  const view = { version: r.version, decks: r.decks, state: r.state, joined: r.joined, watchers: r.watchers };
  for (const c of hostConns) if (c.open) c.send({ type: 'room', room: view });
  try { sessionStorage.setItem('chess-tactics-host', JSON.stringify({ code: net && net.code, room: r })); } catch (e) { /* 無視 */ }
  setTimeout(() => netOnRoom(view), 0);
}

// ---------------------------------------------------------------------
//  部屋に入る人（黒・観戦）
// ---------------------------------------------------------------------
function netJoin(code) {
  code = String(code || '').toUpperCase().trim();
  if (!code) return;
  if (!peerReady()) return;
  const gen = ++netGen;
  netShowError('');
  const p = new Peer();
  peer = p;
  const connect = () => {
    if (gen !== netGen) return;
    const c = p.connect(PEER_PREFIX + code, { reliable: true });
    hostConn = c;
    c.on('open', () => c.send({ type: 'hello', cid: netCid() }));
    c.on('data', (msg) => {
      if (gen !== netGen || !msg) return;
      if (msg.type === 'welcome') { if (!net || net.code !== code) netEnter(code, msg.color, false); else net.color = msg.color; }
      else if (msg.type === 'room') netOnRoom(msg.room);
    });
    c.on('close', () => {
      if (gen !== netGen || !net) return;
      netMsgEl.textContent = '部屋の持ち主との通信が切れました。つなぎ直しています…';
      setTimeout(connect, 3000);
    });
  };
  p.on('open', connect);
  p.on('error', (e) => {
    if (gen !== netGen) return;
    if (e.type === 'peer-unavailable') {
      if (net) { netMsgEl.textContent = '部屋の持ち主が見つかりません。つなぎ直しています…'; setTimeout(connect, 3000); }
      else netShowError('その合言葉の部屋はありません（部屋を作った人がページを閉じると部屋は消えます）');
    } else netShowError('つながりませんでした（' + e.type + '）');
  });
  p.on('disconnected', () => { if (gen === netGen && !p.destroyed) p.reconnect(); });
}

// 部屋の持ち主に送る（自分が持ち主なら直接変える）
function netSend(msg) {
  if (hostRoom) { hostHandle({ color: 'w', send() {} }, msg); return; }
  if (hostConn && hostConn.open) hostConn.send(msg);
  else netMsgEl.textContent = '送れませんでした。つなぎ直しているところです';
}

// ---------------------------------------------------------------------
//  部屋の中身を画面に反映する
// ---------------------------------------------------------------------
// 部屋に入った（作った）あと：自分の側のデッキを組む
function netEnter(code, color, host) {
  net = { code, color, host, version: -1, deckSent: false, lastSent: null, room: null };
  try { sessionStorage.setItem('chess-tactics-net', JSON.stringify({ code, color, host })); } catch (e) { /* 無視 */ }
  window.history.replaceState(null, '', '?room=' + code);
  netShowError('');
  netToSetup();
}

function netToSetup() {
  startSetup();
  setupColor = net.color === 'b' ? 'b' : 'w';
  flipped = net.color === 'b'; // 黒は自分の陣営が手前に来るように
  net.deckSent = false;
  setMode('net');
  netRender();
}

function netLeave() {
  netGen++;
  if (peer) peer.destroy();
  peer = null; hostRoom = null; hostConns = []; hostConn = null;
  net = null;
  try {
    sessionStorage.removeItem('chess-tactics-net');
    sessionStorage.removeItem('chess-tactics-host');
  } catch (e) { /* 無視 */ }
  window.history.replaceState(null, '', location.pathname);
  startSetup();
  netRender();
}

function netOnRoom(room) {
  if (!net || room.version <= net.version) return;
  net.version = room.version;
  net.room = room;
  netApply(room);
}

function netApply(room) {
  if (room.state) {
    if (phase !== 'play') { netStartPlay(room.state); return; }
    const json = JSON.stringify(room.state);
    if (json === net.lastSent || json === JSON.stringify(S)) { netRender(); return; } // 自分が送った盤面
    S = room.state;
    selected = null; mode = null; routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
    render();
    showEffects(S.effects);
    return;
  }
  // 盤面がない：編成中。試合中だったら「新しいゲーム」が押されたので編成に戻る
  if (phase === 'play') { netToSetup(); return; }
  // 両方のデッキがそろったら、白が試合を作って送る
  if (net.color === 'w' && room.decks.w && room.decks.b && !net.creating) {
    net.creating = true;
    const first = createInitialState({ w: room.decks.w, b: room.decks.b });
    first.field = pickField();
    netSendState(first);
  }
  netRender();
}

function netStartPlay(state) {
  net.creating = false;
  phase = 'play';
  S = state;
  history = [];
  selected = null; mode = null; routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
  flipped = net.color === 'b';
  setupPanel.classList.add('hidden');
  playPanel.classList.remove('hidden');
  render();
}

// 行動したら盤面を送る
function netSendState(state) {
  const body = state || S;
  net.lastSent = JSON.stringify(body);
  netSend({ type: 'state', state: body });
}

function netSendDeck() {
  net.deckSent = true;
  render();
  netSend({ type: 'deck', deck: decks[net.color] });
}

function netRestart() { netSend({ type: 'reset' }); }

function netStatusText() {
  if (net.color === 'watch') return '（観戦中）';
  return S.turn === net.color ? '　あなたの番' : '　相手の番…';
}

// 部屋の案内（合言葉・相手が来たか・配置が終わったか）
function netRender() {
  netLobbyEl.classList.toggle('hidden', !!net);
  netRoomEl.classList.toggle('hidden', !net);
  document.getElementById('deck-builder').classList.toggle('hidden', playMode !== 'net' ? playMode === 'watch' : !net || net.color === 'watch');
  if (!net) return;
  document.getElementById('net-code-show').textContent = net.code;
  const r = net.room;
  const me = net.color === 'watch' ? '観戦' : COLOR_NAME[net.color];
  const lines = [`あなたは${me}`];
  if (r) {
    if (!r.joined.b) lines.push('友だちが入るのを待っています（このページを閉じると部屋が消えます）');
    else {
      const other = net.color === 'w' ? 'b' : 'w';
      if (net.color === 'watch') lines.push(`白の配置：${r.decks.w ? '完了' : 'まだ'}／黒の配置：${r.decks.b ? '完了' : 'まだ'}`);
      else lines.push(`相手の配置：${r.decks[other] ? '完了' : 'まだ'}`);
    }
    if (r.watchers) lines.push(`観戦 ${r.watchers} 人`);
  } else lines.push('つないでいます…');
  netMsgEl.textContent = lines.join('　');
}

document.getElementById('btn-net-create').onclick = () => netCreate();
document.getElementById('btn-net-join').onclick = () => netJoin(document.getElementById('net-code').value);
document.getElementById('net-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') netJoin(e.target.value); });
document.getElementById('btn-net-leave').onclick = () => { netLeave(); setMode('net'); };
document.getElementById('btn-net-copy').onclick = async (e) => {
  const link = location.origin + location.pathname + '?room=' + net.code;
  try { await navigator.clipboard.writeText(link); e.target.textContent = 'コピーした'; }
  catch (err) { prompt('このリンクを友だちに送る', link); }
};

// ?room=合言葉 のリンクで開いたら、その部屋に入る（部屋を作った人が読み込み直したら部屋を作り直す）
(() => {
  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (!code) return;
  setMode('net');
  let saved = null, host = null;
  try {
    saved = JSON.parse(sessionStorage.getItem('chess-tactics-net'));
    host = JSON.parse(sessionStorage.getItem('chess-tactics-host'));
  } catch (e) { /* 無視 */ }
  if (saved && saved.host && saved.code === code && host && host.code === code) {
    netEnter(code, 'w', true);
    netCreate({ code, room: host.room });
  } else netJoin(code);
})();
netRender();
