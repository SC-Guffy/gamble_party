// 우당탕 도박 일주일 - 서버 기반 4인 베팅 게임 (wasd-tori-server와 같은 뼈대: Node 내장 모듈만 사용)
// 메타: 각자 $1000으로 시작해 7일 동안 가장 많이 불린 사람이 우승.
//   투표 = 랜덤 3개 게임 + 무작위 중에서 골라 득표 비례 확률로 추첨 → 낮 = 그날의 도박 컨텐츠 → 밤 = 정산.
//   밤에 파산($0)이면 한푼줍쇼 1회. 아무도 안 주면 다음 날은 아오지 탄광(관전만) → 그날 밤 일당 $200.
// 서버가 돈/베팅/경주 결과를 전부 소유한다. 경주는 출발 순간 서버가 끝까지 미리 시뮬레이션해서
// 프레임 통째로 내려주고, 클라이언트는 재생만 한다. (베팅은 이미 잠긴 뒤라 결과를 미리 알아도 쓸 데가 없다)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");
const { WSServer } = require("./wsserver");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WSServer({ server });

// ---------- 규격 ----------
const MAX_PLAYERS = 4;
const START_MONEY = Number(process.env.START_MONEY) || 1000; // 테스트할 땐 START_MONEY=300 처럼 낮추면 파산·탄광 흐름을 빨리 볼 수 있다
const ALMS = 100; // 한푼줍쇼 한 번에 건네는 돈
const DAYS = Number(process.env.DAYS) || 7; // 짧게 한 판 하고 싶으면 DAYS=3 node server.js
const WAGE = 200; // 아오지 탄광 일당
// 도박 컨텐츠 목록. cap(day) = 그날 한 사람이 걸 수 있는 총액 상한(올인 즉사 방지, 날이 갈수록 판이 커진다).
// 새 게임을 추가할 땐 여기에 등록하고 startDay에서 key별로 분기하면 된다. (투표 카드용으로 클라이언트 GINFO/drawArt에도)
// min = 최소 인원(없으면 1). 방 인원이 모자라면 투표 카드/무작위 후보에서 빠진다.
// 경마 = 하루 1경주, cap은 하루 총액. 블랙잭 = 하루 BJ_HANDS판, cap은 판당(더블다운은 상한과 별개로 판돈만큼 더 낸다).
const GAMES = [
  { key: "derby", name: "경마", cap: (day) => 200 + 100 * day },
  { key: "blackjack", name: "블랙잭", cap: (day) => 50 + 50 * day },
  { key: "dice", name: "주사위", cap: (day) => 50 + 50 * day }, // 하루 DICE_ROUNDS판, cap은 판당
  { key: "penguin", name: "펭귄 빙산 건너기", cap: (day) => 50 + 50 * day }, // 하루 PG_ROUNDS판, cap은 판당
  { key: "nunchi", name: "눈치 숫자", cap: (day) => 50 + 50 * day, min: 3 }, // 하루 NC_ROUNDS판, cap = 판당 고정 참가비. 둘이면 1이 무조건 이득이라 3명부터
];
// 펭귄 빙산 건너기: 점프할수록 성공률이 떨어지고, 배당은 0.95 ÷ (지금까지 성공률의 곱) → 어디서 멈추든 기대 환급률 95%.
// PG_MULTS[k] = k+1번 성공한 뒤 멈추면 받는 배수. 마지막(10번째) 점프에 성공하면 섬에 도착해서 자동으로 챙긴다.
const PG_ROUNDS = 3;
const PG_EDGE = 0.95;
const PG_PROBS = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45];
const PG_MULTS = PG_PROBS.map((_, k) => Math.round((PG_EDGE / PG_PROBS.slice(0, k + 1).reduce((a, b) => a * b, 1)) * 100) / 100);
const VOTE_SECONDS = 15; // 게임 투표 제한 시간 (전원 준비하면 바로 추첨)
const VOTE_REVEAL = 4500; // 추첨 후 룰렛 연출을 보여주고 낮을 시작하기까지(ms)
const BJ_HANDS = 3;
const DICE_ROUNDS = 3;
const DICE_EDGE = 0.95; // 주사위 환급률. 배당 = 0.95 × 36 ÷ (맞는 경우의 수) → 확률에 정확히 반비례
// 주사위 2개 베팅 칸. 순서(인덱스)가 곧 me.bets의 키이고 클라이언트 DICE_LABELS와 같아야 한다.
// 업/다운은 7을 뺀 위아래라서 7이 나오면 둘 다 꽝(= 하우스 몫).
const DICE_BETS = [
  { key: "odd", win: (a, b) => (a + b) % 2 === 1 },
  { key: "even", win: (a, b) => (a + b) % 2 === 0 },
  { key: "down", win: (a, b) => a + b < 7 },
  { key: "up", win: (a, b) => a + b > 7 },
  { key: "double", win: (a, b) => a === b },
  ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => ({ key: "sum" + n, win: (a, b) => a + b === n })),
];
for (const bet of DICE_BETS) { // 36가지를 직접 세어서 배당을 만든다 (손으로 적은 표가 틀릴 일이 없게)
  let ways = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if (bet.win(a, b)) ways++;
  bet.ways = ways;
  bet.odds = Math.round((DICE_EDGE * 36 / ways) * 10) / 10;
}
const LOOK_SIZES = { top: 8, bottom: 6, hair: 6, hairColor: 6, skin: 4 }; // 클라이언트 팔레트/머리모양 개수와 같아야 함
const TRACK = 1000; // 트랙 길이 (클라이언트와 같아야 함)
const DT = 0.1; // 시뮬레이션 1틱(초) (클라이언트와 같아야 함)
const FIELD = 6; // 한 경주 출전 수 (8마리 중 매번 6마리 추첨)
const EDGE = 0.92; // 환급률. 8%는 하우스 몫 → 오래 하면 누군가는 반드시 거지가 된다
const AFTER_WIN = 3; // 1등 골인 후 경주를 더 보여주는 시간(초)
const COND_STEP = 0.01; // 컨디션 1단계당 속도 ±1% (기복 없는 동물은 이것만으로도 배당이 크게 움직인다)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 0/O, 1/I 제외

