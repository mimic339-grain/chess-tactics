// =====================================================================
//  ゲーム設定ファイル  ― 数値の調整はまずここ
// =====================================================================

const RULES = {
  actionsPerTurn: 3,   // 1ターンに動かせるキャラの数
  firstTurnActions: 2, // 先手（白）の最初のターンだけ動かせる数（先手有利を減らす）
  moveAndAct: true,    // false = 「移動」か「スキル」のどちらか一方 / true = 移動してからスキルも使える
  movedAttackRate: 0.7, // 移動したあとの攻撃のダメージ倍率（四捨五入、最低1）。1 にすると弱くならない
  counter: true,       // 攻撃されたら、相手が自分の射程にいて弾が足りていれば反撃する（全員）
  stepCost: 1,         // 1マス進むのに払う移動HP（キャラごとに stepCost で上書きできる）
  regenPerTurn: 1,     // 自分のターン開始時に全キャラが自然回復する HP
  moveHpRegen: 2,      // 自分のターン開始時に全キャラが回復する移動HP（キャラごとに moveRegen で上書き）
  shieldMinRange: 2,   // 「遠距離攻撃」とみなす距離。シールド・防壁・ファランクスはこの距離以上の攻撃に効く

  // ポイント：自分のターンが来るたびに perTurn ずつたまる。増援（キャラを自分の陣地に出す）や強力な技に使う
  points: { perTurn: 1, reinforceCost: 3 }, // reinforceCost はキャラに cost がないときの値段

  // 補給路の効果（自分の補給路の上で移動を終えたときにもらえる）
  supply: {
    moveHp: 4,         // 移動HP の回復量
    ammo: 2,           // 弾（矢・魔力）の回復量
    hp: 1,             // HP の回復量
    freeTravel: true,  // true = 自分の補給路のマスに入るときは移動HP を使わない（高速道路）
  },
};

// 旗と城：陣取りルークが止まった場所に旗が立ち、周囲9マスがその側の拠点になる
//  - 9マスの外周に軽い壁。相手の遠距離攻撃を1回防いで壊れる
//  - 9マスに相手のキャラだけがいる状態で相手のターンが来ると、旗ごと奪われる（壊れた壁は元に戻る）
//  - 旗の9マスの中にいる味方は「築城」できる。建てているあいだは無防備（受けるダメージ2倍）
const FORT = {
  defenselessRate: 2,   // 築城中のキャラが受けるダメージの倍率
  repairAmount: 4,      // 修理1回で戻る城の HP
  maxRepairs: 6,        // 修理回数の上限
  supplyRepairBonus: 1, // 旗の9マスに自分の補給路があると、自分のターン開始時に修理回数 +1（材料が届く）
  rookBuildTurns: 1,    // 陣取りルーク自身が建てるときのターン数（無防備にならない）
  // 城壁：同じ縦か横の列に砦が2つあり、旗どうしの間が gap マスなら turns ターンで間に城壁（HP10・遠距離攻撃を防ぐ）
  castleWall: { hp: 10, turnsByGap: { 3: 1, 2: 2 } },
  // 城の段階。建てるのにかかるターン数で種類が変わる。2段目以降は決まったらここに足す
  levels: [
    { level: 1, name: '砦', buildTurns: 2, hp: 10, repairs: 3 },
  ],
};

// セミラミスの魔導国家（浮遊要塞）。周囲9マスが空に浮いた陣地になる
const SKY = {
  buildTurns: 3,   // 建てるのにかかるターン（そのあいだセミラミスは動けない）
  hp: 60,          // 要塞の耐久。エクスプロージョンで削れる。0 で墜落
  boardCost: 3,    // 相手が要塞のマスに乗り込むときに余分にかかる移動HP（空にあるので大変）
  repairAmount: 4,  // 修理1回で戻る建物（アルテミス砲・エネルギー生成所）の HP
  facilities: {
    // アルテミス砲：土台（要塞）の外周の端（角と真ん中以外）に置く建物。外向きの扇形（90度）にしか撃てない
    artemis: { name: 'アルテミス砲', turns: 3, unit: 'artemisCannon', range: 7 },
    turret: { name: 'タレット', turns: 2, damage: 2, range: 3 }, // 自分のターン開始時、要塞から3マス以内の一番近い敵を自動で撃つ
    // エネルギー生成所：土台に置く建物。あるあいだ、自分のターン開始時にセミラミスの MP が増える
    generator: { name: 'エネルギー生成所', turns: 2, unit: 'generator', mpPerTurn: 2 },
    // 土台拡張：要塞が1マス広がる。n 回目は 2n ターン（2・4・6…）
    expand: { name: '土台拡張', turnsPer: 2, maxRadius: 3 },
  },
};

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL8 = ORTHO.concat(DIAG);

// デッキの枠。チェスと同じ数（合計16体）。キャラは role でどの枠に入るかが決まる
const ROLES = {
  king: { name: 'キング枠', count: 1 },
  queen: { name: 'クイーン枠', count: 1 },
  rook: { name: 'ルーク枠', count: 2 },
  bishop: { name: 'ビショップ枠', count: 2 },
  knight: { name: 'ナイト枠', count: 2 },
  pawn: { name: 'ポーン枠', count: 8 },
};

// 倒すと強くなる（進化）。heal = 回復量 / atk・maxHp = 上がる量 / max = 進化できる回数
const PAWN_GROWTH = { heal: 2, atk: 1, maxHp: 2, max: 1 };

