// =====================================================================
//  ネット対戦：合言葉の部屋で、白（部屋を作った人）と黒（入った人）が戦う
//  サーバー（serve.py）が盤面を中継する。行動した側が行動のたびに盤面を丸ごと送る
// =====================================================================
const netLobbyEl = document.getElementById('net-lobby');
const netRoomEl = document.getElementById('net-room');
const netMsgEl = document.getElementById('net-msg');
const netErrorEl = document.getElementById('net-error');
let netGen = 0; // 部屋を出たら古い問い合わせを止める

async function netApi(path, body) {
  const res = await fetch('api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'サーバーにつながりません');
  return data;
}

function netShowError(msg) { netErrorEl.innerHTML = msg ? `<div>⚠ ${msg}</div>` : ''; }

// 部屋に入った（作った）あと：自分の側のデッキを組む
function netEnter(code, color) {
  net = { code, color, version: -1, deckSent: false, lastSent: null, room: null, chain: Promise.resolve() };
  try { sessionStorage.setItem('chess-tactics-net', JSON.stringify({ code, color })); } catch (e) { /* 無視 */ }
  window.history.replaceState(null, '', '?room=' + code);
  netShowError('');
  netToSetup();
  netPoll(++netGen);
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
  net = null;
  try { sessionStorage.removeItem('chess-tactics-net'); } catch (e) { /* 無視 */ }
  window.history.replaceState(null, '', location.pathname);
  startSetup();
  netRender();
}

// 部屋の様子が変わるまで待って、変わったら反映する（ずっと繰り返す）
async function netPoll(gen) {
  while (gen === netGen) {
    try {
      const room = await netApi(`room/${net.code}?since=${net.version}`);
      if (gen !== netGen) return;
      net.version = room.version;
      net.room = room;
      netApply(room);
    } catch (e) {
      if (gen !== netGen) return;
      netMsgEl.textContent = '通信できません。もう一度つなぎ直しています…';
      await sleep(2000);
    }
  }
}

function netApply(room) {
  if (room.state) {
    if (phase !== 'play') { netStartPlay(room.state); return; }
    const json = JSON.stringify(room.state);
    if (json === net.lastSent || json === JSON.stringify(S)) return; // 自分が送った盤面
    S = room.state;
    selected = null; mode = null; routePath = []; formationAnchor = null; confirmTarget = null; tracePath = []; reviveGrave = null;
    render();
    showEffects(S.effects);
    return;
  }
  // 盤面がない：編成中。試合中だったら「もう一度」が押されたので編成に戻る
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

// 行動したら盤面を送る（順番が入れ替わらないように1つずつ）
function netSendState(state) {
  const n = net, body = { state: state || S };
  n.lastSent = JSON.stringify(body.state);
  n.chain = n.chain.then(() => netApi(`room/${n.code}/state`, body)).catch(() => {
    netMsgEl.textContent = '盤面を送れませんでした。通信を確かめてください';
  });
}

function netSendDeck() {
  const n = net;
  n.deckSent = true;
  render();
  netApi(`room/${n.code}/deck`, { color: n.color, deck: decks[n.color] })
    .catch(e => { n.deckSent = false; netShowError(e.message); render(); });
}

function netRestart() {
  netApi(`room/${net.code}/reset`, {}).catch(e => netShowError(e.message));
}

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
    if (!r.joined.b) lines.push('友だちが入るのを待っています');
    else {
      const other = net.color === 'w' ? 'b' : 'w';
      if (net.color === 'watch') lines.push(`白の配置：${r.decks.w ? '完了' : 'まだ'}／黒の配置：${r.decks.b ? '完了' : 'まだ'}`);
      else lines.push(`相手の配置：${r.decks[other] ? '完了' : 'まだ'}`);
    }
    if (r.watchers) lines.push(`観戦 ${r.watchers} 人`);
  }
  netMsgEl.textContent = lines.join('　');
}

document.getElementById('btn-net-create').onclick = async () => {
  try { const r = await netApi('create', {}); netEnter(r.code, r.color); } catch (e) { netShowError(e.message); }
};
async function netJoin(code) {
  try { const r = await netApi('join', { code }); netEnter(r.code, r.color); } catch (e) { netShowError(e.message); }
}
document.getElementById('btn-net-join').onclick = () => netJoin(document.getElementById('net-code').value);
document.getElementById('net-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') netJoin(e.target.value); });
document.getElementById('btn-net-leave').onclick = () => { netLeave(); setMode('net'); };
document.getElementById('btn-net-copy').onclick = async (e) => {
  const link = location.origin + location.pathname + '?room=' + net.code;
  try { await navigator.clipboard.writeText(link); e.target.textContent = 'コピーした'; }
  catch (err) { prompt('このリンクを友だちに送る', link); }
};

// ?room=合言葉 のリンクで開いたら、その部屋に入る（読み込み直したときは同じ色に戻る）
(() => {
  const code = new URLSearchParams(location.search).get('room');
  if (!code) return;
  setMode('net');
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('chess-tactics-net')); } catch (e) { /* 無視 */ }
  if (saved && saved.code === code.toUpperCase()) netEnter(saved.code, saved.color);
  else netJoin(code);
})();
netRender();