const rnd = (a, b) => a + Math.random() * (b - a);
const shuffle = (arr) => { // Fisher-Yates, 제자리
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

// ---------- 동물 ----------
// base: 기본 속도, vol: 페이스 출렁임, mult(s, pos): 이번 틱 속도 배수.
// s.fx = 1이면 클라이언트가 그 동물의 특수 연출(낮잠/터보/미끄덩…)을 그린다.
// 숫자는 `node server.js --check`의 승률표를 보면서 맞춘 값.
const ANIMALS = [
  { key: "horse", base: 50.6, vol: 0.03, init: () => ({}), mult: () => 1 },
  { key: "chicken", base: 42.6, vol: 0.05, init: () => ({ left: 0 }),
    mult(s) { // 가끔 놀라서 푸드덕 폭주
      if (s.left <= 0 && Math.random() < 0.02) s.left = 1.2;
      s.left -= DT; s.fx = s.left > 0 ? 1 : 0;
      return s.fx ? 1.7 : 1;
    } },
  { key: "rabbit", base: 51.4, vol: 0.04, init: () => ({ napAt: Math.random() < 0.55 ? rnd(350, 800) : Infinity, nap: rnd(2.5, 5.5) }),
    mult(s, pos) { // 제일 빠르지만 절반쯤은 중간에 낮잠
      s.fx = pos >= s.napAt && s.nap > 0 ? 1 : 0;
      if (s.fx) s.nap -= DT;
      return s.fx ? 0 : 1;
    } },
  { key: "pig", base: 47.3, vol: 0.04, init: () => ({}),
    mult(s, pos) { const p = pos / TRACK; s.fx = p > 0.7 ? 1 : 0; return 0.78 + 0.6 * p; } }, // 막판 스퍼트
  { key: "frog", base: 41.9, vol: 0.05, init: () => ({ left: rnd(0.3, 0.8), crouch: true }),
    mult(s) { // 웅크렸다 폴짝. fx=1이 웅크린 구간
      s.left -= DT;
      if (s.left <= 0) { s.crouch = !s.crouch; s.left = s.crouch ? rnd(0.4, 1.0) : rnd(0.6, 1.2); }
      s.fx = s.crouch ? 1 : 0;
      return s.crouch ? 0.1 : 2.0;
    } },
  { key: "turtle", base: 30.7, vol: 0.02, init: () => ({ left: 0 }),
    mult(s) { // 느림보. 가끔 등껍질 터보
      if (s.left <= 0 && Math.random() < 0.0035) s.left = 3.5;
      s.left -= DT; s.fx = s.left > 0 ? 1 : 0;
      return s.fx ? 3 : 1;
    } },
  { key: "penguin", base: 38.8, vol: 0.03, init: () => ({ v: 0.6, slip: 0 }),
    mult(s) { // 배 슬라이딩으로 계속 가속, 미끄덩하면 처음부터
      if (s.slip > 0) { s.slip -= DT; s.fx = 1; return 0.15; }
      s.fx = 0;
      if (Math.random() < 0.012) { s.slip = 0.9; s.v = 0.5; }
      s.v = Math.min(1.6, s.v + 0.02);
      return s.v;
    } },
  { key: "elephant", base: 43.7, vol: 0.015, init: () => ({ v: 0.35 }),
    mult(s) { s.v = Math.min(1.4, s.v + 0.011); s.fx = s.v >= 1.4 ? 1 : 0; return s.v; } }, // 발동이 느리지만 최고속도는 최상급
];

// 경주 한 판. record=false면 1등만 가리고 바로 끝낸다(배당 계산용).
function simulate(entrants, record) {
  // k에 곱하는 가우스 = 아무도 모르는 "당일 운"(±1.2%). 이게 없으면 기복 없는 동물은 컨디션만으로 승부가 갈려 배당이 1점대로 쏠린다.
  const H = entrants.map((e) => ({ a: ANIMALS[e.a], k: e.k * (1 + gauss() * 0.012), s: ANIMALS[e.a].init(), m: 0, pos: 0, fin: Infinity }));
  const pos = H.map(() => [0]), fx = H.map(() => [0]);
  let winT = Infinity;
  for (let t = 0; t < 600 && t * DT < winT + AFTER_WIN; t++) { // 60초 상한
    let lead = 0;
    for (const h of H) if (h.pos > lead) lead = h.pos;
    for (const h of H) {
      h.m = h.m * 0.9 + gauss() * h.a.vol;
      // 뒤처질수록 살짝 빨라진다(선두와 200 차이 → +2%). 끝까지 접전이 되게.
      const v = h.a.base * h.k * (1 + h.m) * h.a.mult(h.s, h.pos) * (1 + (0.1 * (lead - h.pos)) / TRACK);
      const brake = h.fin === Infinity ? 1 : Math.max(0, 1 - (t * DT - h.fin) / 1.2); // 골인하면 1.2초에 걸쳐 멈춘다(화면 밖으로 안 나가게)
      const next = h.pos + Math.max(0, v) * brake * DT;
      if (h.fin === Infinity && next >= TRACK) {
        h.fin = (t + (TRACK - h.pos) / (next - h.pos)) * DT; // 틱 안에서의 정확한 골인 시각
        if (h.fin < winT) winT = h.fin;
      }
      h.pos = next;
    }
    if (!record) { if (winT < Infinity) break; continue; }
    H.forEach((h, i) => { pos[i].push(Math.round(h.pos * 10) / 10); fx[i].push(h.s.fx || 0); });
  }
  const order = H.map((_, i) => i).sort((a, b) => H[a].fin - H[b].fin || H[b].pos - H[a].pos);
  return { order, pos, fx, duration: pos[0].length * DT };
}

// ponytail: 방마다 라운드마다 몬테카를로 3000판(수십 ms, 이벤트 루프를 잠깐 막음). 방이 수십 개로 늘면 worker_threads로.
function calcOdds(entrants, n = 3000) {
  const wins = entrants.map(() => 0);
  for (let i = 0; i < n; i++) wins[simulate(entrants, false).order[0]]++;
  return wins.map((w) => Math.min(80, Math.max(1.1, Math.round((EDGE / Math.max(w / n, 0.005)) * 10) / 10)));
}

function pickEntrants() {
  const entrants = shuffle(ANIMALS.map((_, i) => i)).slice(0, FIELD).map((a) => {
    const cond = Math.floor(Math.random() * 5) - 2; // -2(최악) ~ +2(최상)
    return { a, key: ANIMALS[a].key, cond, k: 1 + cond * COND_STEP };
  });
  calcOdds(entrants).forEach((o, i) => { entrants[i].odds = o; });
  return entrants;
}

// 정산: 1등에 건 돈 × 배당을 돌려준다. (건 돈은 베팅 시점에 이미 빠져 있음)
function settle(players, entrants, winner) {
  const payouts = {};
  for (const p of players) {
    const bet = Object.values(p.bets).reduce((a, b) => a + b, 0);
    const win = Math.floor((p.bets[winner] || 0) * entrants[winner].odds);
    p.money += win;
    p.bets = {};
    payouts[p.id] = { bet, win };
  }
  return payouts;
}

// ---------- 방 ----------
const rooms = new Map(); // code -> room. code는 내부 방 ID로만 쓴다(입장은 방 목록에서 고른다)

function genCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(title, hostName) {
  const room = {
    code: genCode(),
    title: String(title || "").trim().slice(0, 16) || cleanName(hostName) + "의 방",
    players: new Map(), // ws -> player
    phase: "lobby", // lobby | vote | betting | countdown | racing | result | night | final
    day: 0,
    game: null,
    cap: 0,
    vote: null, // 게임 투표: { options: [게임 key 3개], votes: { playerId: 0~3 (3 = 무작위) }, until, pick, game }
    night: null, // 밤 정산표: { playerId: { delta, wage } }
    entrants: null,
    race: null,
    raceStart: 0,
    result: null,
    timer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.players.keys()) if (ws.readyState === ws.OPEN) ws.send(data);
}

function broadcastRoom(room) {
  broadcast(room, {
    type: "room",
    room: { code: room.code, title: room.title, phase: room.phase, day: room.day, days: DAYS, game: room.game, cap: room.cap,
      entrants: room.entrants, result: room.result, night: room.night, players: [...room.players.values()],
      dice: room.dice,
      pg: room.pg && { round: room.pg.round, rounds: room.pg.rounds, probs: room.pg.probs, mults: room.pg.mults },
      nc: room.nc && { round: room.nc.round, rounds: room.nc.rounds, carry: room.nc.carry, picks: room.nc.shown }, // 고른 숫자는 공개(ncReveal) 전까지 절대 안 내보낸다
      vote: room.vote && { options: room.vote.options, votes: room.vote.votes, counts: voteCounts(room), left: room.vote.until - Date.now(), pick: room.vote.pick, game: room.vote.game },
      bj: room.bj && { hand: room.bj.hand, hands: room.bj.hands, hidden: room.bj.hidden, // 덱과 딜러의 뒷장은 절대 내보내지 않는다
        dealer: room.bj.hidden ? room.bj.dealer.map((c, i) => (i === 1 ? null : c)) : room.bj.dealer } },
  });
}

// 방 목록: 아직 방에 안 들어간(타이틀 화면의) 모든 접속자에게 보낸다
function roomList() {
  return { type: "rooms", max: MAX_PLAYERS, rooms: [...rooms.values()].map((r) => ({
    id: r.code, title: r.title, count: r.players.size, day: r.day, days: DAYS, host: (r.players.values().next().value || {}).name || "",
  })) };
}

function broadcastRoomList() {
  const data = JSON.stringify(roomList());
  wss.clients.forEach((ws) => { if (!ws.room && ws.readyState === ws.OPEN) ws.send(data); });
}

const raceMsg = (room) => ({ type: "race", pos: room.race.pos, fx: room.race.fx, elapsed: Date.now() - room.raceStart });

// 채팅창에 찍히는 시스템 안내
function sys(room, text) {
  broadcast(room, { type: "chat", sys: true, text });
}

// ---------- 게임 투표 (매일 낮 전) ----------
// 카드 3장 + 무작위 중 하나에 투표. 칸별 확률 = 득표 / 전체 표 (아무도 안 찍으면 카드 3장 균등). 무작위가 뽑히면 전체 GAMES에서 하나.
const playable = (room) => GAMES.filter((g) => room.players.size >= (g.min || 1));

function startVote(room) {
  if (process.env.GAME) return startDay(room); // 컨텐츠 고정(테스트용)이면 투표할 게 없다
  room.phase = "vote";
  room.vote = { options: shuffle(playable(room).map((g) => g.key)).slice(0, 3), votes: {}, until: Date.now() + VOTE_SECONDS * 1000, pick: null, game: null };
  for (const p of room.players.values()) p.ready = false;
  sys(room, "🗳️ DAY " + (room.day + 1) + " — 오늘 할 도박을 골라주세요!");
  broadcastRoom(room);
  room.timer = setTimeout(() => resolveVote(room), VOTE_SECONDS * 1000);
}

function voteCounts(room) { // 나간 사람의 표는 안 센다
  const counts = [0, 0, 0, 0];
  for (const p of room.players.values()) if (p.id in room.vote.votes) counts[room.vote.votes[p.id]]++;
  return counts;
}

function checkVoteReady(room) {
  if (room.phase !== "vote" || room.vote.pick !== null) return;
  for (const p of room.players.values()) if (!p.ready) return;
  resolveVote(room);
}

function resolveVote(room) {
  clearTimeout(room.timer);
  const V = room.vote, counts = voteCounts(room), weights = counts.some((c) => c) ? counts : [1, 1, 1, 0];
  let r = Math.random() * weights.reduce((a, b) => a + b, 0), pick = 0;
  for (; pick < 3 && r >= weights[pick]; pick++) r -= weights[pick];
  V.pick = pick;
  const pool = playable(room);
  V.game = pick < 3 ? V.options[pick] : pool[Math.floor(Math.random() * pool.length)].key;
  broadcastRoom(room); // 결과는 클라이언트가 룰렛을 다 돌린 뒤에 보여준다 (채팅으로 미리 알리지 않음)
  room.timer = setTimeout(() => startDay(room, V.game), VOTE_REVEAL);
}

function startDay(room, key) {
  room.day++;
  const game = GAMES.find((g) => g.key === (process.env.GAME || key)) || GAMES[Math.floor(Math.random() * GAMES.length)]; // GAME=blackjack 로 고정 가능(테스트용)
  room.game = game.key;
  room.cap = game.cap(room.day);
  room.phase = "betting";
  room.entrants = game.key === "derby" ? pickEntrants() : null;
  room.bj = game.key === "blackjack" ? { hand: 1, hands: BJ_HANDS, dealer: [], hidden: true, deck: bjDeck() } : null;
  room.pg = game.key === "penguin" ? { round: 1, rounds: PG_ROUNDS, probs: PG_PROBS, mults: PG_MULTS } : null;
  room.dice = game.key === "dice" ? { round: 1, rounds: DICE_ROUNDS, odds: DICE_BETS.map((b) => b.odds), roll: null } : null;
  room.nc = game.key === "nunchi" ? { round: 1, rounds: NC_ROUNDS, carry: 0, picks: {}, shown: null } : null;
  room.race = null;
  room.result = null;
  room.night = null;
  room.vote = null;
  for (const p of room.players.values()) Object.assign(p, { ready: false, begging: false, begged: false, bets: {}, bj: null, pg: null, dayStart: p.money });
  if (room.day === 1) broadcastRoomList(); // 목록에 "대기 중" → "DAY 1/7"
  sys(room, "☀️ DAY " + room.day + "/" + DAYS + " — 오늘의 도박은 " + game.name + "! (" + (room.bj ? BJ_HANDS + "판 · 판당 " : room.dice ? DICE_ROUNDS + "판 · 판당 " : room.pg ? PG_ROUNDS + "판 · 판당 " : "") + "베팅 상한 $" + room.cap + ")");
  if (room.nc) sys(room, "🙊 1~10 중 남과 안 겹친 가장 작은 숫자가 판돈 독식! (판당 참가비 $" + room.cap + ")");
  broadcastRoom(room);
  checkAllReady(room); // 전원 탄광행이면 아무도 준비할 사람이 없다 → 바로 진행
}

function checkAllReady(room) {
  if (room.phase !== "betting" || room.players.size === 0) return;
  for (const p of room.players.values()) if (!p.ready && !p.mining) return;
  if (room.game === "blackjack") return bjDeal(room);
  if (room.game === "dice") return diceRoll(room);
  if (room.game === "penguin") return pgStart(room);
  if (room.game === "nunchi") return ncReveal(room);
  room.phase = "countdown";
  broadcastRoom(room);
  countdown(room, 3);
}

function countdown(room, n) {
  if (n <= 0) return startRace(room);
  broadcast(room, { type: "countdown", n });
  room.timer = setTimeout(() => countdown(room, n - 1), 800);
}

function startRace(room) {
  room.phase = "racing";
  room.race = simulate(room.entrants, true);
  room.raceStart = Date.now();
  broadcastRoom(room);
  broadcast(room, raceMsg(room));
  room.timer = setTimeout(() => finishRace(room), room.race.duration * 1000);
}

function finishRace(room) {
  room.phase = "result";
  const order = room.race.order;
  room.result = { order, payouts: settle([...room.players.values()], room.entrants, order[0]) };
  broadcastRoom(room);
  room.timer = setTimeout(() => startNight(room), 6000);
}

// ---------- 블랙잭 ----------
// 카드는 "A0" "103" "K2"처럼 [랭크][무늬 0~3]. 딜러 공용, 플레이어는 각자 동시에 진행한다(서로 영향이 없으니 차례를 안 기다림).
// 규칙: 딜러는 17 이상에서 멈춤, 블랙잭 3:2, 더블다운(첫 두 장) 가능, 스플릿/인슈어런스 없음, 딜러는 끝에 가서야 뒷장을 깐다.
// 판돈은 경마와 같은 me.bets 에 0번 칸으로 넣는다 → bet/clear 핸들러를 그대로 쓴다.
function bjDeck() {
  const deck = [];
  for (let n = 0; n < 4; n++) for (const r of ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]) for (let s = 0; s < 4; s++) deck.push(r + s);
  return shuffle(deck); // 4벌 208장. 하루 3판 × 5명분으로는 절대 안 떨어진다
}