// ルーク・ビショップ・ナイト・クイーン枠の進化（1回だけ）
//  by: 'kill' = 敵を倒すと進化 / 'skill' = スキルを EVOLVE.skillUses 回使うと進化
//  進化すると名前が変わり、最大HP +EVOLVE.maxHp（その分回復）、下の text の効果が付く
// 戦場の見た目（ルールは変わらない）
const FIELDS = {
  grass: '草原',
  waste: '荒れ地',
  snow: '雪原',
  desert: '砂漠',
  classic: 'チェス盤',
};

const EVOLVE = { skillUses: 5, maxHp: 3 };
const EVOLUTIONS = {
  // クイーン枠
  E: { name: '女王蜂エレザ', by: 'skill', text: 'タダの産卵が1ターン2匹に。虫が倒したときの MP +3 → +5' },
  M: { name: '龍の大巫女', by: 'skill', text: '必要な祈りが3回 → 2回、降臨までが10 → 7ターン' },
  valkyrie: { name: '天馬の戦乙女', by: 'skill', text: '招集した味方がすぐ来る（1ターン待たない）。自分も飛行で周囲3マスへ移動できる' },
  empress: { name: '覇道の女帝', by: 'skill', text: '陣形移動が2マスまで。動いた味方は1ターン攻撃+1' },
  // ルーク枠
  T: { name: '築城王ルーク', by: 'kill', text: '立てた旗の壁が2回まで防ぐ。自分で建てた砦は HP 15' },
  G: { name: '大盾ルーク', by: 'kill', text: 'シールドが幅3 → 5、前後の2方向に張る' },
  ram: { name: '攻城塔', by: 'kill', text: '建物への倍率 3倍 → 4倍。城門破りの距離が2 → 3マス' },
  catapult: { name: 'トレビュシェット', by: 'kill', text: '射程6 → 8。着弾地点の周り3×3にもダメージ' },
  watchtower: { name: '天眼の塔', by: 'kill', text: '見破る範囲4 → 6、味方の射程 +1 → +2' },
  taunter: { name: '不動の要塞', by: 'kill', text: '挑発の範囲2 → 3。受けるダメージ -1' },
  // ビショップ枠
  H: { name: '大司教', by: 'skill', text: '範囲ヒールが2 → 3回復。浄化が相手の周囲2マスの味方全員に効く' },
  hexer: { name: '大呪術師', by: 'skill', text: '呪術が2つ同時にかかる（選んだもの＋反撃封じ、反撃封じを選んだら＋鈍足）。間隔が3 → 2ターン' },
  warder: { name: '聖域の守護者', by: 'skill', text: '結界が2 → 3ターン。結界の中の味方は毎ターン HP+1' },
  reviver: { name: '聖人', by: 'skill', text: '蘇生が1試合2回まで。蘇った味方は HP 満タン' },
  timepriest: { name: '時の賢者', by: 'skill', text: '時の加護が相手の隣の味方1体にもかかる。間隔が3 → 2ターン' },
  // ナイト枠
  L: { name: '兵站将軍', by: 'kill', text: '補給路を幅3マス（歩いたマス＋左右1マスずつ）で敷ける。補給路での回復量が1.5倍' },
  C: { name: '竜騎士', by: 'kill', text: 'ドラゴンチャージの MP 6 → 4。押し出した敵に追加で2ダメージ' },
};

// ---------------------------------------------------------------------
//  キャラ定義
// ---------------------------------------------------------------------
//  role      … デッキのどの枠に入るか（ROLES）。召喚専用キャラは summonOnly: true
//  hp / atk  … 体力 / 攻撃力
//  moveHp    … 移動HP の最大値。移動するとマス数 × stepCost だけ減り、毎ターン moveRegen ずつ回復
//  ammo      … 攻撃に使う弾（魔力・矢・MPなど）{ name, max, regen, start }。スキルの ammoCost だけ減る
//  growth    … 敵を倒したときの進化（PAWN_GROWTH を参照）
//  hitAndRun … true なら攻撃したあと、残りの移動HPでもう一度動ける
//  move:
//    { type: 'points' }              … 上下左右に1歩ずつ歩く（味方はすり抜けられる・敵は通れない）
//    { type: 'points', ignoreUnits: true } … 敵も味方もすり抜けて歩ける
//    { type: 'area', max: N }        … 周囲 N マス以内のどこへでも跳べる（距離 × stepCost を消費）
//    { type: 'route' }               … 1マスずつ道を決めて進み、通った道が補給路になる
//    { type: 'pattern', moves: [...] } … チェスと同じ動き（'slide' = 何マスでも / 'leap' = 1回跳ぶ）
//  skills: 行動メニューに並ぶスキル
//    kind:  'damage'（敵にダメージ）/ 'heal'（回復）/ 'buff'（強化）/ 'cleanse'（弱体化を解除）
//           'rotate'（シールドの向き）/ 'warp'（ワープ設置）/ 'formation'（まとめて移動）
//           'charge'（祈り）/ 'descentPoint'（降臨地点）/ 'push'（なぎ払って押し出す）
//           'spawn'（隣に産む）/ 'squad'（部隊に入れる）/ 'pierce'（一直線に貫通）/ 'hook'（引き寄せ）
//           'trap'（罠を置く）/ 'alert'（アラートを置く）/ 'stealth'（透明になる）
//    free:  true なら行動回数を使わない
//    aoe:   範囲効果。対象マスの周囲 N マスにいる全員に効く
//    targetSquare: true なら、誰もいないマスも狙える（範囲魔法など）
//    notEnemyCamp: true なら、相手の陣営は狙えないし巻き込めない
//    power / ammoCost / range … 威力（省略で atk）/ 使う弾の量 / 射程
//      range: { type: 'area', min, max } … 自分からの距離（斜めも1マス）
//             { type: 'pattern' }        … 移動と同じ線上で最初にぶつかった相手
//  ※ 2マス以上離れた単体攻撃（弓・魔法）は射線が必要。間に誰かいると撃てない（一番手前の敵だけ狙える）
//  cost      … ポイントで増援として呼ぶときの値段（noReinforce: true なら呼べない）
//  freeActor … 行動回数を使わずに動かせる（デスナイト）
//  rangedImmune … 遠距離（2マス以上）からの攻撃が効かない
//  binding   … 自分の攻撃範囲にいる敵は、その範囲の外に出られない
//  cooldown（スキル）… 使ったあと、そのターン数は使えない / pointCost … ポイントを使う / hits … 攻撃回数

const UNITS = {
  // ===== キング枠 =====
  K: {
    role: 'king', name: 'レオニダス', icon: '👑', hp: 12, atk: 2, moveHp: 4, value: 100, royal: true,
    leader: { family: 'ロイヤル', ability: '来たりて取れ' },
    move: { type: 'pattern', moves: [{ type: 'leap', dirs: ALL8 }] },
    note: '来たりて取れ：使うたびに行動回数を1使う（1ターンに何回でも・レオニダスが行動済みでもOK）。好きな横一列 or 9マスの味方をまとめて動かす。横一列は遠距離ダメージ半減、9マスは遠距離攻撃無効（1ターン）。動く味方の移動HPも減らない',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: 'ファランクス', kind: 'formation', passive: true, shape: 'row', maxDist: 2,
        guard: { stat: 'guard', label: '遠距離ダメージ半減', turns: 1 } },
      { name: '陣形移動', kind: 'formation', passive: true, shape: 'area', maxDist: 2,
        guard: { stat: 'immune', label: '遠距離攻撃無効', turns: 1 } },
    ],
  },
  V: {
    role: 'king', name: 'ヴラド・ツェペシュ', icon: '🧛', hp: 50, atk: 10, moveHp: 3, value: 100, royal: true,
    leader: { family: 'ドラゴン', ability: '串刺し公' }, // 系統はドラクル（竜の子）から仮でドラゴン系
    move: { type: 'points' },
    growth: { heal: 10, atk: 2, maxHp: 5, max: 99 },
    note: '串刺し公：敵を倒すたびに HP+10 回復、攻撃+2、最大HP+5（何回でも）',
    skills: [{ name: '串刺し', kind: 'damage', range: { type: 'area', min: 1, max: 1 } }],
  },

  overlord: {
    role: 'king', name: 'オーバーロード', icon: '☠️', hp: 20, atk: 4, moveHp: 3, value: 100, royal: true,
    leader: { family: 'アンデッド', ability: '死の支配者' },
    ammo: { name: 'MP', max: 20, regen: 2 },
    doom: { start: 0.25, step: 0.05, max: 0.4 }, // 即死の呪いが効く HP の割合（最初25%、強化で最大40%）
    convertsKills: 'deathKnight', // 自分で倒した敵はデスナイトになる
    move: { type: 'points' },
    note: '即死の呪い：HPが最大の25%以下の敵に呪い。次の相手のターン開始時に死ぬ（浄化で解ける）。自分で倒した敵はデスナイトになる',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '即死の呪い', kind: 'doom', ammoCost: 4, range: { type: 'area', min: 1, max: 3 } },
      { name: '範囲殲滅', kind: 'doom', ammoCost: 15, aoe: 2, targetSquare: true, range: { type: 'area', min: 1, max: 4 } },
      { name: '呪力強化', kind: 'doomUp', free: true, pointCost: 5, range: { type: 'area', min: 0, max: 0 } },
    ],
  },
  semiramis: {
    role: 'king', name: 'セミラミス', icon: '🕊️', hp: 15, atk: 3, moveHp: 3, value: 100, royal: true,
    leader: { family: '魔導', ability: '空中庭園' },
    ammo: { name: 'MP', max: 15, regen: 1 },
    move: { type: 'points' },
    note: '魔導国家：その場に浮遊要塞（土台）を建てる（3ターン）。土台は自分の補給路扱いで、相手は乗り込むのに移動HPが余分にかかる。完成後は要塞から出られないが、要塞ごとゆっくり動ける。土台にアルテミス砲・エネルギー生成所・タレットを建て、土台拡張で広げられる',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '魔導国家建造', kind: 'fortressBuild', range: { type: 'area', min: 0, max: 0 } },
      { name: '要塞移動', kind: 'fortressMove' },
      { name: 'アルテミス砲建造', kind: 'facility', facility: 'artemis' },
      { name: 'エネルギー生成所', kind: 'facility', facility: 'generator' },
      { name: '土台拡張', kind: 'facility', facility: 'expand' },
      { name: 'タレット建造', kind: 'facility', facility: 'turret' },
      { name: 'アルテミス砲', kind: 'damage', power: 6, ammoCost: 8, aoe: 1, targetSquare: true, requiresFacility: 'artemis',
        range: { type: 'artemis' } }, // 砲の向いている扇形だけ
      { name: '修理', kind: 'fortRepair' },
    ],
  },

  xeno: {
    role: 'king', name: '王龍ゼノ', icon: '✴️', hp: 2, atk: 2, moveHp: 4, value: 12,
    leader: { family: '古龍', ability: '不滅の王龍' },
    mausoleum: 'mausoleum', // 初期配置の場所に霊廟ができる。霊廟を壊されたら負け（ゼノ自身は倒されても負けない）
    respawn: { maxHp: 2, atk: 2 }, // 倒されると次の自分のターンに霊廟のそばで復活。n 回目の復活で最大HP・攻撃が 2+2n
    move: { type: 'points' },
    note: '不滅の王龍：初期配置の場所に霊廟ができ、霊廟を壊されたら負け。ゼノは HP2・攻撃2 から始まり、何度倒されても次の自分のターンに霊廟のそばで復活。そのたびに最大HP・攻撃が +2（n回目で 2+2n）',
    skills: [{ name: '王龍の爪', kind: 'damage', range: { type: 'area', min: 1, max: 1 } }],
  },

  // ===== クイーン枠 =====
  E: {
    role: 'queen', name: 'マザーエレザ', icon: '👸', hp: 10, atk: 2, moveHp: 6, value: 9,
    ammo: { name: 'MP', max: 20, regen: 0, start: 0 },
    mother: { mpPerKill: 3 },
    move: { type: 'pattern', moves: [{ type: 'slide', dirs: ALL8 }] },
    note: '兵隊虫は毎ターン1匹タダで産める（行動回数も使わない）。虫が敵を倒すと MP+3。MP でアーチャー虫・隊長虫を産む',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '産卵：兵隊虫', kind: 'spawn', unit: 'bugSoldier', free: true, range: { type: 'area', min: 1, max: 1 } },
      { name: '産卵：アーチャー虫', kind: 'spawn', unit: 'bugArcher', ammoCost: 3, range: { type: 'area', min: 1, max: 1 } },
      { name: '産卵：隊長虫', kind: 'spawn', unit: 'bugCaptain', ammoCost: 5, range: { type: 'area', min: 1, max: 1 } },
    ],
  },
  M: {
    role: 'queen', name: '龍呼びの巫女', icon: '⛩️', hp: 8, atk: 1, moveHp: 6, value: 9,
    move: { type: 'pattern', moves: [{ type: 'slide', dirs: DIAG }] },
    // 祈りを3回（続けなくてよい）使うと、8ターン後に自分の陣営へバハムートが降りる
    charge: { name: '祈り', max: 3, descendTurns: 10, unit: 'D' }, // 3回祈る（続けなくてよい）と10ターン後に降臨
    note: '祈りを3回使うと10ターン後にバハムートが自分の陣営に降臨。降りた瞬間、両軍の陣地・設置物・補給路をすべて壊す',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '祈り', kind: 'charge', range: { type: 'area', min: 0, max: 0 } },
      { name: '降臨地点を決める', kind: 'descentPoint', free: true, range: { type: 'camp' } },
    ],
  },

  valkyrie: {
    role: 'queen', name: '戦乙女', icon: '🪽', hp: 12, atk: 4, moveHp: 4, value: 8,
    move: { type: 'points' },
    note: '招集：味方1体を指定すると、次の自分のターンの始めに自分の目の前に呼び寄せる（3ターンに1回）',
    skills: [
      { name: '槍', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '招集', kind: 'recall', cooldown: 3 },
    ],
  },
  empress: {
    role: 'queen', name: '女帝', icon: '🫅', hp: 10, atk: 3, moveHp: 4, value: 8,
    move: { type: 'points' },
    note: 'レオニダスの下位互換：好きな9マスの味方をまとめて1マス動かせる（ファランクスはできない）',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '陣形移動', kind: 'formation', shape: 'area', maxDist: 1 },
    ],
  },

  // ===== ルーク枠 =====
  T: {
    role: 'rook', name: '陣取りルーク', icon: '🏰', hp: 20, atk: 3, value: 6,
    moveHp: 15, stepCost: 2,
    // 飛車＋周り1マス：前後左右は何マスでも、斜めは1マス
    move: { type: 'pattern', moves: [{ type: 'slide', dirs: ORTHO }, { type: 'leap', dirs: ALL8 }] },
    moveText: '前後左右に何マスでも・斜めは1マス',
    claimsTerritory: true,
    plantsFlag: true, // 止まった場所に旗。周囲9マスが拠点になり、外周に軽い壁ができる
    note: '止まった場所に旗が立ち、周囲9マスが拠点になる（外周の壁は遠距離攻撃を1回防ぐ）。陣取りルーク自身は砦を1ターン・無防備なしで建てられる。砦が2つ並ぶと間に城壁を建てられる',
    skills: [{ name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } }],
  },
  G: {
    role: 'rook', name: 'シールドルーク', icon: '🛡️', hp: 12, atk: 2, moveHp: 8, value: 6,
    move: { type: 'pattern', moves: [{ type: 'slide', dirs: ORTHO }] },
    shield: { width: 3 },
    note: '向いている側に幅3マスのシールド。2マス以上離れた敵の攻撃を防ぐ',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: 'シールド回転', kind: 'rotate', range: { type: 'area', min: 1, max: 1 } },
    ],
  },

  ram: {
    role: 'rook', name: '破城槌ルーク', icon: '🐏', hp: 14, atk: 3, moveHp: 6, value: 6,
    move: { type: 'pattern', moves: [{ type: 'slide', dirs: ORTHO }] },
    siegeMult: 3, unitMult: 0.5, // 建物（砦・壁・霊廟・浮遊要塞・シールドルーク）には3倍、ふつうのキャラには半分
    note: '城門破り：2マス以内の相手の旗・砦・浮遊要塞を直接たたく（3倍）。霊廟やシールドルークにも3倍、ふつうのキャラには半分',
    skills: [
      { name: '突き', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '城門破り', kind: 'siege' },
    ],
  },
  catapult: {
    role: 'rook', name: 'カタパルトルーク', icon: '🪨', hp: 10, atk: 4, moveHp: 4, stepCost: 2, value: 6,
    move: { type: 'pattern', moves: [{ type: 'slide', dirs: ORTHO }] },
    note: '装填したら、次のターンにタダ（行動回数を使わない）で6マス先まで射線なしで撃てる。砦・壁・浮遊要塞には2倍',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '装填', kind: 'load', range: { type: 'area', min: 0, max: 0 } },
      { name: '発射', kind: 'catapult', free: true, fortMult: 2, range: { type: 'area', min: 2, max: 6 } },
    ],
  },
  watchtower: {
    role: 'rook', name: '監視塔ルーク', icon: '🗼', hp: 12, atk: 2, moveHp: 6, value: 6,
    move: { type: 'pattern', moves: [{ type: 'slide', dirs: ORTHO }] },
    watch: { reveal: 4, bonusRadius: 2, rangeBonus: 1 }, // 4マス以内の透明と罠を見破る／2マス以内の味方の射程+1
    note: '4マス以内の相手の透明キャラと罠を見破る。周り2マスの味方の遠距離攻撃は射程+1',
    skills: [{ name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } }],
  },
  taunter: {
    role: 'rook', name: '挑発ルーク', icon: '🗯️', hp: 18, atk: 2, moveHp: 6, value: 6,
    move: { type: 'pattern', moves: [{ type: 'slide', dirs: ORTHO }] },
    taunt: 2, // 周り2マスの敵は、単体攻撃を自分にしか向けられない
    note: '挑発：周り2マスにいる敵は、単体攻撃をこのルークにしか向けられない（届くなら）',
    skills: [{ name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } }],
  },

  // ===== ビショップ枠 =====
  H: {
    role: 'bishop', name: 'ヒーラービショップ', icon: '💚', hp: 14, atk: 1, moveHp: 4, value: 5,
    move: { type: 'area', max: 2 },
    moveText: '周囲2マスのどこへでも',
    skills: [
      { name: '範囲ヒール', kind: 'heal', power: 2, aoe: 2, range: { type: 'area', min: 0, max: 0 } },
      { name: '攻撃力アップ', kind: 'buff', buff: { stat: 'atk', amount: 2, turns: 2 }, range: { type: 'area', min: 0, max: 2 } },
      { name: '浄化', kind: 'cleanse', range: { type: 'area', min: 0, max: 2 } },
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
    ],
  },

  hexer: {
    role: 'bishop', name: '呪術師ビショップ', icon: '🪬', hp: 9, atk: 1, moveHp: 4, value: 5,
    move: { type: 'area', max: 2 },
    moveText: '周囲2マスのどこへでも',
    note: '3マス以内の敵1体に、反撃封じ・鈍足（移動コスト2倍）・攻撃力半減のどれかを1ターン（3つで3ターンに1回）',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '反撃封じ', kind: 'hex', cooldown: 3, cooldownGroup: '呪術', debuff: { stat: 'nocounter', label: '反撃できない' }, range: { type: 'area', min: 1, max: 3 } },
      { name: '鈍足', kind: 'hex', cooldown: 3, cooldownGroup: '呪術', debuff: { stat: 'slow', label: '鈍足（移動コスト2倍）' }, range: { type: 'area', min: 1, max: 3 } },
      { name: '攻撃力半減', kind: 'hex', cooldown: 3, cooldownGroup: '呪術', debuff: { stat: 'weaken', label: '攻撃力半減' }, range: { type: 'area', min: 1, max: 3 } },
    ],
  },
  warder: {
    role: 'bishop', name: '結界ビショップ', icon: '🔰', hp: 12, atk: 1, moveHp: 4, value: 5,
    move: { type: 'area', max: 2 },
    moveText: '周囲2マスのどこへでも',
    note: '結界：3マス以内の好きな9マスを3ターン守る。相手はその中を攻撃できず、中にも入れない（3ターンに1回）',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '結界', kind: 'ward', turns: 2, cooldown: 3, range: { type: 'area', min: 0, max: 3 } },
    ],
  },
  reviver: {
    role: 'bishop', name: '蘇生の司祭', icon: '🕯️', hp: 10, atk: 1, moveHp: 4, value: 5,
    move: { type: 'area', max: 2 },
    moveText: '周囲2マスのどこへでも',
    revive: true, // 倒れた味方を1試合に1回だけ蘇らせる（メニューに名前が並ぶ）
    note: '大回復：味方1体をHP10回復。蘇生：倒れた味方を誰でも1人、1試合に1回だけ近くに蘇らせる（HP10・進化したままで戻る）',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '大回復', kind: 'heal', power: 10, cooldown: 2, range: { type: 'area', min: 0, max: 2 } },
    ],
  },
  timepriest: {
    role: 'bishop', name: '時の司祭', icon: '⏳', hp: 9, atk: 1, moveHp: 4, value: 5,
    move: { type: 'area', max: 2 },
    moveText: '周囲2マスのどこへでも',
    note: '時の加護：3マス以内の味方1体を、このターン2回行動できるようにする（行動回数は使わない・3ターンに1回）',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '時の加護', kind: 'haste', cooldown: 3, range: { type: 'area', min: 1, max: 3 } },
    ],
  },

  // ===== ナイト枠 =====
  L: {
    role: 'knight', name: '補給ナイト', icon: '🐎', hp: 7, atk: 3, moveHp: 20, value: 5,
    move: { type: 'route' },
    moveText: '道を1マスずつ決めて進む',
    note: '通った道が補給路になる。敵に踏まれるとそこから先の途切れた部分が壊れる',
    skills: [{ name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } }],
  },
  C: {
    role: 'knight', name: 'ドラゴン騎兵', icon: '🐲', hp: 9, atk: 3, moveHp: 5, value: 6,
    ammo: { name: 'MP', max: 10, regen: 1 },
    move: { type: 'points', ignoreUnits: true },
    moveText: '敵も味方もすり抜けて歩く',
    note: 'ドラゴンチャージ：前後左右のどれかへ奥行き5・幅3をなぎ払い、敵にダメージ。範囲にいた全員（味方も）を奥行き6まで押し出す',
    skills: [
      { name: '攻撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: 'ドラゴンチャージ', kind: 'push', depth: 5, width: 3, pushTo: 6, ammoCost: 6 },
    ],
  },

  // ===== ポーン枠 =====
  F: {
    role: 'pawn', cost: 2, name: 'ファイター', icon: '⚔️', hp: 10, atk: 3, moveHp: 3, value: 3, growth: PAWN_GROWTH,
    move: { type: 'points' },
    skills: [{ name: '斬撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } }],
  },
  Y: {
    role: 'pawn', cost: 3, name: 'フックファイター', icon: '🪝', hp: 10, atk: 3, moveHp: 3, value: 3, growth: PAWN_GROWTH,
    move: { type: 'points' },
    note: 'フック：前後左右のどれかに4マス先まで投げ、最初に当たったキャラを自分の目の前に引き寄せる',
    skills: [
      { name: '斬撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: 'フック', kind: 'hook', length: 4 },
    ],
  },
  A: {
    role: 'pawn', cost: 2, name: 'アーチャー', icon: '🏹', hp: 5, atk: 2, moveHp: 4, value: 2, growth: PAWN_GROWTH,
    ammo: { name: '矢', max: 3, regen: 1 },
    move: { type: 'points' },
    skills: [{ name: '射撃', kind: 'damage', ammoCost: 1, range: { type: 'area', min: 2, max: 3 } }],
  },
  P: {
    role: 'pawn', cost: 3, name: '貫通アーチャー', icon: '🎯', hp: 5, atk: 2, moveHp: 4, value: 3, growth: PAWN_GROWTH,
    ammo: { name: '矢', max: 3, regen: 1 },
    move: { type: 'points' },
    note: '貫通：8方向のどれかへ一直線に5マス、射線上の敵全員にダメージ（矢2本）',
    skills: [
      { name: '射撃', kind: 'damage', ammoCost: 1, range: { type: 'area', min: 2, max: 3 } },
      { name: '貫通', kind: 'pierce', length: 5, ammoCost: 2 },
    ],
  },
  J: {
    role: 'pawn', cost: 3, name: '罠師アーチャー', icon: '🪤', hp: 5, atk: 2, moveHp: 4, value: 3, growth: PAWN_GROWTH,
    ammo: { name: '矢', max: 3, regen: 1 },
    move: { type: 'points' },
    note: '罠：隣のマスに罠（2個まで）。踏んだ敵はそこで止まり、1ターン動けず反撃もできない。アラート：3マス以内に置くと周囲9マスに入った敵の透明化を解く',
    skills: [
      { name: '射撃', kind: 'damage', ammoCost: 1, range: { type: 'area', min: 2, max: 3 } },
      { name: '罠設置', kind: 'trap', maxTraps: 2, range: { type: 'area', min: 1, max: 1 } },
      { name: 'アラート設置', kind: 'alert', aoe: 1, range: { type: 'area', min: 0, max: 3 } },
    ],
  },
  S: {
    role: 'pawn', cost: 3, name: 'アサシン', icon: '🗡️', hp: 5, atk: 4, moveHp: 5, value: 3, growth: PAWN_GROWTH,
    ammo: { name: 'MP', max: 6, regen: 1 },
    move: { type: 'points' },
    note: '透過（MP4）：3ターン相手から見えなくなる。相手の陣営に入る・アラートの範囲に入る・攻撃すると見つかる',
    skills: [
      { name: '急所突き', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '透過', kind: 'stealth', turns: 3, ammoCost: 4, range: { type: 'area', min: 0, max: 0 } },
    ],
  },
  Z: {
    role: 'pawn', cost: 3, name: '影走りアサシン', icon: '🥷', hp: 5, atk: 4, moveHp: 5, value: 3, growth: PAWN_GROWTH,
    ammo: { name: 'MP', max: 6, regen: 1 },
    hitAndRun: true,
    move: { type: 'points' },
    note: 'ヒット＆アウェイ：移動 → 攻撃 → 残りの移動HPでもう一度移動できる。透過も使える',
    skills: [
      { name: '急所突き', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '透過', kind: 'stealth', turns: 3, ammoCost: 4, range: { type: 'area', min: 0, max: 0 } },
    ],
  },
  W: {
    role: 'pawn', cost: 3, name: 'ウィッチ', icon: '🔮', hp: 3, atk: 5, moveHp: 1, value: 3, growth: PAWN_GROWTH,
    ammo: { name: '魔力', max: 10, regen: 1 },
    move: { type: 'points' },
    skills: [
      { name: '魔法', kind: 'damage', ammoCost: 3, range: { type: 'area', min: 1, max: 2 } },
      { name: 'ヒール', kind: 'heal', power: 3, ammoCost: 4, range: { type: 'area', min: 0, max: 2 } },
      { name: '範囲魔法', kind: 'damage', ammoCost: 8, aoe: 1, targetSquare: true, notEnemyCamp: true,
        range: { type: 'area', min: 1, max: 4 } },
    ],
  },

  blueflame: {
    role: 'pawn', cost: 4, name: '蒼炎の剣士', icon: '🔥', hp: 10, atk: 3, moveHp: 3, value: 4, growth: PAWN_GROWTH,
    move: { type: 'points' },
    note: '蒼炎：近く（2マス以内）の旗・砦に放つと、その9マスにいる敵味方全員が2ターン燃える（毎ターン2ダメージ）',
    skills: [
      { name: '斬撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '蒼炎', kind: 'blueflame', burn: { amount: 2, turns: 2 }, cooldown: 3 },
    ],
  },
  dual: {
    role: 'pawn', cost: 4, name: '二刀流', icon: '🤺', hp: 9, atk: 3, moveHp: 3, value: 4, growth: PAWN_GROWTH,
    ammo: { name: 'MP', max: 6, regen: 1 },
    move: { type: 'points' },
    note: '二連撃：通常攻撃を2回。一方通行：指定した3×3を1方向にしか進めないエリアにする（2ターン）。そのあいだ自分は動けないが遠距離攻撃が効かない',
    skills: [
      { name: '斬撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '二連撃', kind: 'damage', hits: 2, ammoCost: 3, range: { type: 'area', min: 1, max: 1 } },
      { name: '一方通行', kind: 'oneway', ammoCost: 3, duration: 2, range: { type: 'area', min: 1, max: 3 } },
    ],
  },
  oneblade: {
    role: 'pawn', cost: 4, name: '一刀', icon: '🔪', hp: 10, atk: 4, moveHp: 3, value: 4, growth: PAWN_GROWTH,
    ammo: { name: 'MP', max: 10, regen: 1 },
    move: { type: 'points' },
    note: '黒刀：前後左右のどれかへ幅1・長さ5。そこの補給路・陣地・罠・旗などを壊し、二度と置けない破壊エリアにする（MP8・4ターン使えない）',
    skills: [
      { name: '斬撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '黒刀', kind: 'blackblade', length: 5, ammoCost: 8, cooldown: 4 },
    ],
  },
  hero: {
    role: 'pawn', cost: 4, name: '勇者', icon: '🦸', hp: 12, atk: 3, moveHp: 3, value: 4, growth: PAWN_GROWTH,
    ammo: { name: 'MP', max: 10, regen: 1 },
    move: { type: 'points' },
    note: '近くは斬撃、遠くは魔法弾（MPが重い）。自分を回復できる',
    skills: [
      { name: '斬撃', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '自己ヒール', kind: 'heal', power: 4, ammoCost: 3, range: { type: 'area', min: 0, max: 0 } },
      { name: '魔法弾', kind: 'damage', power: 3, ammoCost: 5, range: { type: 'area', min: 2, max: 4 } },
    ],
  },
  manawitch: {
    role: 'pawn', cost: 3, name: 'マナウィッチ', icon: '🧙', hp: 4, atk: 3, moveHp: 1, value: 3, growth: PAWN_GROWTH,
    ammo: { name: 'MP', max: 4, regen: 2, grow: 1, cap: 20 }, // 自分のターンごとに最大MP +1（20まで）
    move: { type: 'points' },
    note: '最大MPがターンごとに増える。MP譲渡で味方にMPを分けられる（めぐみんのエクスプロージョン用など）',
    skills: [
      { name: '魔法', kind: 'damage', ammoCost: 3, range: { type: 'area', min: 1, max: 2 } },
      { name: 'MP譲渡', kind: 'transfer', amount: 5, range: { type: 'area', min: 1, max: 2 } },
    ],
  },
  megumin: {
    role: 'king', royal: true, name: '大魔道士めぐみん', icon: '💥', hp: 4, atk: 1, moveHp: 2, value: 100,
    leader: { family: '紅魔族', ability: 'エクスプロージョン' },
    ammo: { name: 'MP', max: 5, regen: 1, grow: 1, cap: 25 }, // 自分のターンごとに最大MP +1。20ターンで最大
    move: { type: 'points' },
    note: 'エクスプロージョン：MPを全部使い、その量がダメージ。MP10以上で範囲5×5、20以上で7×7。設置物も壊し、浮遊要塞も削れる',
    skills: [
      { name: '杖', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: 'エクスプロージョン', kind: 'explosion', minMp: 5, targetSquare: true, range: { type: 'area', min: 1, max: 6 } },
    ],
  },
  hassan: {
    role: 'king', royal: true, name: '山の翁 ハサン・サッバーハ', icon: '💀', hp: 30, atk: 6, moveHp: 4, value: 100,
    leader: { family: '暗殺教団', ability: '山の翁' },
    rangedImmune: true, binding: true,
    move: { type: 'points' },
    note: '遠距離攻撃が効かない。自分の攻撃範囲（2マス）にいる敵は、その外に出られない',
    skills: [{ name: '告死の剣', kind: 'damage', range: { type: 'area', min: 1, max: 2 } }],
  },

  waterwitch: {
    role: 'pawn', cost: 3, name: '水の魔女', icon: '💧', hp: 4, atk: 3, moveHp: 1, value: 3, growth: PAWN_GROWTH,
    ammo: { name: 'MP', max: 8, regen: 1 },
    move: { type: 'points' },
    note: '泥沼：3マス以内の好きな9マスを9ターン泥沼にする。泥沼に入るには1マス2の移動HPがかかる（敵味方とも）',
    skills: [
      { name: '魔法', kind: 'damage', ammoCost: 3, range: { type: 'area', min: 1, max: 2 } },
      { name: '泥沼', kind: 'swamp', turns: 9, ammoCost: 4, cooldown: 4, range: { type: 'area', min: 1, max: 3 } },
    ],
  },

  // ===== 召喚・産卵でだけ出てくるキャラ =====
  artemisCannon: {
    summonOnly: true, immobile: true, structure: true, name: 'アルテミス砲', icon: '🔭', hp: 12, atk: 0, moveHp: 0, value: 6, repairs: 3,
    move: { type: 'none' },
    note: 'セミラミスの土台の端に建つ砲台。向いている方向の扇形（90度）7マスを撃てる。壊されたら建て直し。セミラミスが修理できる',
    skills: [],
  },
  generator: {
    summonOnly: true, immobile: true, structure: true, name: 'エネルギー生成所', icon: '⚡', hp: 8, atk: 0, moveHp: 0, value: 4, repairs: 3,
    move: { type: 'none' },
    note: 'あるあいだ、自分のターン開始時にセミラミスの MP +2。壊されることがある。セミラミスが修理できる',
    skills: [],
  },
  mausoleum: {
    summonOnly: true, royal: true, immobile: true, name: '霊廟', icon: '⚱️', hp: 30, atk: 0, moveHp: 0, value: 100,
    move: { type: 'none' },
    note: '王龍ゼノの霊廟。壊されたら負け。動かない',
    skills: [],
  },
  deathKnight: {
    summonOnly: true, freeActor: true, name: 'デスナイト', icon: '🧟', hp: 10, atk: 10, moveHp: 3, value: 5,
    move: { type: 'points' },
    note: 'オーバーロードが倒した敵の成れの果て。行動回数を使わずに動かせる',
    skills: [{ name: '死の剣', kind: 'damage', range: { type: 'area', min: 1, max: 1 } }],
  },
  D: {
    summonOnly: true, name: 'バハムート', icon: '🐉', hp: 30, atk: 8, moveHp: 6, value: 15,
    ammo: { name: '炎', max: 6, regen: 1 },
    move: { type: 'area', max: 3 },
    moveText: '飛行：周囲3マスのどこへでも',
    note: '龍呼びの巫女が呼ぶ龍。降りた瞬間に両軍の陣地・設置物・補給路を壊す',
    skills: [
      { name: 'かみつき', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: 'メガフレア', kind: 'damage', power: 6, ammoCost: 3, aoe: 1, targetSquare: true, notEnemyCamp: true,
        range: { type: 'area', min: 1, max: 3 } },
    ],
  },
  bugSoldier: {
    summonOnly: true, bug: true, name: '兵隊虫', icon: '🐜', hp: 4, atk: 2, moveHp: 3, value: 1, growth: PAWN_GROWTH,
    move: { type: 'points' },
    note: 'マザーエレザが産む虫（ファイター系）',
    skills: [{ name: 'かみつき', kind: 'damage', range: { type: 'area', min: 1, max: 1 } }],
  },
  bugArcher: {
    summonOnly: true, bug: true, name: 'アーチャー虫', icon: '🦗', hp: 3, atk: 2, moveHp: 3, value: 1, growth: PAWN_GROWTH,
    move: { type: 'points' },
    note: 'マザーエレザが産む虫（アーチャー系）',
    skills: [{ name: '針飛ばし', kind: 'damage', range: { type: 'area', min: 2, max: 3 } }],
  },
  bugCaptain: {
    summonOnly: true, bug: true, name: '隊長虫', icon: '🪲', hp: 7, atk: 2, moveHp: 4, value: 3,
    squadMax: 4,
    move: { type: 'points' },
    note: '部隊編成で虫を部隊に入れると、隊長が動いたとき一緒に同じだけ動く（最大4匹）',
    skills: [
      { name: 'かみつき', kind: 'damage', range: { type: 'area', min: 1, max: 1 } },
      { name: '部隊編成', kind: 'squad', free: true, range: { type: 'area', min: 1, max: 3 } },
    ],
  },
};

// 陣営（キャラを置けるマス・乗っ取れない陣地）の大きさ。盤の手前から depth 行、中央の width 列
const CAMP = { width: 10, depth: 3 };

// 盤の大きさと「おまかせ配置」。大文字 = 白、小文字 = 黒、'.' = 空きマス。上が黒側。
// キング枠 K = レオニダス / V = ヴラド　クイーン枠 E = マザーエレザ / M = 龍呼びの巫女
// ルーク枠 T = 陣取り / G = シールド　ビショップ枠 H = ヒーラー　ナイト枠 L = 補給 / C = ドラゴン騎兵
// ポーン枠 F = ファイター / Y = フックファイター / A = アーチャー / P = 貫通アーチャー / J = 罠師アーチャー
//          S = アサシン / Z = 影走りアサシン / W = ウィッチ
// 行数・列数を変えれば盤のサイズも変わる（今は 14×14、陣営は 10×3、両軍の間は 8 マス）
const INITIAL_LAYOUT = [
  '...tlhekhcg...',
  '..............',
  '...fpwszwjy...',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '..............',
  '...FPWSZWJY...',
  '..............',
  '...TLHEKHCG...',
];