function bjTotal(cards) {
  let t = 0, aces = 0;
  for (const c of cards) {
    const r = c.slice(0, -1);
    if (r === "A") { aces++; t += 11; } else t += "KQJ".includes(r) ? 10 : Number(r);
  }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}

function bjDeal(room) {
  const B = room.bj;
  room.phase = "playing";
  B.dealer = [B.deck.pop(), B.deck.pop()];
  B.hidden = true;
  for (const p of room.players.values()) {
    if (!p.bets[0]) { p.bj = { cards: [], state: "out" }; continue; } // 안 건 사람(탄광·빈털터리 포함)은 이번 판 구경
    const cards = [B.deck.pop(), B.deck.pop()];
    p.bj = { cards, state: bjTotal(cards) === 21 ? "blackjack" : "playing" };
  }
  broadcastRoom(room);
  bjCheckDone(room);
}

function bjCheckDone(room) {
  if (room.phase !== "playing" || room.bj.hidden === false) return;
  for (const p of room.players.values()) if (p.bj && p.bj.state === "playing") return;
  room.bj.hidden = false; // 뒷장 공개
  broadcastRoom(room);
  room.timer = setTimeout(() => bjDealerStep(room), 1000);
}

// 딜러가 한 장씩 받는다(장당 0.8초, 보는 맛). 살아 있는 플레이어가 없으면 더 받을 필요가 없다.
function bjDealerStep(room) {
  const B = room.bj, alive = [...room.players.values()].some((p) => p.bj && (p.bj.state === "stand" || p.bj.state === "blackjack"));
  if (alive && bjTotal(B.dealer) < 17) {
    B.dealer.push(B.deck.pop());
    broadcastRoom(room);
    room.timer = setTimeout(() => bjDealerStep(room), 800);
    return;
  }
  bjSettle(room);
}

// win = 돌려받는 돈(판돈 포함). 블랙잭 2.5배, 승 2배, 푸시 1배, 패 0.
function bjOutcome(cards, state, dealer) {
  const d = bjTotal(dealer), dBJ = d === 21 && dealer.length === 2, t = bjTotal(cards);
  if (state === "bust") return ["bust", 0];
  if (state === "blackjack") return dBJ ? ["push", 1] : ["blackjack", 2.5];
  if (dBJ) return ["lose", 0];
  if (d > 21 || t > d) return ["win", 2];
  return t === d ? ["push", 1] : ["lose", 0];
}

function bjSettle(room) {
  const B = room.bj, payouts = {};
  for (const p of room.players.values()) {
    if (!p.bj || p.bj.state === "out") continue;
    const bet = p.bets[0], [outcome, k] = bjOutcome(p.bj.cards, p.bj.state, B.dealer), win = Math.floor(bet * k);
    p.money += win;
    p.bets = {};
    p.bj.state = outcome;
    payouts[p.id] = { bet, win, outcome };
  }
  room.phase = "result";
  room.result = { dealer: bjTotal(B.dealer), payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    if (B.hand >= B.hands) return startNight(room);
    B.hand++; B.dealer = []; B.hidden = true;
    room.phase = "betting";
    room.result = null;
    for (const p of room.players.values()) Object.assign(p, { ready: false, bj: null });
    broadcastRoom(room);
    checkAllReady(room);
  }, 5000);
}

function bjAction(room, me, a) {
  const st = me.bj;
  if (room.phase !== "playing" || !st || st.state !== "playing") return;
  if (a === "stand") st.state = "stand";
  else if (a === "hit" || a === "double") {
    if (a === "double") {
      if (st.cards.length !== 2 || me.money < me.bets[0]) return;
      me.money -= me.bets[0];
      me.bets[0] *= 2;
      st.doubled = true;
    }
    st.cards.push(room.bj.deck.pop());
    const t = bjTotal(st.cards);
    st.state = t > 21 ? "bust" : t === 21 || a === "double" ? "stand" : "playing";
  } else return;
  broadcastRoom(room);
  bjCheckDone(room);
}

// ---------- 펭귄 빙산 건너기 ----------
// 블랙잭처럼 판돈은 me.bets[0], 각자 자기 펭귄으로 동시에 진행한다. p.pg = { step(성공한 점프 수), state }
// state: playing | out(안 걸고 구경) | fell(풍덩) | stopped(멈추고 챙김) | goal(완주)
function pgStart(room) {
  room.phase = "playing";
  room.pg.settling = false;
  for (const p of room.players.values()) p.pg = { step: 0, state: p.bets[0] ? "playing" : "out" };
  broadcastRoom(room);
  pgCheckDone(room);
}

function pgAction(room, me, a) {
  const st = me.pg;
  if (room.phase !== "playing" || !room.pg || !st || st.state !== "playing") return;
  if (a === "stop") {
    if (st.step < 1) return; // 한 번은 뛰어야 한다
    st.state = "stopped";
  } else if (a === "go") {
    if (Date.now() - (st.last || 0) < 700) return; // 점프 연출(0.6초)보다 빨리 연타 못 하게
    st.last = Date.now();
    if (Math.random() < PG_PROBS[st.step]) { st.step++; if (st.step >= PG_PROBS.length) st.state = "goal"; }
    else st.state = "fell";
  } else return;
  broadcastRoom(room);
  pgCheckDone(room);
}

function pgCheckDone(room) {
  if (room.phase !== "playing" || room.pg.settling) return;
  for (const p of room.players.values()) if (p.pg && p.pg.state === "playing") return;
  room.pg.settling = true;
  room.timer = setTimeout(() => pgSettle(room), 1600); // 마지막 점프/풍덩 연출을 보고 나서 정산
}

function pgSettle(room) {
  const G = room.pg, payouts = {};
  for (const p of room.players.values()) {
    if (!p.pg || p.pg.state === "out") continue;
    const bet = p.bets[0], win = p.pg.state === "fell" ? 0 : Math.floor(bet * PG_MULTS[p.pg.step - 1]);
    p.money += win;
    p.bets = {};
    payouts[p.id] = { bet, win };
  }
  room.phase = "result";
  room.result = { payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    if (G.round >= G.rounds) return startNight(room);
    G.round++;
    room.phase = "betting";
    room.result = null;
    for (const p of room.players.values()) Object.assign(p, { ready: false, pg: null });
    broadcastRoom(room);
    checkAllReady(room);
  }, 5000);
}

// ---------- 눈치 숫자 ----------
// 1~10 중 하나를 몰래 고른다(판당 참가비 = room.cap 고정, me.bets[0]). 남과 안 겹친 숫자 중 가장 작은 걸 고른 사람이 판돈의 95% 독식.
// 전원 겹치면 판돈은 다음 판으로 이월, 그날 마지막 판까지 겹치면 참가자끼리 나눈다. 혼자 참가 + 이월금 0 = 무효(환불).
// 고른 숫자는 room.nc.picks에 서버만 들고 있다가 공개(ncReveal) 때 shown으로 내보낸다. 본인에겐 ncPick으로 따로 알려 준다.
const NC_ROUNDS = 3;
const NC_EDGE = 0.95;

function ncPick(room, ws, me, n) {
  const N = room.nc;
  if (!Number.isInteger(n) || n < 1 || n > 10) return;
  if (me.bets[0] && N.picks[me.id] === n) { // 같은 숫자를 다시 누르면 참가 취소(환불)
    me.money += me.bets[0];
    me.bets = {};
    delete N.picks[me.id];
    n = 0;
  } else if (!me.bets[0]) { // 처음 고를 때만 참가비를 낸다 (그 뒤엔 숫자만 바뀐다)
    if (me.money < room.cap) return send(ws, { type: "error", message: "참가비($" + room.cap + ")가 모자라요…" });
    me.money -= room.cap;
    me.bets[0] = room.cap;
  }
  if (n) N.picks[me.id] = n;
  send(ws, { type: "ncPick", n });
  broadcastRoom(room);
}

// 판정. picks = { playerId: 숫자 } (참가자만), pot = 이월금 + 참가비 합, carry = 이월금, last = 그날 마지막 판
function ncJudge(picks, pot, carry, last) {
  const ids = Object.keys(picks), cnt = {};
  for (const id of ids) cnt[picks[id]] = (cnt[picks[id]] || 0) + 1;
  if (!ids.length || (ids.length === 1 && !carry)) return { outcome: "void" }; // 아무도 없으면 그대로, 혼자면 환불
  const winner = ids.filter((id) => cnt[picks[id]] === 1).sort((a, b) => picks[a] - picks[b])[0];
  if (winner) return { outcome: "win", winner, prize: Math.floor(pot * NC_EDGE) };
  return last ? { outcome: "split", share: Math.floor(pot / ids.length) } : { outcome: "carry" };
}

// 전원 준비 → 숫자 공개. 판정은 지금 해 두고(도중에 누가 나가도 연출과 결과가 안 어긋나게) 돈은 뒤집기 연출이 끝난 뒤에 움직인다.
// 클라이언트가 작은 숫자부터 0.7초 간격으로 팻말을 뒤집는다 → 1초 + 0.7초 × 숫자 개수 뒤 정산
function ncReveal(room) {
  const N = room.nc;
  N.shown = {};
  N.pot = N.carry;
  for (const p of room.players.values()) if (p.bets[0] && N.picks[p.id]) { N.shown[p.id] = N.picks[p.id]; N.pot += p.bets[0]; } // clear로 참가비를 빼 갔으면 무효
  N.res = ncJudge(N.shown, N.pot, N.carry, N.round >= N.rounds);
  room.phase = "ncReveal";
  broadcastRoom(room);
  room.timer = setTimeout(() => ncSettle(room), 1000 + 700 * new Set(Object.values(N.shown)).size);
}

function ncSettle(room) {
  const N = room.nc, R = N.res, payouts = {};
  for (const p of room.players.values()) {
    if (!(p.id in N.shown)) continue;
    const bet = p.bets[0], win = R.outcome === "void" ? bet : R.outcome === "split" ? R.share : p.id === R.winner ? R.prize : 0;
    p.money += win;
    p.bets = {};
    payouts[p.id] = { bet, win };
  }
  if (R.outcome !== "void") N.carry = R.outcome === "carry" ? N.pot : 0; // 무효면 이월금은 그대로
  room.phase = "result";
  room.result = { picks: N.shown, outcome: R.outcome, winner: R.winner, pot: N.pot, carry: N.carry, payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => ncNext(room), 5500);
}

function ncNext(room) {
  const N = room.nc;
  if (N.round >= N.rounds) return startNight(room);
  Object.assign(N, { round: N.round + 1, picks: {}, shown: null, res: null });
  room.phase = "betting";
  room.result = null;
  for (const p of room.players.values()) p.ready = false;
  broadcastRoom(room);
  checkAllReady(room);
}

// ---------- 주사위 ----------
// 모두 준비되면 서버가 굴린다. 값은 바로 내려가지만(베팅은 이미 잠김) 클라이언트가 3초쯤 굴리는 연출을 한 뒤에 보여주고,
// 돈은 그 연출이 끝나는 시점(diceSettle)에 맞춰 움직인다.
function diceRoll(room) {
  room.phase = "rolling";
  room.dice.roll = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  broadcastRoom(room);
  room.timer = setTimeout(() => diceSettle(room), 3400);
}

function diceSettle(room) {
  const D = room.dice, [a, b] = D.roll, payouts = {};
  for (const p of room.players.values()) {
    const entries = Object.entries(p.bets);
    if (!entries.length) continue;
    let bet = 0, win = 0;
    for (const [i, amt] of entries) { bet += amt; if (DICE_BETS[i].win(a, b)) win += Math.floor(amt * DICE_BETS[i].odds); }
    p.money += win;
    p.bets = {};
    payouts[p.id] = { bet, win };
  }
  room.phase = "result";
  room.result = { roll: D.roll, hits: DICE_BETS.map((bt, i) => (bt.win(a, b) ? i : -1)).filter((i) => i >= 0), payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    if (D.round >= D.rounds) return startNight(room);
    D.round++; D.roll = null;
    room.phase = "betting";
    room.result = null;
    for (const p of room.players.values()) p.ready = false;
    broadcastRoom(room);
    checkAllReady(room);
  }, 5500);
}

function startNight(room) {
  room.phase = "night";
  room.night = {};
  sys(room, "🌙 DAY " + room.day + " 밤 — 정산 시간");
  for (const p of room.players.values()) {
    const wage = p.mining ? WAGE : 0;
    p.money += wage;
    p.mining = false;
    p.ready = false;
    p.history[room.day] = p.money;
    room.night[p.id] = { delta: p.money - p.dayStart, wage };
    if (wage) sys(room, "⛏️ " + p.name + " 탄광 일당 +$" + wage);
    if (p.money === 0) sys(room, "💸 " + p.name + " 파산! 한푼줍쇼는 딱 한 번…");
  }
  broadcastRoom(room);
}

// 파산자는 구걸을 한 번 해봤으면 더 할 게 없으니 준비된 걸로 친다 (나머지가 적선할지 말지 정하고 넘어간다)
function checkNightReady(room) {
  if (room.phase !== "night" || room.players.size === 0) return;
  for (const p of room.players.values()) if (!p.ready && !(p.money === 0 && p.begged)) return;
  for (const p of room.players.values()) {
    p.begging = false;
    if (p.money === 0 && room.day < DAYS) { p.mining = true; sys(room, "⛏️ " + p.name + " → 아오지 탄광행 (내일은 관전만)"); }
  }
  if (room.day < DAYS) return startVote(room);
  room.phase = "final";
  const top = [...room.players.values()].sort((a, b) => b.money - a.money)[0];
  sys(room, "🏆 일주일 끝! 최고의 도박꾼은 " + top.name + " ($" + top.money + ")");
  broadcastRoom(room);
}

function pickLook(room) {
  const others = [...room.players.values()].map((p) => p.look);
  const look = {};
  for (const [k, n] of Object.entries(LOOK_SIZES)) { // 방 안에서 최대한 안 겹치게
    const free = [...Array(n).keys()].filter((i) => !others.some((o) => o[k] === i));
    const pool = free.length ? free : [...Array(n).keys()];
    look[k] = pool[Math.floor(Math.random() * pool.length)];
  }
  return look;
}

function cleanName(n) {
  return String(n || "").trim().slice(0, 10) || "손님";
}

function joinRoom(ws, room, name) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  let color = 0;
  while (used.has(color)) color++;
  ws.room = room;
  // history[d] = d일차 밤의 자산 (0 = 시작). 도중 입장이면 그 전날까지는 null, 밤에 들어왔으면 오늘 값도 채운다 → 밤 그래프용
  const history = Array(Math.max(0, room.day - 1)).fill(null).concat(START_MONEY);
  if (room.phase === "night" || room.phase === "final") history[room.day] = START_MONEY;
  room.players.set(ws, { id: ws.id, name: cleanName(name), color, look: pickLook(room), money: START_MONEY, dayStart: START_MONEY, history,
    ready: false, begging: false, begged: false, mining: false, bets: {} });
  send(ws, { type: "joined", playerId: ws.id });
  broadcastRoom(room);
  broadcastRoomList();
  if (room.phase === "racing") send(ws, raceMsg(room)); // 경주 도중 입장하면 이어서 관전
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.players.delete(ws);
  if (room.players.size === 0) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    broadcastRoomList();
    return;
  }
  broadcastRoom(room);
  broadcastRoomList();
  checkAllReady(room); // 나간 사람만 준비를 안 했던 경우
  checkNightReady(room);
  checkVoteReady(room);
  if (room.bj) bjCheckDone(room); // 나간 사람만 카드를 고민 중이었던 경우
  if (room.pg) pgCheckDone(room);
}

function handleMessage(ws, msg) {
  if (msg.type === "create") {
    if (ws.room) return;
    joinRoom(ws, createRoom(msg.title, msg.name), msg.name);
    return;
  }
  if (msg.type === "join") {
    if (ws.room) return;
    const room = rooms.get(String(msg.id || ""));
    if (!room) return send(ws, { type: "error", message: "방이 방금 사라졌어요." });
    if (room.players.size >= MAX_PLAYERS) return send(ws, { type: "error", message: "방이 꽉 찼어요. (최대 " + MAX_PLAYERS + "명)" });
    joinRoom(ws, room, msg.name);
    return;
  }

  const room = ws.room;
  if (!room) return;
  const me = room.players.get(ws);
  const canBet = room.phase === "betting" && !me.ready && !me.mining;
  if (msg.type === "bet" && room.nc) return; // 눈치 숫자는 ncPick으로만 참가한다 (참가비 고정)
  if (msg.type === "ncPick") { if (canBet && room.nc) ncPick(room, ws, me, msg.n); return; }

  if (msg.type === "start") {
    if (room.phase === "lobby") startVote(room);
  } else if (msg.type === "chat") {
    const text = String(msg.text || "").trim().slice(0, 120);
    if (!text || Date.now() - (ws.lastChat || 0) < 400) return; // 도배 방지
    ws.lastChat = Date.now();
    broadcast(room, { type: "chat", id: me.id, name: me.name, color: me.color, text });
  } else if (msg.type === "again") {
    if (room.phase !== "final") return;
    Object.assign(room, { phase: "lobby", day: 0, game: null, entrants: null, bj: null, dice: null, pg: null, race: null, result: null, night: null, vote: null });
    room.nc = null;
    for (const p of room.players.values()) Object.assign(p, { money: START_MONEY, dayStart: START_MONEY, history: [START_MONEY], ready: false, begging: false, begged: false, mining: false, bets: {} });
    broadcastRoom(room);
    broadcastRoomList();
  } else if (msg.type === "bet") {
    const i = msg.i;
    if (!canBet || !Number.isInteger(i) || i < 0 || i >= (room.entrants ? room.entrants.length : room.dice ? DICE_BETS.length : 1)) return; // 경마=출전 수, 주사위=베팅 칸 수, 블랙잭=0번 칸 하나
    const spent = Object.values(me.bets).reduce((a, b) => a + b, 0);
    const amount = Math.min(Math.floor(Number(msg.amount)), me.money, room.cap - spent); // 크게 오면 상한(또는 가진 돈)까지만
    if (!(amount > 0)) return;
    me.money -= amount;
    me.bets[i] = (me.bets[i] || 0) + amount;
    broadcastRoom(room);
  } else if (msg.type === "clear") {
    if (!canBet) return;
    for (const v of Object.values(me.bets)) me.money += v;
    me.bets = {};
    broadcastRoom(room);
  } else if (msg.type === "ready") {
    if ((room.phase !== "betting" || me.mining) && room.phase !== "night" && room.phase !== "vote") return;
    me.ready = !!msg.v;
    broadcastRoom(room);
    checkAllReady(room);
    checkNightReady(room);
    checkVoteReady(room);
  } else if (msg.type === "vote") {
    if (room.phase !== "vote" || room.vote.pick !== null || me.ready || ![0, 1, 2, 3].includes(msg.i)) return; // 준비하면 표가 잠긴다
    room.vote.votes[me.id] = msg.i;
    broadcastRoom(room);
  } else if (msg.type === "pg") {
    pgAction(room, me, msg.a);
  } else if (msg.type === "bj") {
    bjAction(room, me, msg.a);
  } else if (msg.type === "beg") {
    // 밤 정산 때 파산한 사람만, 하룻밤에 딱 한 번. (취소하면 기회는 날아간다)
    if (room.phase !== "night") return;
    if (msg.v && (me.money > 0 || me.begged)) return;
    me.begging = !!msg.v;
    if (msg.v) { me.begged = true; sys(room, "🥺 " + me.name + ": 한푼 줍쇼!"); }
    broadcastRoom(room);
    checkNightReady(room);
  } else if (msg.type === "give") {
    const to = [...room.players.values()].find((p) => p.id === msg.to);
    if (!to || to === me || !to.begging) return;
    if (me.money < ALMS) return send(ws, { type: "error", message: "적선할 돈($" + ALMS + ")이 없어요…" });
    me.money -= ALMS;
    to.money += ALMS;
    to.begging = false; // 누가 한 번 주면 그걸로 끝
    me.history[room.day] = me.money; // 적선은 밤에만 일어난다 → 오늘 밤 그래프에 반영
    to.history[room.day] = to.money;
    sys(room, "🪙 " + me.name + " → " + to.name + " $" + ALMS + " 적선");
    broadcast(room, { type: "toast", text: "🪙 " + me.name + " → " + to.name + " $" + ALMS + " 적선!", coin: true });
    broadcastRoom(room);
  } else if (msg.type === "leave") {
    leaveRoom(ws);
  }
}

wss.on("connection", (ws) => {
  ws.id = crypto.randomUUID();
  ws.room = null;
  ws.isAlive = true;
  send(ws, roomList());
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg && typeof msg === "object") handleMessage(ws, msg);
  });
  ws.on("close", () => leaveRoom(ws));
});

// 끊긴 연결 정리 (30초마다 핑)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000).unref();

// 셀프 체크: `node server.js --check` — 8마리 기본 승률표 출력 + 배당/정산 검증
if (process.argv.includes("--check")) {
  const all = ANIMALS.map((x, a) => ({ a, key: x.key, k: 1 }));
  const N = 20000, wins = all.map(() => 0);
  let dur = 0;
  for (let i = 0; i < N; i++) wins[simulate(all, false).order[0]]++;
  for (let i = 0; i < 200; i++) dur += simulate(all, true).duration;
  all.forEach((e, i) => console.log(e.key.padEnd(9), (wins[i] / N * 100).toFixed(1).padStart(5) + "%"));
  console.log("평균 경주 시간", (dur / 200).toFixed(1) + "초");
  assert(wins.every((w) => w / N > 0.03 && w / N < 0.35), "승률이 한쪽으로 쏠렸어요");

  const entrants = pickEntrants();
  const implied = entrants.reduce((s, e) => s + EDGE / e.odds, 0);
  console.log("샘플 배당", entrants.map((e) => e.key + " x" + e.odds).join(", "), "| 내재확률 합", implied.toFixed(2));
  assert(entrants.length === FIELD && Math.abs(implied - 1) < 0.1);

  const r = simulate(entrants, true);
  assert(r.pos[r.order[0]].some((p) => p >= TRACK) && r.pos.every((p) => p.length === r.fx[0].length));

  entrants[2].odds = 3.5;
  const p = { id: "p", money: 700, bets: { 2: 100, 4: 200 } };
  assert.deepStrictEqual(settle([p], entrants, 2), { p: { bet: 300, win: 350 } });
  assert(p.money === 1050 && Object.keys(p.bets).length === 0);
  // 펭귄: 어디서 멈추든 기대 환급률이 95%인지 + 운을 조작한 한 판 (성공 2번 후 멈춤 / 첫 점프에 풍덩)
  PG_MULTS.forEach((m, k) => assert(Math.abs(m * PG_PROBS.slice(0, k + 1).reduce((a, b) => a * b, 1) - PG_EDGE) < 0.01, "펭귄 " + (k + 1) + "칸 환급률이 어긋남"));
  console.log("펭귄 배당", PG_MULTS.map((m, k) => Math.round(PG_PROBS[k] * 100) + "%→x" + m).join(" "));
  process.env.GAME = "penguin";
  const fp = () => ({ id: crypto.randomUUID(), room: null, readyState: 0, OPEN: 1, send() {} });
  const g1 = fp(), g2 = fp();
  handleMessage(g1, { type: "create", name: "G1" });
  handleMessage(g2, { type: "join", id: g1.room.code, name: "G2" });
  handleMessage(g1, { type: "start" });
  const gr = g1.room, G1 = gr.players.get(g1), G2 = gr.players.get(g2), realRandom = Math.random;
  handleMessage(g1, { type: "bet", i: 0, amount: 100 });
  handleMessage(g2, { type: "bet", i: 0, amount: 50 });
  handleMessage(g1, { type: "ready", v: true });
  handleMessage(g2, { type: "ready", v: true });
  assert(gr.phase === "playing" && G1.pg.state === "playing");
  handleMessage(g1, { type: "pg", a: "stop" });
  assert(G1.pg.state === "playing", "한 번도 안 뛰고는 못 멈춘다");
  Math.random = () => 0; // 무조건 성공
  handleMessage(g1, { type: "pg", a: "go" });
  handleMessage(g1, { type: "pg", a: "go" }); // 연타는 무시 (0.7초 제한)
  assert(G1.pg.step === 1);
  G1.pg.last = 0;
  handleMessage(g1, { type: "pg", a: "go" });
  handleMessage(g1, { type: "pg", a: "stop" });
  Math.random = () => 0.99; // 무조건 실패
  handleMessage(g2, { type: "pg", a: "go" });
  Math.random = realRandom;
  assert(G1.pg.state === "stopped" && G1.pg.step === 2 && G2.pg.state === "fell" && gr.pg.settling);
  clearTimeout(gr.timer);
  pgSettle(gr);
  clearTimeout(gr.timer);
  assert(G1.money === 900 + 124 && G2.money === 950 && gr.result.payouts[G1.id].win === 124, "2칸(x1.24)에서 멈추면 $124, 풍덩은 0");
  delete process.env.GAME;
  rooms.delete(gr.code);

  // 눈치 숫자: 3명 — 1판 A=1,B=1,C=2 → C 독식 / 2판 전원 3 → 이월 / 3판 A=2,B=4,C 구경 → A가 이월금까지. 숫자는 공개 전까지 안 샌다
  assert.deepStrictEqual(ncJudge({ a: 3, b: 3 }, 200, 0, true), { outcome: "split", share: 100 });
  assert.deepStrictEqual(ncJudge({ a: 3 }, 100, 0, false), { outcome: "void" }, "혼자 + 이월금 0 = 무효");
  assert.deepStrictEqual(ncJudge({ a: 3 }, 400, 300, false), { outcome: "win", winner: "a", prize: 380 }, "혼자라도 이월금이 있으면 꿀꺽");
  process.env.GAME = "nunchi";
  const fw = () => { const w = { id: crypto.randomUUID(), room: null, readyState: 1, OPEN: 1, sent: [] }; w.send = (d) => w.sent.push(JSON.parse(d)); return w; };
  const nw = [fw(), fw(), fw()];
  handleMessage(nw[0], { type: "create", name: "A" });
  handleMessage(nw[1], { type: "join", id: nw[0].room.code, name: "B" });
  const nr = nw[0].room;
  assert(!playable(nr).some((g) => g.key === "nunchi"), "둘이면 투표 후보에 없다");
  handleMessage(nw[2], { type: "join", id: nr.code, name: "C" });
  assert(playable(nr).some((g) => g.key === "nunchi"));
  handleMessage(nw[0], { type: "start" });
  const [NA, NB, NC] = nw.map((w) => nr.players.get(w));
  assert(nr.game === "nunchi" && nr.cap === 100 && nr.phase === "betting");
  handleMessage(nw[0], { type: "bet", i: 0, amount: 100 });
  assert(!NA.bets[0] && NA.money === 1000, "제네릭 bet은 막힌다");
  const ncRound = (acts) => { // acts = [[플레이어 번호, 숫자], ...] → 전원 준비 → 공개 → 정산
    nw.forEach((w) => { w.sent = []; });
    for (const [k, n] of acts) handleMessage(nw[k], { type: "ncPick", n });
    nw.forEach((w) => handleMessage(w, { type: "ready", v: true }));
    assert(nr.phase === "ncReveal" && nw[1].sent.at(-1).room.nc.picks);
    assert(nw.flatMap((w) => w.sent).every((m) => m.type !== "room" || m.room.phase !== "betting" || m.room.nc.picks == null), "공개 전엔 숫자가 브로드캐스트에 없다");
    clearTimeout(nr.timer);
    ncSettle(nr);
    clearTimeout(nr.timer);
    return nr.result;
  };
  let nres = ncRound([[0, 5], [0, 1], [1, 1], [2, 7], [2, 7], [2, 2]]); // A는 5→1로 바꿈(참가비 한 번만), C는 7 → 7(취소·환불) → 2
  assert.deepStrictEqual(nw[2].sent.filter((m) => m.type === "ncPick").map((m) => m.n), [7, 0, 2], "내 숫자는 나한테만");
  assert(nres.outcome === "win" && nres.winner === NC.id && nres.pot === 300 && nres.carry === 0);
  assert(NA.money === 900 && NB.money === 900 && NC.money === 900 + 285, "C가 floor(300×0.95)=285 독식");
  ncNext(nr);
  nres = ncRound([[0, 3], [1, 3], [2, 3]]);
  assert(nres.outcome === "carry" && nres.carry === 300 && nr.nc.carry === 300 && NA.money === 800 && NC.money === 1085, "전원 겹침 → 이월");
  ncNext(nr);
  NC.money = 50;
  handleMessage(nw[2], { type: "ncPick", n: 1 });
  assert(!NC.bets[0] && nw[2].sent.at(-1).type === "error", "참가비가 모자라면 거절");
  NC.money = 1085;
  nres = ncRound([[0, 2], [1, 4]]);
  assert(nres.outcome === "win" && nres.winner === NA.id && nres.pot === 500 && !nres.payouts[NC.id]);
  assert(NA.money === 800 - 100 + 475 && NB.money === 700 && NC.money === 1085 && nr.nc.carry === 0, "A가 floor(500×0.95)=475");
  ncNext(nr);
  assert(nr.phase === "night", "3판 끝나면 밤");
  clearTimeout(nr.timer);
  delete process.env.GAME;
  rooms.delete(nr.code);

  // 주사위: 경우의 수·배당·기대 환급률, 그리고 짜고 굴린 한 판
  assert.deepStrictEqual(DICE_BETS.slice(0, 5).map((b) => b.ways), [18, 18, 15, 15, 6]);
  assert.deepStrictEqual(DICE_BETS.slice(5).map((b) => b.ways), [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]);
  for (const b of DICE_BETS) assert(Math.abs(b.odds * b.ways / 36 - DICE_EDGE) < 0.02, b.key + " 환급률이 어긋남");
  console.log("주사위 배당", DICE_BETS.map((b) => b.key + " x" + b.odds).join(", "));
  process.env.GAME = "dice";
  const fd = () => ({ id: crypto.randomUUID(), room: null, readyState: 0, OPEN: 1, send() {} });
  const d1 = fd();
  handleMessage(d1, { type: "create", name: "D1" });
  handleMessage(d1, { type: "start" });
  const dr = d1.room, D1 = dr.players.get(d1);
  assert(dr.game === "dice" && dr.cap === 100 && dr.dice.odds.length === 16);
  handleMessage(d1, { type: "bet", i: 0, amount: 40 });   // 홀
  handleMessage(d1, { type: "bet", i: 10, amount: 999 }); // 합 7 (상한 100에서 남은 60까지만)
  handleMessage(d1, { type: "bet", i: 16, amount: 10 });  // 없는 칸
  assert(D1.bets[0] === 40 && D1.bets[10] === 60 && D1.money === 900 && !(16 in D1.bets));
  handleMessage(d1, { type: "ready", v: true });
  assert(dr.phase === "rolling" && dr.dice.roll.every((v) => v >= 1 && v <= 6));
  clearTimeout(dr.timer);
  dr.dice.roll = [3, 4]; // 합 7: 홀 적중(40×1.9=76) + 단일 7 적중(60×5.7=342)
  diceSettle(dr);
  clearTimeout(dr.timer);
  assert.deepStrictEqual(dr.result.hits, [0, 10]);
  assert(D1.money === 900 + 76 + 342 && dr.result.payouts[D1.id].win === 418, "7이면 업/다운은 둘 다 꽝, 홀과 단일 7만 적중");
  delete process.env.GAME;
  rooms.delete(dr.code);

  // 블랙잭: 합계 / 승패 / 짜고 치는 덱으로 한 판
  assert(bjTotal(["A0", "K1"]) === 21 && bjTotal(["A0", "A1", "92"]) === 21 && bjTotal(["K0", "Q1", "52"]) === 25);
  assert.deepStrictEqual(bjOutcome(["A0", "K1"], "blackjack", ["K0", "92"]), ["blackjack", 2.5]);
  assert.deepStrictEqual(bjOutcome(["A0", "K1"], "blackjack", ["A2", "K2"]), ["push", 1]);
  assert.deepStrictEqual(bjOutcome(["K0", "92"], "stand", ["K1", "62", "83"]), ["win", 2]); // 딜러 버스트
  assert.deepStrictEqual(bjOutcome(["K0", "82"], "stand", ["K1", "92"]), ["lose", 0]);
  process.env.GAME = "blackjack";
  const fk = () => ({ id: crypto.randomUUID(), room: null, readyState: 0, OPEN: 1, send() {} });
  const w1 = fk(), w2 = fk();
  handleMessage(w1, { type: "create", name: "P1" });
  handleMessage(w2, { type: "join", id: w1.room.code, name: "P2" });
  handleMessage(w1, { type: "start" });
  const br = w1.room, P1 = br.players.get(w1), P2 = br.players.get(w2);
  assert(br.game === "blackjack" && br.cap === 100 && !br.entrants);
  handleMessage(w1, { type: "bet", i: 0, amount: 999 });
  handleMessage(w2, { type: "bet", i: 0, amount: 50 });
  assert(P1.bets[0] === 100 && P1.money === 900, "판당 상한");
  // 덱은 뒤에서부터 뽑힌다: 딜러 2장 → P1 2장 → P2 2장 → P1 더블 1장 → P2 히트 1장 → 딜러 추가 1장
  br.bj.deck = ["51", "K3", "K2", "70", "91", "63", "50", "62", "K0"]; // pop: K0,62(딜러 16) 50,63(P1 11) 91,70(P2 16) K2(P1 더블→21) K3(P2 히트→버스트) 51(딜러→21)
  handleMessage(w1, { type: "ready", v: true });
  handleMessage(w2, { type: "ready", v: true });
  assert(br.phase === "playing" && bjTotal(P1.bj.cards) === 11 && bjTotal(P2.bj.cards) === 16);
  handleMessage(w1, { type: "bj", a: "double" });
  assert(P1.bets[0] === 200 && P1.money === 800 && P1.bj.state === "stand");
  handleMessage(w2, { type: "bj", a: "hit" });
  assert(P2.bj.state === "bust" && br.bj.hidden === false, "전원 끝나면 딜러 뒷장 공개");
  while (br.phase === "playing") { clearTimeout(br.timer); bjDealerStep(br); }
  clearTimeout(br.timer);
  assert(br.result.dealer === 21 && br.result.payouts[P1.id].outcome === "push" && P1.money === 1000 && P2.money === 950);
  delete process.env.GAME;
  rooms.delete(br.code);

  // 메타 흐름: 베팅 상한 → 밤에 파산 → 구걸 실패 → 다음 날 탄광(관전) → 그날 밤 일당
  const fake = () => ({ id: crypto.randomUUID(), room: null, readyState: 0, OPEN: 1, send() {} });
  const wa = fake(), wb = fake();
  handleMessage(wa, { type: "create", name: "A", title: "t" });
  const rm = wa.room;
  handleMessage(wb, { type: "join", id: rm.code, name: "B" });
  process.env.GAME = "derby";
  handleMessage(wa, { type: "start" });
  const A = rm.players.get(wa), B = rm.players.get(wb);
  assert(rm.day === 1 && rm.cap === 300 && A.look && (A.look.hair !== B.look.hair));
  handleMessage(wa, { type: "bet", i: 0, amount: 99999 });
  assert(A.bets[0] === 300 && A.money === 700, "상한까지만 걸려야 함");
  clearTimeout(rm.timer); A.bets = {}; A.money = 0;
  startNight(rm);
  handleMessage(wa, { type: "beg", v: true });
  handleMessage(wa, { type: "beg", v: true }); // 두 번째는 무시
  assert(A.begging && rm.phase === "night");
  handleMessage(wb, { type: "ready", v: true }); // B가 안 주고 넘김 → A는 탄광행
  assert(rm.day === 2 && A.mining && !A.begging && rm.phase === "betting");
  handleMessage(wa, { type: "bet", i: 0, amount: 10 });
  assert(!A.bets[0], "탄광에선 베팅 불가");
  handleMessage(wb, { type: "ready", v: true });
  assert(rm.phase === "countdown", "탄광에 간 A는 빼고 B만 준비하면 진행");
  clearTimeout(rm.timer);
  startNight(rm);
  assert(A.money === WAGE && !A.mining && rm.night[A.id].wage === WAGE);
  assert.deepStrictEqual(A.history, [START_MONEY, 0, WAGE]);
  handleMessage(wb, { type: "beg", v: true }); // 파산이 아니면 무시
  B.money = 500; A.money = 0; A.begged = false;
  handleMessage(wa, { type: "beg", v: true });
  handleMessage(wb, { type: "give", to: A.id });
  assert(A.history[2] === ALMS && B.history[2] === 400 && !A.begging, "적선은 그래프 기록에도 반영");

  // 게임 투표: 없는 칸·준비 후 변경은 무시, 전원이 같은 칸이면 100% 그게 뽑히고, 전원 준비하면 타이머 없이 바로 추첨
  delete process.env.GAME;
  const v1 = fake(), v2 = fake();
  handleMessage(v1, { type: "create", name: "V1" });
  handleMessage(v2, { type: "join", id: v1.room.code, name: "V2" });
  handleMessage(v1, { type: "start" });
  const vr = v1.room;
  assert(vr.phase === "vote" && vr.day === 0 && new Set(vr.vote.options).size === 3);
  handleMessage(v1, { type: "vote", i: 4 });
  handleMessage(v1, { type: "vote", i: 2 });
  handleMessage(v1, { type: "ready", v: true });
  handleMessage(v1, { type: "vote", i: 0 });
  handleMessage(v2, { type: "vote", i: 2 });
  assert.deepStrictEqual(voteCounts(vr), [0, 0, 2, 0]);
  handleMessage(v2, { type: "ready", v: true });
  const voted = vr.vote.options[2];
  assert(vr.vote.pick === 2 && vr.vote.game === voted);
  clearTimeout(vr.timer);
  startDay(vr, voted);
  assert(vr.phase === "betting" && vr.day === 1 && vr.game === voted && !vr.vote);
  console.log("OK");
  process.exit(0);
}

const PORT = process.env.PORT || 3100;
server.listen(PORT, () => {
  console.log("우당탕 도박 일주일 서버 실행 중 - 포트 " + PORT);
});
