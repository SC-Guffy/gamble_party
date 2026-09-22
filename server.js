// 뒷방 한탕 - 서버 기반 4인 베팅 게임 (wasd-tori-server와 같은 뼈대: Node 내장 모듈만 사용)
// 메타: 각자 $1000으로 시작해 방장이 정한 날수(기본 7일) 동안 가장 많이 불린 사람이 우승.
//   투표 = 랜덤 3개 게임 + 무작위 중에서 골라 득표 비례 확률로 추첨 → 낮 = 그날의 도박 컨텐츠 → 밤 = 정산.
//   밤에 파산($0)이면 한푼줍쇼 1회(또는 사채). 아무도 안 주면 다음 날은 아오지 탄광(게임은 관전, 곡괭이질 미니게임) → 그날 밤 일당 $100 + 캔 돈(최대 $1000).
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
const DAYS = Number(process.env.DAYS) || 7; // 새 방의 기본 진행 일수. 방장이 대기실에서 바꾼다 (1~MAX_DAYS)
const MAX_DAYS = 30;
const WAGE = 100; // 아오지 탄광 기본 일당 (+ 그날 캔 돈, 합계 최대 MN_MAX → 탄광 미니게임)
// 도박 컨텐츠 목록. cap(day) = 그날 한 사람이 걸 수 있는 총액 상한(올인 즉사 방지, 날이 갈수록 판이 커진다).
// free = 베팅 상한 없음(가진 돈까지). 배당이 낮거나(블랙잭 최고 x2.5) 본인이 위험을 조절하거나(코인) 상자 금액이 이미 상한 노릇을 하는(경매) 게임.
//   free여도 cap은 남는다: 경매 상자 금액의 기준, 판돈 연출의 크기 기준.
// 새 게임을 추가할 땐 여기에 등록하고 startDay에서 key별로 분기하면 된다. (투표 카드용으로 클라이언트 GINFO/drawArt에도)
// min = 최소 인원(없으면 1). 방 인원이 모자라면 투표 카드/무작위 후보에서 빠진다.
// 경마 = 하루 1경주, cap은 하루 총액. 블랙잭 = 하루 BJ_HANDS판, cap은 판당(더블다운은 상한과 별개로 판돈만큼 더 낸다).
// 한 판 최고 배수. 이보다 크면 한 방에 판이 끝난다(판당 상한이 있어서 나머지는 대박 말고는 못 따라잡고, 1등은 구경만 해도 이긴다).
// 경마·주사위는 여기서 배당을 자르고(롱샷만 하우스에 불리해짐), 풍선·펭귄·플링코는 규칙 자체를 이 안에 들어오게 만들었다.
const MAX_MULT = 15;
const GAMES = [
  { key: "derby", name: "경마", cap: (day) => 200 + 100 * day }, // st = 그날 상태가 담기는 room 필드(판수 안내용), capName = 하루 시작 안내에서 cap을 부르는 말
  { key: "blackjack", name: "블랙잭", cap: (day) => 50 + 50 * day, st: "bj", free: true },
  { key: "dice", name: "주사위", cap: (day) => 50 + 50 * day, st: "dice" }, // 하루 DICE_ROUNDS판, cap은 판당
  { key: "penguin", name: "펭귄 빙산 건너기", cap: (day) => 50 + 50 * day, st: "pg" }, // 하루 PG_ROUNDS판, cap은 판당
  { key: "nunchi", name: "눈치 숫자", cap: (day) => 50 + 50 * day, min: 3, st: "nc", capName: "참가비" }, // 하루 NC_ROUNDS판, cap = 판당 고정 참가비. 둘이면 1이 무조건 이득이라 3명부터
  { key: "indian", name: "인디언 포커", cap: (day) => 50 + 50 * day, min: 2, st: "ip", capName: "참가비" }, // 하루 IP_ROUNDS판, cap = 판당 참가비(고정). 콜도 같은 금액
  { key: "auction", name: "미스터리 상자 경매", cap: (day) => 100 + 100 * day, min: 2, st: "au", capName: "상자 기준가", free: true }, // 하루 AU_ROUNDS판, 상자 금액 = cap × AU_MULTS (입찰은 가진 돈까지)
  { key: "watergun", name: "러시안 룰렛", cap: (day) => 50 + 50 * day, min: 2, st: "wg", capName: "참가비" }, // 하루 WG_ROUNDS판, cap = 판당 고정 참가비
  { key: "balloon", name: "풍선 불기", cap: (day) => 50 + 50 * day, st: "bl" }, // 하루 BL_ROUNDS판, cap은 판당
  { key: "coin", name: "도박 코인 단타", cap: (day) => 100 + 100 * day, st: "cn", free: true }, // 하루 CN_ROUNDS판, 투자금은 가진 돈까지
  { key: "plinko", name: "플링코", cap: (day) => 50 + 50 * day, st: "pk" }, // 하루 PK_ROUNDS판, cap은 판당
  { key: "duel", name: "총잡이 결투", cap: (day) => 50 + 50 * day, min: 2, st: "du", capName: "참가비" }, // 하루 DU_ROUNDS판, cap = 판당 고정 참가비
  { key: "stopwatch", name: "블라인드 스톱워치", cap: (day) => 50 + 50 * day, min: 2, st: "sw", capName: "참가비" }, // 하루 SW_ROUNDS판, cap = 판당 고정 참가비
  { key: "dodge", name: "총알 피하기", cap: (day) => 50 + 50 * day, min: 2, st: "dg", capName: "참가비" }, // 하루 DG_ROUNDS판, cap = 판당 고정 참가비
];
// 펭귄 빙산 건너기: 점프할수록 성공률이 떨어지고, 배당은 0.95 ÷ (지금까지 성공률의 곱) → 어디서 멈추든 기대 환급률 95%.
// PG_MULTS[k] = k+1번 성공한 뒤 멈추면 받는 배수. 마지막(10번째) 점프에 성공하면 섬에 도착해서 자동으로 챙긴다.
const PG_ROUNDS = 3;
const PG_EDGE = 0.95;
const PG_PROBS = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55]; // 8칸 → 완주 x13.78 (MAX_MULT 안)
const pgMults = (probs) => probs.map((_, k) => Math.min(MAX_MULT, Math.round((PG_EDGE / probs.slice(0, k + 1).reduce((a, b) => a * b, 1)) * 100) / 100));
const PG_MULTS = pgMults(PG_PROBS);
// 황금 얼음: 매판 한 칸(첫 칸·마지막 칸 빼고)의 점프 성공률을 반으로 깎고, 배당은 거기서부터 두 배 → 어디서 멈추든 환급률 95% 그대로 (x15로 잘리는 칸만 하우스 쪽)
function pgGold(G) {
  G.gold = 1 + Math.floor(Math.random() * (PG_PROBS.length - 2)); // 점프 인덱스. 화면에선 gold+1번째 얼음
  G.probs = PG_PROBS.map((q, k) => (k === G.gold ? q / 2 : q));
  G.mults = pgMults(G.probs);
  return G;
}
const VOTE_REVEAL = 4500; // 추첨 후 룰렛 연출을 보여주고 낮을 시작하기까지(ms)
const BJ_HANDS = 3;
// 사이드벳 퍼펙트 페어(me.bets[1]): 처음 두 장이 같은 숫자면 x13. 4벌에서 두 번째 장이 첫 장과 같은 숫자일 확률 = 15/207 → 환급률 0.94
const BJ_PAIR = Math.floor((0.95 * 207) / 15);
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
  bet.odds = Math.min(MAX_MULT, Math.round((DICE_EDGE * 36 / ways) * 10) / 10); // 합 2·3·11·12는 x15로 잘린다
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
  return wins.map((w) => Math.min(MAX_MULT, Math.max(1.1, Math.round((EDGE / Math.max(w / n, 0.005)) * 10) / 10)));
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
    days: DAYS, // 방장이 대기실에서 정하는 진행 일수
    game: null,
    cap: 0,
    vote: null, // 게임 투표: { options: [게임 key 3개], votes: { playerId: 0~3 (3 = 무작위) }, pick, voter(뽑힌 표의 주인), game }
    night: null, // 밤 정산표: { playerId: { delta, wage } }
    entrants: null,
    race: null,
    raceStart: 0,
    result: null,
    timer: null,
    rcLeft: new Map(), // 재접속: 명시적으로 나간 사람의 스냅샷 (토큰 → {money, history…}). Map이라 혹시 JSON이 돼도 {}로 나간다
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
  ttRecord(room); // 시상식 칭호 통계 (새 결과일 때만 한 번 기록)
  broadcast(room, {
    type: "room",
    room: { code: room.code, title: room.title, phase: room.phase, day: room.day, days: room.days, game: room.game, cap: room.cap, free: room.free,
      entrants: room.entrants, result: room.result, night: room.night, players: [...room.players.values()],
      dice: room.dice,
      ip: room.ip && ipView(room.ip), // 카드·결정은 공개 전까지 절대 내보내지 않는다
      bl: room.bl && { round: room.bl.round, rounds: room.bl.rounds, rate: BL_RATE, max: BL_MAX, ff: BL_FF, elapsed: Date.now() - room.bl.t0, cash: room.bl.cash, crash: room.bl.crash, ffAt: room.bl.ffAt }, // hidden(터지는 배수)은 절대 내보내지 않는다
      pk: room.pk && { round: room.pk.round, rounds: room.pk.rounds, zoneOf: room.pk.zoneOf, odds: room.pk.odds, jack: room.pk.jack, jackMult: room.pk.jackMult, drops: room.pk.drops, since: Date.now() - room.pk.t0 }, // since = 첫 공 출발 후 경과(ms), 도중 입장해도 같은 장면
      pg: room.pg && { round: room.pg.round, rounds: room.pg.rounds, probs: room.pg.probs, mults: room.pg.mults, gold: room.pg.gold },
      cn: room.cn, // 코인: 지금까지의 가격 기록·체결 내역뿐 (미래 가격은 서버에도 없다). 도중 입장자도 이걸로 차트를 그린다
      wg: room.wg && wgPublic(room.wg),
      du: room.du && duPublic(room.du),
      sw: room.sw && swPublic(room.sw),
      dg: room.dg && dgPublic(room.dg),
      au: room.au && { round: room.au.round, rounds: room.au.rounds, vals: room.au.vals, probs: AU_PROBS, ev: AU_EV, reveal: room.au.reveal }, // 상자 금액·입찰액·힌트는 공개 전까지 절대 안 내보낸다
      nc: room.nc && { round: room.nc.round, rounds: room.nc.rounds, carry: room.nc.carry, picks: room.nc.shown }, // 고른 숫자는 공개(ncReveal) 전까지 절대 안 내보낸다
      vote: room.vote && { options: room.vote.options, votes: room.vote.votes, counts: voteCounts(room), pick: room.vote.pick, voter: room.vote.voter, game: room.vote.game },
      bj: room.bj && { hand: room.bj.hand, hands: room.bj.hands, pair: room.bj.pair, hidden: room.bj.hidden, // 덱과 딜러의 뒷장은 절대 내보내지 않는다
        dealer: room.bj.hidden ? room.bj.dealer.map((c, i) => (i === 1 ? null : c)) : room.bj.dealer } },
  });
}

// 방장 = 제일 먼저 들어와 있는 사람 (방장이 나가면 다음 사람이 이어받는다)
const hostOf = (room) => room.players.values().next().value;

// 방 목록: 아직 방에 안 들어간(타이틀 화면의) 모든 접속자에게 보낸다
function roomList() {
  return { type: "rooms", max: MAX_PLAYERS, rooms: [...rooms.values()].map((r) => ({
    id: r.code, title: r.title, count: r.players.size, day: r.day, days: r.days, host: (hostOf(r) || {}).name || "",
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
// 카드 3장 + 무작위 중 하나를 누르면 그게 곧 투표이자 준비. 전원이 누르는 순간 추첨한다(그 전엔 바꿔 눌러도 됨). 칸별 확률 = 득표 / 전체 표. 무작위가 뽑히면 전체 GAMES에서 하나.
// ponytail: 제한 시간 없음 → 안 누르는 사람이 있으면 멈춘다(베팅/밤 준비와 같은 방식). 잠수가 문제 되면 타이머를 다시 붙인다.
const playable = (room) => GAMES.filter((g) => room.players.size >= (g.min || 1));

function startVote(room) {
  if (process.env.GAME) return startDay(room); // 컨텐츠 고정(테스트용)이면 투표할 게 없다
  room.phase = "vote";
  room.vote = { options: shuffle(playable(room).map((g) => g.key)).slice(0, 3), votes: {}, pick: null, game: null };
  for (const p of room.players.values()) p.ready = false;
  sys(room, "🗳️ DAY " + (room.day + 1) + " — 오늘 할 도박을 골라주세요!");
  broadcastRoom(room);
}

function voteCounts(room) { // 나간 사람의 표는 안 센다
  const counts = [0, 0, 0, 0];
  for (const p of room.players.values()) if (p.id in room.vote.votes) counts[room.vote.votes[p.id]]++;
  return counts;
}

function checkVoteReady(room) {
  if (room.phase !== "vote" || room.vote.pick !== null) return;
  if ([...room.players.values()].every((p) => p.rcAway || p.id in room.vote.votes)) return resolveVote(room); // 재접속: 끊긴 사람(📴)은 표 없이 건너뛴다
  for (const p of room.players.values()) if (!(p.id in room.vote.votes)) return;
  resolveVote(room);
}

// 표 한 장을 무작위로 뽑는다 = 칸별 확률이 득표에 비례. 누구 표인지(voter)도 내려서 클라이언트 룰렛이 그 마크에서 멈춘다.
function resolveVote(room) {
  const V = room.vote, voters = [...room.players.values()].filter((p) => p.id in V.votes); // 전원이 찍은 뒤에만 불리니 최소 1장
  V.voter = voters[Math.floor(Math.random() * voters.length)].id;
  V.pick = V.votes[V.voter];
  const pool = playable(room);
  V.game = V.pick < 3 ? V.options[V.pick] : pool[Math.floor(Math.random() * pool.length)].key;
  broadcastRoom(room); // 결과는 클라이언트가 룰렛을 다 돌린 뒤에 보여준다 (채팅으로 미리 알리지 않음)
  room.timer = setTimeout(() => startDay(room, V.game), VOTE_REVEAL);
}

function startDay(room, key) {
  room.day++;
  const game = GAMES.find((g) => g.key === (process.env.GAME || key)) || GAMES[Math.floor(Math.random() * GAMES.length)]; // GAME=blackjack 로 고정 가능(테스트용)
  room.game = game.key;
  room.cap = game.cap(room.day);
  room.free = !!game.free;
  room.phase = "betting";
  room.entrants = game.key === "derby" ? pickEntrants() : null;
  room.bj = game.key === "blackjack" ? { hand: 1, hands: BJ_HANDS, pair: BJ_PAIR, dealer: [], hidden: true, deck: bjDeck() } : null;
  room.pg = game.key === "penguin" ? pgGold({ round: 1, rounds: PG_ROUNDS }) : null;
  room.wg = game.key === "watergun" ? { round: 1, rounds: WG_ROUNDS } : null;
  room.du = game.key === "duel" ? { round: 1, rounds: DU_ROUNDS } : null;
  room.sw = game.key === "stopwatch" ? { round: 1, rounds: SW_ROUNDS } : null;
  room.dg = game.key === "dodge" ? { round: 1, rounds: DG_ROUNDS } : null;
  room.bl = game.key === "balloon" ? { round: 1, rounds: BL_ROUNDS, t0: 0, hidden: null, cash: {}, crash: null, ffAt: 0 } : null;
  room.cn = game.key === "coin" ? { round: 1, rounds: CN_ROUNDS, ticks: CN_TICKS, fee: CN_FEE, ...cnFresh() } : null;
  room.dice = game.key === "dice" ? { round: 1, rounds: DICE_ROUNDS, odds: DICE_BETS.map((b) => b.odds), roll: null } : null;
  room.nc = game.key === "nunchi" ? { round: 1, rounds: NC_ROUNDS, carry: 0, picks: {}, shown: null } : null;
  room.ip = game.key === "indian" ? { round: 1, rounds: IP_ROUNDS, ids: [], cards: {}, calls: {}, open: false, until: 0 } : null;
  room.au = game.key === "auction" ? auDeal({ round: 1, rounds: AU_ROUNDS, vals: AU_MULTS.map((m) => Math.round(room.cap * m)) }) : null;
  room.pk = game.key === "plinko" ? pkJack({ round: 1, rounds: PK_ROUNDS, zoneOf: PK_ZONE_OF, drops: null, t0: 0 }) : null;
  room.race = null;
  room.result = null;
  room.night = null;
  room.vote = null;
  for (const p of room.players.values()) Object.assign(p, { ready: false, begging: false, begged: false, bets: {}, bj: null, pg: null, dayStart: p.money });
  for (const p of room.players.values()) p.cn = null;
  if (room.day === 1) broadcastRoomList(); // 목록에 "대기 중" → "DAY 1/7"
  const st = room[game.st], rounds = st && (st.rounds || st.hands);
  sys(room, "☀️ DAY " + room.day + "/" + room.days + " — 오늘의 도박은 " + game.name + "! (" + (rounds ? rounds + "판 · 판당 " : "1경주 · ") + (game.free ? "상한 없음 🔥" + (game.capName ? " · " + game.capName + " $" + room.cap : "") : (game.capName || "베팅 상한") + " $" + room.cap) + ")");
  if (room.nc) sys(room, "🙊 1~10 중 남과 안 겹친 가장 작은 숫자가 판돈 독식! 전원 겹치면 다음 판으로 이월");
  if (room.ip) sys(room, "🙈 내 카드만 못 봐요 · 20초 안에 콜($" + room.cap + " 더)/다이 · 10 들고 다이하면 벌금!");
  if (room.wg) sys(room, "💥 6칸 중 1칸에 총알 · 차례마다 당기기, 또는 참가비 절반 내고 넘기기(판당 1회) · 🔫🔫 연속 2발에서 살아남으면 몫 두 배!");
  if (room.du) sys(room, "🤠 \"쏴!\" 신호가 뜨면 제일 먼저 쏜 사람이 판돈 독식! 신호 전에 쏘면 오발로 아웃 · 🌭 가짜 신호 주의");
  if (room.sw) sys(room, "⏱️ 목표 시간에 맞춰 STOP! 숫자는 " + SW_SHOW + "초 뒤 사라져요 · 오차가 제일 작은 사람이 판돈 독식 · 목표 × 2까지 안 누르면 실격");
  if (room.dg) sys(room, "🎋 WASD/방향키(폰은 드래그)로 사방에서 날아오는 총알을 피하세요! 오래 버틴 순으로 판돈 1위 70% · 2위 30%");
  if (room.pg) sys(room, "✨ 매판 황금 얼음이 하나! 거기로 뛰는 점프는 성공률 반토막, 성공하면 배당 두 배");
  if (room.bl) sys(room, "🎈 터지기 전에 놓으면 그때 배수만큼! 못 놓고 터지면 판돈 전액 잃음 (최대 x" + BL_MAX + ") · 👑 제일 늦게 놓고 살아남은 1명은 남들 수익의 " + BL_LAST * 100 + "%를 떼 간다");
  if (room.cn) sys(room, "🪙 " + (CN_TICKS * CN_TICK) / 1000 + "초 장 · 현금으로 시작, 매수 = 전액 코인 / 매도 = 전액 현금 (거래마다 수수료 " + CN_FEE * 100 + "%, 마감 때 자동 매도)");
  if (room.au) sys(room, "🎁 몰래 입찰 → 최고가 1명만 입찰가를 내고 상자를 가져가요 · 각자 비밀 힌트가 하나씩 · 💣 폭탄 상자를 사면 돈을 더 뱉어요!");
  if (room.pk) sys(room, "🔴 공이 떨어질 구역을 맞히면 배당만큼 · " + room.pk.odds.map((o, z) => ["중앙", "외곽", "최외곽"][z] + " x" + o).join(" · ") + " · 🎰 최외곽에 걸고 잭팟 칸에 떨어지면 x" + MAX_MULT + "!");
  broadcastRoom(room);
  if (room.au) room.players.forEach((_, ws) => auSendMe(room, ws)); // 비밀 힌트는 각자에게만
  checkAllReady(room); // 전원 탄광행이면 아무도 준비할 사람이 없다 → 바로 진행
}

function checkAllReady(room) {
  if (room.phase !== "betting" || room.players.size === 0) return;
  for (const p of room.players.values()) if (p.rcAway) p.ready = true; // 재접속: 끊긴 사람(📴)은 자동 준비 (걸어 둔 베팅은 그대로)
  for (const p of room.players.values()) if (!p.ready && !p.mining) return;
  if (room.game === "blackjack") return bjDeal(room);
  if (room.game === "dice") return diceRoll(room);
  if (room.game === "penguin") return pgStart(room);
  if (room.game === "nunchi") return ncReveal(room);
  if (room.game === "indian") return ipDeal(room);
  if (room.game === "auction") return auReveal(room);
  if (room.game === "watergun") return wgStart(room);
  if (room.game === "duel") return duStart(room);
  if (room.game === "stopwatch") return swStart(room);
  if (room.game === "dodge") return dgStart(room);
  if (room.game === "balloon") return blStart(room);
  if (room.game === "coin") return cnStart(room);
  if (room.game === "plinko") return pkDrop(room);
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
    if (p.bets[1] && !p.bets[0]) { p.money += p.bets[1]; p.bets = {}; } // 사이드벳만 걸었으면 무효(환불)
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

const bjPair = (cards) => cards[0].slice(0, -1) === cards[1].slice(0, -1); // 처음 두 장이 같은 숫자 (무늬는 상관없음)

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
    const side = p.bets[1] || 0, [outcome, k] = bjOutcome(p.bj.cards, p.bj.state, B.dealer);
    const pair = side ? bjPair(p.bj.cards) : null, win = Math.floor(p.bets[0] * k) + (pair ? side * BJ_PAIR : 0);
    p.money += win;
    p.bj.state = outcome;
    payouts[p.id] = { bet: p.bets[0] + side, win, outcome, pair };
    p.bets = {};
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
    if (Math.random() < room.pg.probs[st.step]) { st.step++; if (st.step >= PG_PROBS.length) st.state = "goal"; }
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
    const bet = p.bets[0], win = p.pg.state === "fell" ? 0 : Math.floor(bet * G.mults[p.pg.step - 1]);
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
    pgGold(G);
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

// ---------- 인디언 포커 ----------
// 1~10 두 벌(20장)에서 한 장씩 받아 이마에 붙인다: 남의 카드는 다 보이는데 내 카드만 못 본다. 참가비(= room.cap, me.bets[0])를 내고
// 몰래 콜(참가비만큼 더 냄)/다이를 고르면, 콜한 사람 중 제일 높은 카드가 판돈의 95%를 가져간다(동점이면 나눔). 10을 들고 죽으면 벌금.
// 카드·결정은 room.ip 안에만 둔다(player 객체는 통째로 브로드캐스트되니까). 남의 카드는 각자에게 ipCards로 따로 보내고,
// 콜 비용도 공개 뒤 정산(ipSettle) 때 빠진다 → 그 전엔 HUD 금액으로도 누가 콜했는지 알 수 없다.
const IP_ROUNDS = 3;
const IP_SECONDS = 20; // 콜/다이 제한 시간. 넘기면 다이
const IP_REVEAL = 3200; // 공개 연출(카드 뒤집기 → 콜/다이 도장)을 보여주고 정산하기까지(ms)
const IP_PCT = 95; // 승자 몫(%). 나머지는 하우스 몫

// 모두에게 나가는 정보: 공개 전에는 누가 참가했고(ids) 누가 결정을 마쳤는지(done)만
const ipView = (I) => ({ round: I.round, rounds: I.rounds, ids: I.ids, done: I.ids.filter((id) => id in I.calls), left: I.until - Date.now(),
  cards: I.open ? I.cards : null, calls: I.open ? I.calls : null });

function ipJoin(room, me, v) {
  if (!!me.bets[0] === v || (v && me.money < room.cap)) return;
  if (v) { me.money -= room.cap; me.bets = { 0: room.cap }; } else { me.money += me.bets[0]; me.bets = {}; }
  broadcastRoom(room);
}

// 자기 카드만 뺀 나머지를 그 사람에게만 보낸다. 구경꾼(탄광·도중 입장 포함)은 전부 본다 — 채팅으로 훈수 두는 것도 재미
function ipPeek(ws, room) {
  const cards = Object.assign({}, room.ip.cards);
  delete cards[ws.id];
  send(ws, { type: "ipCards", cards });
}

function ipDeal(room) {
  const I = room.ip, ins = [...room.players.values()].filter((p) => p.bets[0]);
  if (ins.length < 2) return ipSettle(room); // 상대가 없으면 환불하고 무효
  const deck = shuffle([...Array(20).keys()].map((k) => (k % 10) + 1));
  I.ids = ins.map((p) => p.id);
  for (const id of I.ids) I.cards[id] = deck.pop();
  I.until = Date.now() + IP_SECONDS * 1000;
  room.phase = "ipDecide";
  for (const ws of room.players.keys()) ipPeek(ws, room);
  broadcastRoom(room);
  room.timer = setTimeout(() => ipReveal(room), IP_SECONDS * 1000);
}

function ipAct(room, me, a) {
  const I = room.ip;
  if (room.phase !== "ipDecide" || !I.ids.includes(me.id) || me.id in I.calls || (a !== "call" && a !== "die")) return; // 번복 불가
  if (a === "call" && me.money < room.cap) return; // 돈이 모자라면 콜 불가
  I.calls[me.id] = a === "call";
  broadcastRoom(room); // 누가 정했는지만 나간다
  ipCheckDone(room);
}

function ipCheckDone(room) {
  if (room.phase !== "ipDecide") return;
  for (const p of room.players.values()) if (room.ip.ids.includes(p.id) && !(p.id in room.ip.calls)) return;
  ipReveal(room);
}

// 공개: 카드와 결정이 모두에게 나간다. 승패는 여기서 이미 정해졌지만 돈은 연출이 끝난 뒤(ipSettle)에 움직인다.
function ipReveal(room) {
  const I = room.ip;
  clearTimeout(room.timer);
  for (const id of I.ids) if (!(id in I.calls)) I.calls[id] = false; // 시간 초과·퇴장 = 다이
  I.open = true;
  room.phase = "ipReveal";
  broadcastRoom(room);
  room.timer = setTimeout(() => ipSettle(room), IP_REVEAL);
}

// payouts: bet = 낸 돈 전부(참가비 + 콜 + 벌금), win = 돌려받는 돈. 도중에 나간 사람의 참가비는 판돈에 남는다(I.ids 기준).
function ipSettle(room) {
  const I = room.ip, cap = room.cap, payouts = {}, penalties = {};
  const ins = [...room.players.values()].filter((p) => p.bets[0]);
  const callers = ins.filter((p) => I.calls[p.id]);
  const best = Math.max(...callers.map((p) => I.cards[p.id]));
  const winners = callers.filter((p) => I.cards[p.id] === best);
  let pot = I.ids.length * cap;
  for (const p of ins) {
    const call = I.calls[p.id] ? cap : 0;
    const fine = winners.length && !call && I.cards[p.id] === 10 ? Math.min(cap, p.money) : 0; // 10을 들고 죽었다 (콜한 사람이 없으면 벌금도 없다)
    if (fine) penalties[p.id] = fine;
    p.money -= call + fine;
    pot += call + fine;
    payouts[p.id] = { bet: cap + call + fine, win: winners.length ? 0 : cap }; // 아무도 콜 안 했거나 무효면 참가비 환불
  }
  for (const p of winners) payouts[p.id].win = Math.floor(pot * IP_PCT / 100 / winners.length);
  for (const p of ins) { p.money += payouts[p.id].win; p.bets = {}; }
  room.phase = "result";
  room.result = { cards: I.cards, calls: I.calls, winners: winners.map((p) => p.id), pot: winners.length ? pot : 0, penalties, payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => ipNext(room), 5500);
}

function ipNext(room) {
  const I = room.ip;
  if (I.round >= I.rounds) return startNight(room);
  Object.assign(I, { round: I.round + 1, ids: [], cards: {}, calls: {}, open: false });
  room.phase = "betting";
  room.result = null;
  for (const p of room.players.values()) p.ready = false;
  broadcastRoom(room);
  checkAllReady(room);
}

// ---------- 미스터리 상자 경매 ----------
// 매 판 상자 하나. 금액 = 입찰 상한 × AU_MULTS[k] (확률 AU_PROBS[k], 표는 모두에게 공개), 어느 칸인지는 서버만 안다.
// 참가자마다 "이 상자는 $X가 아니다" 비밀 힌트 하나(정답은 절대 안 주고, 방 사람끼리 안 겹치게) → 정보 비대칭 + 채팅 블러핑.
// 밀봉 입찰(0 = 패스) → 전원 준비 → auReveal: 낮은 순서로 공개, 최고가 낙찰(동점은 추첨) → 상자 개봉 → 연출 뒤 정산.
// 입찰액·힌트·상자는 room.au 안에만(서버 전용), 본인 것은 send로. 하우스 수수료 없음 — 기대값(≈ 상한 × 0.72)보다 비싸게 산 사람이 하우스 몫.
const AU_ROUNDS = 3;
const AU_MULTS = [-0.5, 0, 0.25, 0.5, 1, 1.5, 3]; // -0.5 = 💣 폭탄 상자: 낙찰자가 입찰가에 더해 그만큼 더 뱉는다
const AU_PROBS = [0.06, 0.18, 0.18, 0.2, 0.16, 0.13, 0.09]; // 기대값 ≈ 상한의 74%
const AU_EV = AU_MULTS.reduce((s, m, i) => s + m * AU_PROBS[i], 0);
const auOpenAt = (n) => 2.2 + 0.8 * n; // 입찰 n개를 다 공개하고 상자가 열리는 시각(초). 클라이언트와 같아야 함

function auDeal(A) { // 새 상자: 금액 칸을 뽑고, 힌트 후보(정답 뺀 5칸)를 섞어 둔다
  let r = Math.random(), k = 0;
  for (; k < AU_PROBS.length - 1 && r >= AU_PROBS[k]; k++) r -= AU_PROBS[k];
  return Object.assign(A, { box: k, pool: shuffle(AU_MULTS.map((_, i) => i).filter((i) => i !== k)), hints: {}, bids: {}, reveal: null });
}

function auSendMe(room, ws) { // 내 힌트·입찰액은 나한테만. 힌트는 후보 5칸 중 지금 방 사람들이 안 받은 것 (최대 4명이라 항상 남는다)
  const A = room.au, p = room.players.get(ws);
  if (!p.mining && !(p.id in A.hints)) {
    const used = [...room.players.values()].map((q) => A.hints[q.id]);
    A.hints[p.id] = A.pool.find((i) => !used.includes(i));
  }
  send(ws, { type: "auMe", day: room.day, round: A.round, hint: p.mining ? null : A.hints[p.id], bid: A.bids[p.id] || 0 });
}

function auBid(room, ws, me, v) { // 0 = 패스. 상한이나 가진 돈보다 크게 부르면 거절 (돈은 낙찰돼야 빠진다)
  if (!Number.isInteger(v) || v < 0 || v > me.money) return; // 입찰 상한 없음 (상자 최대 금액이 알아서 상한 노릇)
  room.au.bids[me.id] = v;
  auSendMe(room, ws);
}

function auReveal(room) {
  const A = room.au, bids = [...room.players.values()].filter((p) => A.bids[p.id] > 0).map((p) => ({ id: p.id, bid: A.bids[p.id] }));
  const price = Math.max(0, ...bids.map((b) => b.bid)), tied = bids.filter((b) => b.bid === price);
  const winner = tied.length ? tied[Math.floor(Math.random() * tied.length)].id : null;
  bids.sort((a, b) => a.bid - b.bid || (a.id === winner) - (b.id === winner)); // 낮은 순서로 공개, 동점이면 낙찰자가 마지막
  A.reveal = { bids, winner, price, value: A.vals[A.box] };
  room.phase = "auReveal";
  broadcastRoom(room);
  room.timer = setTimeout(() => auSettle(room), (auOpenAt(bids.length) + 2.4) * 1000); // 개봉 연출을 보고 나서 정산
}

function auSettle(room) {
  const A = room.au, R = A.reveal, w = [...room.players.values()].find((p) => p.id === R.winner), payouts = {};
  if (w) { // 낙찰자만 입찰가를 내고 상자를 받는다. 폭탄이면 입찰가 + 터진 만큼 (가진 돈까지만)
    const lose = Math.min(w.money, R.price - Math.min(0, R.value)), win = Math.max(0, R.value);
    w.money += win - lose;
    payouts[w.id] = { bet: lose, win };
  }
  room.phase = "result";
  room.result = { ...R, payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    if (A.round >= A.rounds) return startNight(room);
    A.round++;
    auDeal(A);
    room.phase = "betting";
    room.result = null;
    for (const p of room.players.values()) p.ready = false;
    broadcastRoom(room);
    room.players.forEach((_, ws) => auSendMe(room, ws));
    checkAllReady(room);
  }, 5000);
}

// ---------- 러시안 룰렛 (키 watergun · 접두어 wg — 물총 룰렛으로 시작했다가 리볼버로 바뀌었다) ----------
// 참가비(= cap 고정, me.bets[0])를 낸 사람들이 돌아가며 6연발 리볼버를 자기 머리에 당긴다. 총알은 딱 1발.
// 약실(chamber = 총알 위치, shot = 지금까지 빈칸으로 넘어간 수)은 room.wg에만 두고 판이 끝나야 result로 공개한다.
// 차례마다 당기기(빈칸이면 한 칸 진행 → 다음 사람) 또는 넘기기(판당 1회, 참가비 절반을 판돈에 보태고 같은 칸을 다음 사람에게).
// 맞은 사람은 낸 돈을 전부 잃고, 나머지가 판돈 × 0.95를 똑같이 나눈다.
const WG_ROUNDS = 3;
const WG_SLOTS = 6;
const WG_TURN = 12000; // 차례당 제한 시간(ms). 넘기면 자동으로 당긴다
const WG_EDGE = 0.95;
const wgPublic = (W) => ({ round: W.round, rounds: W.rounds, order: W.order, turn: W.turn, k: WG_SLOTS - W.shot, pot: W.pot, pulls: W.pulls,
  passed: W.passed, doubled: W.doubled, ms: W.until - Date.now(), limit: WG_TURN, busy: W.busy, settling: W.settling }); // 화이트리스트: chamber는 절대 안 나간다
const wgHere = (room) => room.wg.order.filter((id) => [...room.players.values()].some((p) => p.id === id)); // 아직 방에 있는 참가자
const wgCur = (room) => [...room.players.values()].find((p) => p.id === room.wg.order[room.wg.turn]);

function wgStart(room) {
  const W = room.wg, ps = [...room.players.values()].filter((p) => p.bets[0]);
  if (ps.length < 2) { // 혼자서는 룰렛이 안 된다 → 환불하고 이 판은 무효
    for (const p of ps) { p.money += p.bets[0]; p.bets = {}; }
    broadcast(room, { type: "toast", text: "💥 참가자가 2명이 안 돼서 이번 판은 무효! (참가비 환불)" });
    return wgNext(room);
  }
  const ids = ps.map((p) => p.id), k = (W.round - 1) % ids.length; // 판마다 첫 순서를 한 칸씩 돌린다
  Object.assign(W, { order: ids.slice(k).concat(ids.slice(0, k)), turn: 0, chamber: Math.floor(Math.random() * WG_SLOTS), shot: 0,
    pot: ps.reduce((a, p) => a + p.bets[0], 0), pulls: [], passed: {}, doubled: {}, again: false, busy: false, settling: false, loser: null });
  room.phase = "wgTurn";
  wgTurn(room);
}

function wgTurn(room) { // 차례 시작. 제한 시간 안에 안 고르면 자동 당기기
  room.wg.busy = false;
  room.wg.until = Date.now() + WG_TURN;
  broadcastRoom(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => wgTimeout(room), WG_TURN);
}

const wgTimeout = (room) => wgAct(room, wgCur(room), "pull"); // 시간 초과 = 자동 당기기

function wgNextTurn(room) { // 다음 사람에게 (나간 사람은 건너뜀). 2명 미만이 남으면 남은 사람이 판돈을 먹는다
  const W = room.wg, here = wgHere(room);
  if (here.length < 2) return wgEnd(room, null);
  do W.turn = (W.turn + 1) % W.order.length; while (!here.includes(W.order[W.turn]));
  wgTurn(room);
}

// a: in/out = 베팅 단계의 참가·취소, pull/pass = 자기 차례의 당기기·넘기기
function wgAct(room, me, a) {
  const W = room.wg;
  if (!W || !me) return;
  if (a === "in" || a === "out") {
    if (room.phase !== "betting" || me.ready || me.mining) return;
    if (a === "in" && !me.bets[0] && me.money >= room.cap) { me.money -= room.cap; me.bets = { 0: room.cap }; }
    else if (a === "out" && me.bets[0]) { me.money += me.bets[0]; me.bets = {}; }
    else return;
    return broadcastRoom(room);
  }
  if (room.phase !== "wgTurn" || W.busy || W.settling || me.id !== W.order[W.turn]) return;
  if (a === "pass") {
    const fee = Math.floor(room.cap / 2);
    if (W.passed[me.id] || me.money < fee) return;
    me.money -= fee; me.bets[0] += fee; W.pot += fee; W.passed[me.id] = true;
    return wgNextTurn(room);
  }
  if (a === "double") { // 연속 2발: 한 차례에 두 번 당긴다(판당 1회, 남은 칸이 3칸 이상일 때). 둘 다 살아남으면 판돈 몫이 두 배
    if (W.doubled[me.id] || WG_SLOTS - W.shot < 3) return;
    W.doubled[me.id] = true; W.again = true; a = "pull";
  }
  if (a !== "pull") return;
  const bang = W.shot === W.chamber;
  W.pulls.push({ id: me.id, bang });
  if (bang) return wgEnd(room, me.id);
  W.shot++;
  W.busy = true; // "철컥" 연출을 보여주고 나서 다음 사람
  broadcastRoom(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (!W.again) return wgNextTurn(room);
    W.again = false; W.busy = false; // 연속 2발의 두 번째: 차례를 넘기지 않고 같은 사람이 한 번 더
    wgAct(room, me, "pull");
  }, 1400);
}

function wgEnd(room, loser) { // 탕! 연출이 끝난 뒤에 돈을 움직인다
  Object.assign(room.wg, { settling: true, loser });
  broadcastRoom(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => wgSettle(room), loser ? 2600 : 1000);
}

function wgSettle(room) {
  const W = room.wg, payouts = {}, ps = [...room.players.values()].filter((p) => W.order.includes(p.id)); // 나간 사람이 낸 돈은 판돈에 남는다
  const survivors = ps.filter((p) => p.id !== W.loser), wt = (p) => (W.doubled[p.id] ? 2 : 1); // 연속 2발에서 살아남은 사람은 몫이 두 배
  const unit = (W.pot * WG_EDGE) / Math.max(1, survivors.reduce((a, p) => a + wt(p), 0));
  for (const p of ps) {
    const bet = p.bets[0] || 0, win = p.id === W.loser ? 0 : Math.floor(unit * wt(p));
    p.money += win;
    p.bets = {};
    payouts[p.id] = { bet, win };
  }
  room.phase = "result";
  room.result = { loser: W.loser, survivors: survivors.map((p) => p.id), pot: W.pot, pulls: W.pulls, chamber: W.chamber, payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => wgNext(room), 5000);
}

function wgNext(room) { // 다음 판 참가 신청 (마지막 판이었으면 밤)
  if (room.wg.round >= room.wg.rounds) return startNight(room);
  room.wg = { round: room.wg.round + 1, rounds: room.wg.rounds };
  room.phase = "betting";
  room.result = null;
  for (const p of room.players.values()) p.ready = false;
  broadcastRoom(room);
  checkAllReady(room);
}

function wgCheck(room) {
  if (room.phase !== "wgTurn" || room.wg.settling) return;
  if (!wgCur(room) || wgHere(room).length < 2) wgNextTurn(room);
}

// ---------- 총잡이 결투 (키 duel · 접두어 du) ----------
// 참가비(= cap 고정, me.bets[0])를 낸 사람들이 마주 서고, 서버가 몰래 정한 시각(DU_WAIT)에 "쏴!" 신호를 보낸다.
// 신호 전에 쏘면 오발 = 아웃. 신호 뒤 가장 빨리 쏜 사람이 판돈 × 0.95 독식. 신호 전엔 가짜 신호(🌭 쏘세지! 등)가 0~2번 섞인다.
// 반응 속도는 클라이언트가 신호를 받은 순간부터 잰 값(rt)을 쓴다 → 핑이 느린 사람도 공평. 서버가 잰 경과 시간보다 클 수는 없게 자른다.
// ponytail: rt를 조작하면 DU_MIN까지는 속일 수 있다. 친구끼리 하는 게임이라 믿는다 — 문제 되면 서버 기준 시간 + 핑 보정으로 바꾼다.
const DU_ROUNDS = 3;
const DU_WAIT = [2500, 7000]; // 신호까지 뜸(ms)
const DU_WINDOW = 2500; // 신호 후 쏠 수 있는 시간(ms). 전원이 쏘면 바로 끝
const DU_MIN = 100; // 사람 반응 속도 하한(ms). 이보다 빠르면 이 값으로 친다
const DU_EDGE = 0.95;
const DU_FAKES = ["🌭 쏘세지!", "🙊 쏘…지 마!", "🙏 쏘리!", "🤔 쏠까?", "🥤 쏘다!"];
const duPublic = (D) => ({ round: D.round, rounds: D.rounds, order: D.order, pot: D.pot, fouls: D.fouls, shots: D.shots, fired: D.fired, since: D.fired ? Date.now() - D.fired : 0 }); // 신호 시각(at)은 절대 안 나간다

function duStart(room) {
  const D = room.du, ps = [...room.players.values()].filter((p) => p.bets[0]);
  if (ps.length < 2) { // 혼자서는 결투가 안 된다 → 환불하고 이 판은 무효
    for (const p of ps) { p.money += p.bets[0]; p.bets = {}; }
    broadcast(room, { type: "toast", text: "🤠 참가자가 2명이 안 돼서 이번 판은 무효! (참가비 환불)" });
    return duNext(room);
  }
  const wait = rnd(DU_WAIT[0], DU_WAIT[1]), fakes = [];
  for (let k = Math.floor(Math.random() * 3); k > 0; k--) fakes.push(rnd(900, wait - 500)); // 가짜 신호는 진짜보다 0.5초 이상 앞에
  Object.assign(D, { order: ps.map((p) => p.id), pot: ps.reduce((a, p) => a + p.bets[0], 0), fouls: [], shots: {}, fired: 0 });
  room.phase = "duWait";
  broadcastRoom(room);
  clearTimeout(room.timer);
  D.fakeTimers = fakes.map((t) => setTimeout(() => room.du === D && !D.fired && broadcast(room, { type: "duCue", fake: DU_FAKES[Math.floor(Math.random() * DU_FAKES.length)] }), t));
  room.timer = setTimeout(() => duFire(room), wait);
}

function duFire(room) {
  const D = room.du;
  D.fired = Date.now();
  room.phase = "duFire";
  broadcast(room, { type: "duCue" }); // 진짜 신호: 클라이언트는 이걸 받은 순간부터 반응 속도를 잰다
  broadcastRoom(room);
  room.timer = setTimeout(() => duEnd(room), DU_WINDOW);
}

function duShot(room, me, rt) {
  const D = room.du;
  if (!D || !D.order || !D.order.includes(me.id) || D.fouls.includes(me.id) || me.id in D.shots) return;
  if (room.phase === "duWait") D.fouls.push(me.id); // 오발!
  else if (room.phase === "duFire") D.shots[me.id] = Math.round(Math.max(DU_MIN, Math.min(Date.now() - D.fired, Number(rt) || Infinity))); // 서버가 잰 시간보다 빠를 수 없고, 사람 한계보다도 빠를 수 없다
  else return;
  broadcastRoom(room);
  duCheck(room);
}

function duCheck(room) { // 남은 사람이 다 쐈거나(오발 포함) 방을 나갔으면 바로 끝
  const D = room.du;
  if (!D || (room.phase !== "duWait" && room.phase !== "duFire")) return;
  const here = [...room.players.values()].filter((p) => D.order.includes(p.id) && !p.rcAway);
  if (here.every((p) => D.fouls.includes(p.id) || p.id in D.shots)) duEnd(room);
}

function duEnd(room) {
  const D = room.du, payouts = {};
  clearTimeout(room.timer);
  (D.fakeTimers || []).forEach(clearTimeout);
  const ps = [...room.players.values()].filter((p) => D.order.includes(p.id)); // 나간 사람이 낸 돈은 판돈에 남는다
  const best = Math.min(...Object.values(D.shots));
  let winners = ps.filter((p) => D.shots[p.id] === best); // 동점이면 나눈다
  if (!winners.length) winners = ps.filter((p) => !D.fouls.includes(p.id)); // 아무도 안 쐈으면 오발 안 낸 사람끼리 나눈다 (전원 오발이면 판돈은 하우스 몫)
  const win = winners.length ? Math.floor((D.pot * DU_EDGE) / winners.length) : 0;
  for (const p of ps) {
    const bet = p.bets[0] || 0, w = winners.includes(p) ? win : 0;
    p.money += w;
    p.bets = {};
    payouts[p.id] = { bet, win: w };
  }
  room.phase = "result";
  room.result = { winners: winners.map((p) => p.id), shots: D.shots, fouls: D.fouls, pot: D.pot, payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => duNext(room), 4500);
}

function duNext(room) { // 다음 판 참가 신청 (마지막 판이었으면 밤)
  if (room.du.round >= room.du.rounds) return startNight(room);
  room.du = { round: room.du.round + 1, rounds: room.du.rounds };
  room.phase = "betting";
  room.result = null;
  for (const p of room.players.values()) p.ready = false;
  broadcastRoom(room);
  checkAllReady(room);
}

function duJoin(room, me, v) { // 참가(참가비 cap 고정) / 취소
  if (!room.du || room.phase !== "betting" || me.ready || me.mining) return;
  if (v && !me.bets[0] && me.money >= room.cap) { me.money -= room.cap; me.bets = { 0: room.cap }; }
  else if (!v && me.bets[0]) { me.money += me.bets[0]; me.bets = {}; }
  else return;
  broadcastRoom(room);
}

// ---------- 블라인드 스톱워치 (키 stopwatch · 접두어 sw) ----------
// 참가비(= cap 고정, me.bets[0])를 낸 사람들 앞에 목표 시간(SW_TARGET 사이, 소수 둘째 자리)을 공개하고 SW_READY 뒤 스톱워치를 돌린다.
// 숫자는 클라이언트가 SW_SHOW초 동안만 보여 주고 사라진다(블라인드). 각자 목표라고 느끼는 순간 STOP → 오차 절댓값이 가장 작은 사람이 판돈 × 0.95 독식(동점이면 나눔).
// 목표 × 2까지 안 누르면 실격(전원 실격이면 하우스 몫). 멈춘 시각은 결과 전까지 안 내보낸다 — 남의 시각이 보이면 지금 몇 초인지 들키니까.
// 시간은 결투처럼 클라이언트가 swGo를 받은 순간부터 잰 값(t)을 쓰고, 서버가 잰 경과 시간보다 클 수는 없게 자른다.
// ponytail: t를 조작하면 서버 경과 시간 안에서 아무 값이나 낼 수 있다(목표에 딱 맞춰 보내기 등). 친구끼리라 믿는다 — 문제 되면 서버 기준 시간 + 핑 보정으로 바꾼다.
const SW_ROUNDS = 3;
const SW_TARGET = [5, 12]; // 목표 시간(초)
const SW_READY = 2500; // 목표 공개 후 출발까지(ms)
const SW_SHOW = 3; // 숫자가 보이는 시간(초) — 클라이언트 연출, 안내문용
const SW_PERFECT = 0.05; // 이 오차 이내면 🎯 퍼펙트 연출(초)
const SW_EDGE = 0.95;
const swPublic = (S) => ({ round: S.round, rounds: S.rounds, target: S.target, order: S.order, pot: S.pot, stopped: S.stops && Object.keys(S.stops), since: S.t0 ? Date.now() - S.t0 : 0 }); // 멈춘 시각(stops)은 결과 전까지 절대 안 나간다

function swStart(room) {
  const S = room.sw, ps = [...room.players.values()].filter((p) => p.bets[0]);
  if (ps.length < 2) { // 혼자면 겨룰 상대가 없다 → 환불하고 이 판은 무효
    for (const p of ps) { p.money += p.bets[0]; p.bets = {}; }
    broadcast(room, { type: "toast", text: "⏱️ 참가자가 2명이 안 돼서 이번 판은 무효! (참가비 환불)" });
    return swNext(room);
  }
  Object.assign(S, { target: Math.round(rnd(SW_TARGET[0], SW_TARGET[1]) * 100) / 100, order: ps.map((p) => p.id), pot: ps.reduce((a, p) => a + p.bets[0], 0), stops: {}, t0: 0 });
  room.phase = "swReady";
  broadcastRoom(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => swGo(room), SW_READY);
}

function swGo(room) {
  const S = room.sw;
  S.t0 = Date.now();
  room.phase = "swRun";
  broadcast(room, { type: "swGo" }); // 클라이언트는 이걸 받은 순간부터 잰다
  broadcastRoom(room);
  room.timer = setTimeout(() => swEnd(room), S.target * 2000);
}

function swStop(room, me, t) {
  const S = room.sw;
  if (!S || room.phase !== "swRun" || !S.order.includes(me.id) || me.id in S.stops) return;
  S.stops[me.id] = Math.round(Math.max(0, Math.min((Date.now() - S.t0) / 1000, Number(t) || Infinity)) * 100) / 100; // 서버가 잰 시간보다 늦을 수는 없다
  broadcastRoom(room);
  swCheck(room);
}

function swCheck(room) { // 남은 사람(📴 제외)이 다 멈췄으면 바로 끝
  const S = room.sw;
  if (!S || room.phase !== "swRun") return;
  if ([...room.players.values()].filter((p) => S.order.includes(p.id) && !p.rcAway).every((p) => p.id in S.stops)) swEnd(room);
}

function swEnd(room) {
  const S = room.sw, payouts = {};
  clearTimeout(room.timer);
  const ps = [...room.players.values()].filter((p) => S.order.includes(p.id)); // 나간 사람이 낸 돈은 판돈에 남는다
  const err = {};
  for (const [id, t] of Object.entries(S.stops)) if (t <= S.target * 2) err[id] = Math.round(Math.abs(t - S.target) * 100) / 100;
  const best = Math.min(...Object.values(err));
  const winners = ps.filter((p) => err[p.id] === best); // 동점이면 나눈다, 전원 실격이면 아무도 없다(하우스 몫)
  const win = winners.length ? Math.floor((S.pot * SW_EDGE) / winners.length) : 0;
  for (const p of ps) {
    const bet = p.bets[0] || 0, w = winners.includes(p) ? win : 0;
    p.money += w;
    p.bets = {};
    payouts[p.id] = { bet, win: w };
  }
  room.phase = "result";
  room.result = { winners: winners.map((p) => p.id), target: S.target, stops: S.stops, err, perfect: best <= SW_PERFECT, pot: S.pot, payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => swNext(room), 6000);
}

function swNext(room) { // 다음 판 참가 신청 (마지막 판이었으면 밤)
  if (room.sw.round >= room.sw.rounds) return startNight(room);
  room.sw = { round: room.sw.round + 1, rounds: room.sw.rounds };
  room.phase = "betting";
  room.result = null;
  for (const p of room.players.values()) p.ready = false;
  broadcastRoom(room);
  checkAllReady(room);
}

function swJoin(room, me, v) { // 참가(참가비 cap 고정) / 취소
  if (!room.sw || room.phase !== "betting" || me.ready || me.mining) return;
  if (v && !me.bets[0] && me.money >= room.cap) { me.money -= room.cap; me.bets = { 0: room.cap }; }
  else if (!v && me.bets[0]) { me.money += me.bets[0]; me.bets = {}; }
  else return;
  broadcastRoom(room);
}

// ---------- 총알 피하기 (키 dodge · 접두어 dg) ----------
// 참가비(= cap 고정, me.bets[0])를 낸 사람들이 사각 아레나에 서고, 사방에서 날아오는 총알을 피한다. 오래 버틴 순으로 판돈 1위 70% · 2위 30%.
// 서버는 시드(seed)만 뽑는다 → 클라이언트가 같은 결정적 PRNG로 같은 탄막을 시뮬레이션한다(모두에게 같은 탄막). 서버는 탄막을 모른다.
// 각자 자기 위치를 로컬로 움직이며 ~10Hz로 dgPos를 보내고, 서버는 그걸 다른 사람에게 중계만 한다(화면용).
// 피격 판정은 본인 클라이언트가 하고 사망 시각(t0 기준 ms)을 dgDie로 보고한다. 서버는 경과 시간보다 늦은 값은 자른다.
// ponytail: 판정이 클라이언트라 조작하면 안 죽을 수 있다(dgDie를 안 보내면 끝까지 생존). 친구끼리 하는 게임이라 믿는다 — 문제 되면 서버가 dgPos로 탄막을 재현해 검증한다.
const DG_ROUNDS = 3;
const DG_COUNT = 3000; // 시작 전 카운트다운(ms). t0 = 카운트다운이 끝나는 순간
const DG_LEN = 60000; // 여기까지 버티면 생존
const DG_TICK = 100; // 사망 시각을 이 단위로 묶는다 → 같은 틱에 죽으면 동시 탈락
const DG_GRACE = 800; // 1명만 남거나 시간이 끝난 뒤, 늦게 오는 사망 보고를 기다리는 시간
const DG_SPLIT = [0.7, 0.3]; // 1위 · 2위 몫 (하우스 몫 없음)
const DG_A = 400; // 아레나 한 변 (클라이언트와 같은 좌표계)
const dgPublic = (D) => ({ round: D.round, rounds: D.rounds, order: D.order, pot: D.pot, seed: D.seed, dead: D.dead, pos: D.pos, len: DG_LEN, count: DG_COUNT, since: D.t0 ? Date.now() - D.t0 : 0 });

function dgStart(room) {
  const D = room.dg, ps = [...room.players.values()].filter((p) => p.bets[0]);
  if (ps.length < 2) { // 혼자서는 순위가 안 된다 → 환불하고 이 판은 무효
    for (const p of ps) { p.money += p.bets[0]; p.bets = {}; }
    broadcast(room, { type: "toast", text: "🎋 참가자가 2명이 안 돼서 이번 판은 무효! (참가비 환불)" });
    return dgNext(room);
  }
  Object.assign(D, { order: ps.map((p) => p.id), pot: ps.reduce((a, p) => a + p.bets[0], 0), seed: Math.floor(Math.random() * 2 ** 31), t0: Date.now() + DG_COUNT, dead: {}, pos: {}, ending: false });
  for (const p of ps) if (p.rcAway) D.dead[p.id] = 0; // 📴인 채로 참가해 있었으면 시작하자마자 탈락
  room.phase = "dgPlay";
  broadcastRoom(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => dgEnd(room), DG_COUNT + DG_LEN + DG_GRACE);
  dgCheck(room);
}

function dgDie(room, p, t) { // t = 본인이 보고한 사망 시각 (t0 기준 ms). 📴이면 지금 시각
  const D = room.dg;
  if (!D || room.phase !== "dgPlay" || !D.order.includes(p.id) || p.id in D.dead) return;
  const el = Date.now() - D.t0;
  D.dead[p.id] = Math.round(Math.max(0, Math.min(Number.isFinite(t) ? t : el, el, DG_LEN))); // 경과 시간보다 늦게 죽을 수는 없다
  broadcastRoom(room);
  dgCheck(room);
}

function dgCheck(room) { // 1명 이하만 남으면 (동시 탈락 보고를 조금 기다렸다가) 끝
  const D = room.dg;
  if (!D || room.phase !== "dgPlay" || D.ending) return;
  const alive = [...room.players.values()].filter((p) => D.order.includes(p.id) && !(p.id in D.dead));
  if (alive.length > 1) return;
  D.ending = true;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => dgEnd(room), DG_GRACE);
}

// 순위 → 몫. times = {id: 버틴 ms} (끝까지 산 사람 = DG_LEN). 같은 틱이면 한 무리로 묶고 그 무리가 차지한 순위의 몫을 합쳐 나눈다.
function dgSplit(times, pot) {
  const ids = Object.keys(times), tick = (id) => Math.floor(times[id] / DG_TICK), share = ids.length > 1 ? DG_SPLIT : [1], win = {};
  const ticks = [...new Set(ids.map(tick))].sort((a, b) => b - a);
  let pos = 0;
  for (const k of ticks) {
    const g = ids.filter((id) => tick(id) === k), s = share.slice(pos, pos + g.length).reduce((a, b) => a + b, 0);
    for (const id of g) win[id] = Math.floor((pot * s) / g.length);
    pos += g.length;
  }
  return win;
}

function dgEnd(room) {
  const D = room.dg, payouts = {}, times = {};
  clearTimeout(room.timer);
  const ps = [...room.players.values()].filter((p) => D.order.includes(p.id)); // 나간 사람은 순위에서 빠지고 낸 돈은 판돈에 남는다
  const alive = Math.min(DG_LEN, Math.max(Date.now() - D.t0, ...Object.values(D.dead).map((t) => t + DG_TICK))); // 남은 사람 = 지금까지 버틴 시간 (죽은 사람보다는 무조건 위)
  for (const p of ps) times[p.id] = p.id in D.dead ? D.dead[p.id] : alive;
  const win = dgSplit(times, D.pot), best = Math.max(...Object.values(times));
  for (const p of ps) {
    const bet = p.bets[0] || 0;
    p.money += win[p.id];
    p.bets = {};
    payouts[p.id] = { bet, win: win[p.id] };
  }
  room.phase = "result";
  room.result = { times, top: ps.filter((p) => Math.floor(times[p.id] / DG_TICK) === Math.floor(best / DG_TICK)).map((p) => p.id), pot: D.pot, len: DG_LEN, payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => dgNext(room), 5000);
}

function dgNext(room) { // 다음 판 참가 신청 (마지막 판이었으면 밤)
  if (room.dg.round >= room.dg.rounds) return startNight(room);
  room.dg = { round: room.dg.round + 1, rounds: room.dg.rounds };
  room.phase = "betting";
  room.result = null;
  for (const p of room.players.values()) p.ready = false;
  broadcastRoom(room);
  checkAllReady(room);
}

function dgJoin(room, me, v) { // 참가(참가비 cap 고정) / 취소
  if (!room.dg || room.phase !== "betting" || me.ready || me.mining) return;
  if (v && !me.bets[0] && me.money >= room.cap) { me.money -= room.cap; me.bets = { 0: room.cap }; }
  else if (!v && me.bets[0]) { me.money += me.bets[0]; me.bets = {}; }
  else return;
  broadcastRoom(room);
}

function dgPos(room, ws, me, x, y) { // 내 위치 → 다른 사람들에게 중계 (화면용, 판정엔 안 쓴다)
  const D = room.dg;
  if (!D || room.phase !== "dgPlay" || !D.order.includes(me.id) || me.id in D.dead || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const pos = (D.pos[me.id] = [Math.round(Math.max(0, Math.min(DG_A, x))), Math.round(Math.max(0, Math.min(DG_A, y)))]);
  const data = JSON.stringify({ type: "dgPos", id: me.id, x: pos[0], y: pos[1] });
  for (const w of room.players.keys()) if (w !== ws && w.readyState === w.OPEN) w.send(data);
}

// ---------- 풍선 불기 ----------
// 크래시 게임: 공용 풍선의 배수 m(t) = e^(BL_RATE·t)가 x1.00부터 부풀고, 터지기 전에 "놓기"를 누르면 그때 배수만큼 받는다. 판돈은 me.bets[0].
// 터지는 배수는 시작할 때 미리 뽑아 room.bl.hidden에만 둔다(broadcastRoom은 필드를 골라 보내므로 밖으로 안 나간다).
// crash = 0.95 / U → P(crash ≥ m) = 0.95 / m → 어디서 놓든 기대 환급률 95%. (5%는 x1.00에서 바로 펑 = 하우스 몫)
// 클라이언트엔 경과 시간(elapsed)과 성장률만 주고 곡선은 각자 그린다. 누가 몇 배에 놓았는지(cash)는 바로, crash는 터진 뒤(또는 전원이 놓은 뒤)에만 공개.
const BL_ROUNDS = 3;
const BL_EDGE = 0.95;
const BL_RATE = 0.12; // 약 5.8초에 x2, 19초에 x10
const BL_MAX = MAX_MULT; // 상한(약 23초). 여기까지 버틴 사람은 자동 회수 — 상한에서 회수라 환급률 95%는 그대로
const BL_COUNT = 3000; // 부풀기 전 카운트다운(ms)
const BL_FF = 2500; // 전원이 놓은 뒤, 터지는 곳까지 빨리 감아 보여주는 시간(ms)
const blCrash = () => Math.min(BL_MAX, Math.max(1, BL_EDGE / (1 - Math.random())));
const blTime = (m) => (Math.log(m) / BL_RATE) * 1000; // 배수 m에 도달하는 시각(ms)
const blWin = (bet, m) => Math.floor((bet * Math.round(m * 100)) / 100); // 배수는 소수 둘째 자리까지라 정수로 곱해 부동소수 오차를 피한다 (클라이언트 blWin과 같아야 함)

function blStart(room) {
  room.phase = "blCount";
  Object.assign(room.bl, { t0: Date.now() + BL_COUNT, hidden: blCrash(), cash: {}, crash: null, ffAt: 0 }); // t0가 미래 = 카운트다운 중 (숫자는 클라이언트가 센다)
  broadcastRoom(room);
  room.timer = setTimeout(() => blFly(room), BL_COUNT);
}

function blFly(room) {
  const B = room.bl;
  room.phase = "blFly";
  B.t0 = Date.now();
  broadcastRoom(room);
  room.timer = setTimeout(() => blPop(room), blTime(B.hidden));
  blCheckDone(room); // 아무도 안 걸었으면 바로 빨리 감기
}

function blAct(room, me) {
  const B = room.bl;
  if (room.phase !== "blFly" || !B || !me.bets[0] || me.id in B.cash) return;
  const m = Math.exp((BL_RATE * (Date.now() - B.t0)) / 1000); // 서버 시각 기준
  if (m >= B.hidden) return; // 타이머가 밀렸을 뿐 이미 터졌어야 할 시각 → 무효
  B.cash[me.id] = Math.floor(m * 100) / 100;
  broadcastRoom(room);
  blCheckDone(room);
}

// 쥐고 있는 사람이 없으면 더 숨길 게 없다 → 터지는 배수를 공개하고, 클라이언트가 거기까지 빨리 감아 보여준다("아까웠다" 연출). 최대 33초를 멍하니 기다리지 않게.
function blCheckDone(room) {
  const B = room.bl;
  if (room.phase !== "blFly" || B.crash) return;
  for (const p of room.players.values()) if (p.bets[0] && !(p.id in B.cash)) return;
  B.crash = B.hidden;
  B.ffAt = Date.now() - B.t0;
  broadcastRoom(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => blPop(room), Math.min(BL_FF, Math.max(0, blTime(B.hidden) - B.ffAt)));
}

function blPop(room) {
  const B = room.bl;
  room.phase = "blPop";
  B.crash = B.hidden;
  if (B.crash >= BL_MAX) for (const p of room.players.values()) if (p.bets[0] && !(p.id in B.cash)) B.cash[p.id] = BL_MAX; // 상한까지 버텼으면 자동 회수
  broadcastRoom(room);
  room.timer = setTimeout(() => blSettle(room), 1500); // 펑 연출을 보고 나서 정산
}

// 👑 최후의 1인: 터지기 전에 놓은 사람이 2명 이상이면, 가장 늦게(가장 높은 배수에) 놓은 1명이 나머지가 번 돈의 BL_LAST만큼 떼 간다 (동점이면 없음)
const BL_LAST = 0.05;

function blSettle(room) {
  const B = room.bl, payouts = {};
  for (const p of room.players.values()) {
    if (!p.bets[0]) continue;
    const bet = p.bets[0], win = blWin(bet, B.cash[p.id] || 0);
    payouts[p.id] = { bet, win };
  }
  const cashed = Object.keys(payouts).filter((id) => B.cash[id]).sort((a, b) => B.cash[b] - B.cash[a]);
  let last = null;
  if (cashed.length >= 2 && B.cash[cashed[0]] > B.cash[cashed[1]]) {
    last = { id: cashed[0], bonus: 0 };
    for (const id of cashed.slice(1)) {
      const cut = Math.floor(Math.max(0, payouts[id].win - payouts[id].bet) * BL_LAST);
      payouts[id].win -= cut;
      last.bonus += cut;
    }
    payouts[last.id].win += last.bonus;
  }
  for (const p of room.players.values()) if (payouts[p.id]) { p.money += payouts[p.id].win; p.bets = {}; }
  room.phase = "result";
  room.result = { crash: B.crash, cashouts: B.cash, payouts, last };
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    if (B.round >= B.rounds) return startNight(room);
    B.round++;
    room.phase = "betting";
    room.result = null;
    for (const p of room.players.values()) p.ready = false;
    broadcastRoom(room);
    checkAllReady(room);
  }, 5000);
}

// ---------- 도박 코인 단타 ----------
// 투자금(me.bets[0])을 들고 30초짜리 장에 들어가 아무 때나 전액 매수 ↔ 전액 매도. p.cn = { cash, coins, last } (안 건 사람은 null = 구경)
// 가격은 틱마다 그 자리에서 하나씩 만든다 — 미래 가격은 서버에도 없으니 샐 수가 없다. 틱은 가벼운 cnTick 메시지로, room 전체는 체결 때만 보낸다.
// 드리프트 0(틱도 이벤트도 기댓값 1배)이라 뭘 해도 기대 수익은 0이고 하우스 몫은 거래 수수료뿐 → 한두 번 사고팔면 환급률 97% ~ 94%.
const CN_ROUNDS = 3;
const CN_TICK = 250; // 틱 간격(ms)
const CN_TICKS = 120; // 한 판 = 30초
const CN_FEE = 0.015; // 거래마다 떼는 수수료
const CN_VOL = 0.025; // 틱당 변동성
const CN_NEWS = 0.012; // 틱당 이벤트 확률 (한 판에 한두 번)
const CN_EVENTS = [ // [뉴스, 최소, 최대 변동률]. 평균을 다 더하면 0 → 이벤트가 끼어도 기댓값은 제자리 (--check에서 확인)
  ["🚀 일론 트윗", 0.15, 0.4], ["📉 거래소 해킹", -0.45, -0.2], ["🐋 고래 등장", 0.1, 0.3],
  ["🏛️ 규제 발표", -0.25, -0.1], ["🐕 밈 열풍", 0.1, 0.35], ["🏃 개발자 먹튀", -0.3, -0.1],
];
// 초대형 이벤트: 한 판에 ~8% 확률. 🌕 x5(+400%)가 1번 나올 때 ☠️ 상장폐지(−99%)가 4번 → 0.2 × 4 = 0.8 × 1, 기댓값은 여전히 제자리 (--check에서 확인)
const CN_RARE = 0.0007; // 틱당
const CN_BIG = [["🌕 투더문", 4, 0.2], ["☠️ 상장폐지", -0.99, 0.8]]; // [뉴스, 변동률, 확률]
const cnFresh = () => ({ prices: [100], news: [], trades: {} }); // 새 판의 빈 전광판 (시작가 100)

function cnNext(price) { // 다음 가격 하나: 기하 랜덤워크 + 가끔 뉴스. 바닥은 1
  let next = price * Math.exp(CN_VOL * gauss() - (CN_VOL * CN_VOL) / 2), news = null;
  if (Math.random() < CN_RARE) {
    const [text, pct] = CN_BIG[Math.random() < CN_BIG[0][2] ? 0 : 1];
    next *= 1 + pct;
    news = { text, pct: Math.round(pct * 100), big: true };
  } else if (Math.random() < CN_NEWS) {
    const [text, a, b] = CN_EVENTS[Math.floor(Math.random() * CN_EVENTS.length)], pct = rnd(a, b);
    next *= 1 + pct;
    news = { text, pct: Math.round(pct * 100) };
  }
  return [Math.max(1, Math.round(next * 100) / 100), news];
}

function cnStart(room) {
  room.phase = "cnMarket";
  let any = false;
  for (const p of room.players.values()) { p.cn = p.bets[0] ? { cash: p.bets[0], coins: 0 } : null; any = any || !!p.cn; }
  broadcastRoom(room);
  if (!any) return cnClose(room); // 아무도 안 걸었으면(전원 탄광 등) 장을 열 것도 없다
  room.timer = setTimeout(() => cnTick(room), CN_TICK);
}

function cnTick(room) {
  const C = room.cn, t = C.prices.length, [price, news] = cnNext(C.prices[t - 1]);
  C.prices.push(price);
  if (news) { news.t = t; C.news.push(news); sys(room, "📰 " + news.text + "! " + (news.pct > 0 ? "+" : "−") + Math.abs(news.pct) + "%"); }
  broadcast(room, { type: "cnTick", t, price, news });
  if (t >= CN_TICKS) return cnClose(room);
  room.timer = setTimeout(() => cnTick(room), CN_TICK);
}

// 체결은 서버의 현재가로. 매수 = 현금 전액 → 코인, 매도 = 코인 전액 → 현금, 어느 쪽이든 수수료를 뗀다.
function cnAct(room, me, a) {
  const C = room.cn, st = me.cn;
  if (room.phase !== "cnMarket" || !st || Date.now() - (st.last || 0) < 300) return; // 연타 방지 0.3초
  const t = C.prices.length - 1, price = C.prices[t];
  if (a === "buy" && st.cash > 0) { st.coins = (st.cash * (1 - CN_FEE)) / price; st.cash = 0; }
  else if (a === "sell" && st.coins > 0) { st.cash = st.coins * price * (1 - CN_FEE); st.coins = 0; }
  else return;
  st.last = Date.now();
  (C.trades[me.id] = C.trades[me.id] || []).push({ t, side: a, price });
  broadcastRoom(room);
}

function cnClose(room) { // 장 마감: 들고 있는 코인은 마감가에 강제 매도. 돈은 마감 연출 뒤(cnSettle)에 움직인다
  const C = room.cn, t = C.prices.length - 1, price = C.prices[t];
  room.phase = "cnClose";
  for (const p of room.players.values()) {
    if (!p.cn || !p.cn.coins) continue;
    p.cn.cash = p.cn.coins * price * (1 - CN_FEE);
    p.cn.coins = 0;
    (C.trades[p.id] = C.trades[p.id] || []).push({ t, side: "sell", price, forced: true });
  }
  broadcastRoom(room);
  room.timer = setTimeout(() => cnSettle(room), 1800);
}

function cnSettle(room) {
  const C = room.cn, payouts = {};
  for (const p of room.players.values()) {
    if (!p.cn) continue;
    const bet = p.bets[0], win = Math.floor(p.cn.cash); // 최종 평가액 = 돌려받는 돈
    p.money += win;
    p.bets = {};
    payouts[p.id] = { bet, win };
  }
  room.phase = "result";
  room.result = { prices: C.prices, trades: C.trades, payouts };
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    if (C.round >= C.rounds) return startNight(room);
    C.round++;
    Object.assign(C, cnFresh());
    room.phase = "betting";
    room.result = null;
    for (const p of room.players.values()) Object.assign(p, { ready: false, cn: null });
    broadcastRoom(room);
    checkAllReady(room);
  }, 6000);
}

// ---------- 플링코 ----------
// 핀 10줄 → 칸 11개. 공은 핀마다 50:50으로 튀니까 칸 k(= 오른쪽으로 튄 횟수)에 떨어질 확률 = C(10,k)/1024.
// 공이 어느 구역에 떨어질지 맞히는 게임: 0 중앙(칸 4~6) · 1 외곽(칸 2·3·7·8) · 2 최외곽(칸 0·1·9·10).
// 배당 = 0.95 × 1024 ÷ (그 구역의 경우의 수) → 어디에 걸든 기대 환급률 95%. 맞히면 판돈 × 배당, 빗나가면 꽝.
// 판돈은 블랙잭처럼 me.bets[0], 구역은 p.pkZone(안 골랐으면 중앙). 전원 준비하면 참가자별 경로(좌우 10번)를 뽑아 통째로 내려보내고(베팅은 이미 잠김),
// 클라이언트가 PK_GAP 간격으로 공을 떨어뜨리는 연출(공 하나 PK_FALL)이 끝날 때쯤 정산한다.
const PK_ROUNDS = 3;
const PK_ROWS = 10;
const PK_EDGE = 0.95;
const PK_FALL = 3000; // 공 하나가 떨어지는 시간(ms). 클라이언트 PK_FALL과 같아야 함
const PK_GAP = 400; // 참가자마다 출발 간격(ms). 클라이언트 PK_GAP과 같아야 함
const pkC = (n, k) => (k ? (pkC(n, k - 1) * (n - k + 1)) / k : 1); // 이항계수 C(n,k)
const PK_ZONE_OF = Array.from({ length: PK_ROWS + 1 }, (_, k) => { const d = Math.abs(k - PK_ROWS / 2); return d <= 1 ? 0 : d <= 2 ? 1 : 2; }); // 칸 → 구역: 중앙 4~6 · 외곽 3·7 · 최외곽 0~2·8~10
const PK_WAYS = [0, 1, 2].map((z) => PK_ZONE_OF.reduce((n, zz, k) => n + (zz === z ? pkC(PK_ROWS, k) : 0), 0)); // 경우의 수를 직접 센다 (손으로 적은 표가 틀릴 일이 없게)
const PK_ODDS = PK_WAYS.map((w) => Math.round((PK_EDGE * 2 ** PK_ROWS / w) * 100) / 100);
// 🎰 잭팟 칸: 매판 최외곽 끝 칸(0·1·9·10) 중 하나. 최외곽에 걸고 거기 떨어지면 x15(MAX_MULT). 대신 최외곽 나머지 칸 배당을 깎아 구역 환급률 95%를 맞춘다
const PK_JACKS = [0, 1, PK_ROWS - 1, PK_ROWS];
function pkJack(K) {
  K.jack = PK_JACKS[Math.floor(Math.random() * PK_JACKS.length)];
  const w = pkC(PK_ROWS, K.jack);
  K.odds = PK_ODDS.slice();
  K.odds[2] = Math.floor(((PK_EDGE * 2 ** PK_ROWS - MAX_MULT * w) / (PK_WAYS[2] - w)) * 100) / 100; // 내림 = 하우스 쪽
  K.jackMult = MAX_MULT;
  return K;
}

function pkDrop(room) {
  const K = room.pk;
  room.phase = "pkDrop";
  K.t0 = Date.now();
  K.drops = [...room.players.values()].filter((p) => p.bets[0]) // 안 건 사람(탄광·빈털터리 포함)은 구경
    .map((p) => ({ id: p.id, zone: p.pkZone ?? 0, path: Array.from({ length: PK_ROWS }, () => (Math.random() < 0.5 ? 0 : 1)) }));
  broadcastRoom(room);
  room.timer = setTimeout(() => pkSettle(room), K.drops.length ? PK_FALL + PK_GAP * (K.drops.length - 1) + 300 : 800); // 전원 구경이면 기다릴 공이 없다
}

function pkSettle(room) {
  const K = room.pk, res = { paths: {}, bins: {}, zones: {}, mults: {}, payouts: {} };
  for (const p of room.players.values()) {
    const d = K.drops.find((x) => x.id === p.id);
    if (!d) continue; // 구경꾼·떨어지는 도중에 들어온 사람
    const bin = d.path.reduce((a, b) => a + b, 0), m = PK_ZONE_OF[bin] !== d.zone ? 0 : bin === K.jack ? K.jackMult : K.odds[d.zone], bet = p.bets[0]; // m = 적중 배당(빗나가면 0, 잭팟 칸이면 x15)
    const win = Math.floor(bet * m + 1e-9); // 100 × 44.22 = 4421.999… 같은 부동소수 오차 보정
    p.money += win;
    p.bets = {};
    res.paths[p.id] = d.path; res.bins[p.id] = bin; res.zones[p.id] = d.zone; res.mults[p.id] = m; res.payouts[p.id] = { bet, win };
  }
  room.phase = "result";
  room.result = res;
  broadcastRoom(room);
  room.timer = setTimeout(() => {
    if (K.round >= K.rounds) return startNight(room);
    K.round++; K.drops = null; pkJack(K);
    room.phase = "betting";
    room.result = null;
    for (const p of room.players.values()) p.ready = false;
    broadcastRoom(room);
    checkAllReady(room);
  }, 5000);
}

// ---------- 주사위 ----------
// 모두 준비되면 서버가 굴린다. 값은 바로 내려가지만(베팅은 이미 잠김) 클라이언트가 3초쯤 굴리는 연출을 한 뒤에 보여주고,
// 돈은 그 연출이 끝나는 시점(diceSettle)에 맞춰 움직인다.
function diceRoll(room) {
  room.phase = "rolling";
  room.dice.roll = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  broadcastRoom(room);
  room.timer = setTimeout(() => diceSettle(room), 5200); // 주사위가 하나씩 떨어지는 연출(두 번째 착지 4.4초) 뒤
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
    const wage = p.mining ? WAGE + (p.mnEarn || 0) : 0; // 탄광 일당 = 기본 + 오늘 캔 돈 (한도는 캘 때 이미 잘라 둠)
    p.money += wage;
    p.mining = false;
    p.ready = false;
    p.history[room.day] = p.money;
    room.night[p.id] = { delta: p.money - p.dayStart, wage };
    lnNightly(room, p); // 사채 이자 + 그래프는 순자산으로
    if (wage) room.night[p.id].mnDia = p.mnDia || 0; // 탄광에서 다이아를 캤으면 정산표에 💎
    Object.assign(p, { mnEarn: 0, mnDia: 0, mnRock: null }); // 오늘 채굴 기록은 일당으로 바꿨으니 초기화
    if (wage) sys(room, "⛏️ " + p.name + " 탄광 일당 +$" + wage);
    if (p.money === 0) sys(room, "💸 " + p.name + " 파산! 한푼줍쇼는 딱 한 번…");
    if (p.money === 0) ttOf(p).bankrupt++; if (wage) ttOf(p).mined++; // 시상식 칭호 통계
  }
  broadcastRoom(room);
}

// 파산자는 구걸을 한 번 해봤으면 더 할 게 없으니 준비된 걸로 친다 (나머지가 적선할지 말지 정하고 넘어간다)
function checkNightReady(room) {
  if (room.phase !== "night" || room.players.size === 0) return;
  for (const p of room.players.values()) if (p.rcAway) p.ready = true; // 재접속: 끊긴 사람(📴)은 자동 준비
  for (const p of room.players.values()) if (!p.ready && !(p.money === 0 && p.begged)) return;
  for (const p of room.players.values()) {
    p.begging = false;
    if (p.money === 0 && room.day < room.days) { p.mining = true; sys(room, "⛏️ " + p.name + " → 아오지 탄광행 (내일은 관전만)"); }
  }
  if (room.day < room.days) return startVote(room);
  room.phase = "final";
  ttAward(room); // 시상식 칭호
  const top = [...room.players.values()].sort((a, b) => lnNet(b) - lnNet(a))[0];
  sys(room, "🏆 " + room.days + "일 끝! 최고의 도박꾼은 " + top.name + " ($" + lnNet(top) + ")");
  broadcastRoom(room);
}

// ---------- 사채 ----------
// 밤에만 $100씩 빌리고 갚는다. 빚(p.lnDebt, 원금+이자)이 $1000을 넘게는 못 빌린다. 빌린 돈은 바로 money에.
// 이자는 매일 밤 정산(startNight) 때 기존 빚에 20% 복리. 빌리는 건 정산이 끝난 밤이라 그날 밤엔 안 붙고 다음 밤부터 붙는다.
// 파산 판정은 그대로 money === 0 → 파산자가 빌리면 checkNightReady가 알아서 탄광에 안 보낸다. 순위·그래프는 순자산(money − 빚).
const LN_UNIT = 100;
const LN_LIMIT = 1000;
const LN_RATE = 20; // 하루 이자(%). 정수로 계산해야 120 × 0.2 같은 부동소수 오차에 ceil이 1 더 붙지 않는다
const lnNet = (p) => p.money - (p.lnDebt || 0);

function lnNightly(room, p) {
  if (p.lnDebt) {
    const i = Math.ceil((p.lnDebt * LN_RATE) / 100);
    p.lnDebt += i;
    room.night[p.id].lnInt = i;
    sys(room, "💀 " + p.name + " 사채 이자 −$" + i + " (빚 $" + p.lnDebt + ")");
  }
  p.history[room.day] = lnNet(p);
}

function lnAct(room, me, a) {
  if (room.phase !== "night") return;
  const debt = me.lnDebt || 0;
  if (a === "borrow") {
    if (debt + LN_UNIT > LN_LIMIT) return;
    me.lnDebt = debt + LN_UNIT;
    me.money += LN_UNIT;
    me.begging = false; // 사채를 쓴 사람한테는 적선 못 한다
    sys(room, "💀 " + me.name + " 사채 $" + LN_UNIT + " 빌림 (빚 $" + me.lnDebt + ")");
  } else if (a === "repay" || a === "repayAll") {
    const amt = Math.min(a === "repay" ? LN_UNIT : debt, debt, me.money); // 가진 돈 한도
    if (!(amt > 0)) return;
    me.lnDebt = debt - amt;
    me.money -= amt;
    sys(room, "💀 " + me.name + " 사채 $" + amt + " 갚음 (" + (me.lnDebt ? "남은 빚 $" + me.lnDebt : "완납!") + ")");
  } else return;
  broadcastRoom(room); // 순자산은 그대로라 그래프(history)는 안 바뀐다
  checkNightReady(room); // 파산자가 다 갚고 다시 $0이 된 경우(구걸해 봤으면 자동 준비)
}

// ---------- 탄광 미니게임 ----------
// 탄광에 간 날(p.mining)은 낮 내내(밤 정산 전까지) 곡괭이질(mnHit)로 바위를 깬다. 밤 일당 = WAGE + p.mnEarn(오늘 캔 돈), 합계 최대 MN_MAX.
// 바위는 깰수록(p.mnRock.n = 오늘 깬 개수 = 깊이) HP가 1씩 늘고 전리품 값이 10%씩 오른다.
// 숫자는 시뮬레이션으로 맞춘 값: 초당 6번 × 1분 = 중앙값 $330 (평균 $415), 2~2.5분이면 한도 근처, 1분 안에 다이아가 나올 확률 ~16%.
// 연타가 많으니 타격 결과는 친 사람에게만 보내고, 방 전체 broadcastRoom은 바위가 깨질 때만(HUD의 ⛏️$ 갱신용).
const MN_MAX = 1000;
const MN_RATE = 8; // 초당 타격 상한. 넘는 건 매크로로 보고 버린다
// 초당 6번 기준 일당 중앙값: 1분 $211 · 2분 $308 · 3분 $395, 3분에 한도($1000) 닿는 건 ~10%(거의 다이아). 파산 → 탄광이 "$1000 리셋"이 되지 않게.
const MN_DEPTH = 0.03; // 깊이 1칸마다 전리품 값 +3%
const MN_LOOT = [ // [종류, 확률, 최소$, 최대$] — 깊이 n이면 값 × (1 + MN_DEPTH × n)
  ["stone", 0.7, 1, 4],
  ["silver", 0.22, 5, 10],
  ["gold", 0.077, 18, 30],
  ["dia", 0.003, 500, 700],
];
const mnRock = (n) => ({ n, hp: 12 + n, max: 12 + n });

function mnLoot(n) {
  let r = Math.random(), i = 0;
  while (i < MN_LOOT.length - 1 && r >= MN_LOOT[i][1]) r -= MN_LOOT[i++][1];
  const [k, , lo, hi] = MN_LOOT[i];
  return { k, v: Math.round((lo + Math.random() * (hi - lo)) * (1 + MN_DEPTH * n)) };
}

function mnHit(ws, room, me) {
  if (!me.mining || ["lobby", "vote", "night", "final"].includes(room.phase)) return; // 탄광 가는 날 낮에만
  const now = Date.now(), left = MN_MAX - WAGE - (me.mnEarn || 0);
  ws.mnHits = (ws.mnHits || []).filter((t) => now - t < 1000); // 최근 1초 동안의 타격 시각
  if (ws.mnHits.length >= MN_RATE || left <= 0) return; // 너무 빠르거나 한도를 다 채웠으면 무시
  ws.mnHits.push(now);
  const rock = (me.mnRock = me.mnRock || mnRock(0));
  if (--rock.hp > 0) return send(ws, { type: "mnHit", rock });
  const loot = mnLoot(rock.n);
  loot.v = Math.min(loot.v, left);
  me.mnEarn = (me.mnEarn || 0) + loot.v;
  me.mnRock = mnRock(rock.n + 1);
  if (loot.k === "dia") {
    me.mnDia = (me.mnDia || 0) + 1;
    const text = "💎 " + me.name + " 다이아 발견! +$" + loot.v;
    sys(room, text);
    broadcast(room, { type: "toast", text, coin: true });
  }
  send(ws, { type: "mnHit", rock: me.mnRock, loot });
  broadcastRoom(room);
}

// ---------- 시상식 칭호 ----------
// 판마다 room.result.payouts({ id: {bet, win} })를 읽어 p.ttStats에 쌓고, 최종 결과 때 각자 칭호 1~2개(p.ttTitles)를 붙인다.
// 기록은 broadcastRoom에서 한다 → 게임 코드를 안 건드리고, payouts 형식만 지키면 새 게임도 자동으로 잡힌다.
const ttNew = () => ({ wagered: 0, returned: 0, rounds: 0, bigWin: 0, bigLoss: 0, allIns: 0, bankrupt: 0, mined: 0, begged: 0, given: 0, byGame: {} });
const ttOf = (p) => p.ttStats || (p.ttStats = ttNew());

function ttRecord(room) {
  if (room.phase !== "result" || !room.result || room.result === room.ttLast) return;
  room.ttLast = room.result; // 같은 결과로 여러 번 broadcast돼도 한 번만
  for (const p of room.players.values()) {
    const po = (room.result.payouts || {})[p.id];
    if (!po || !po.bet) continue;
    const s = ttOf(p), net = po.win - po.bet;
    s.wagered += po.bet; s.returned += po.win; s.rounds++;
    s.bigWin = Math.max(s.bigWin, net); s.bigLoss = Math.max(s.bigLoss, -net);
    if ((!room.free && po.bet >= room.cap) || p.money - po.win === 0) s.allIns++; // 상한까지 질렀거나 가진 돈을 다 걸었으면 올인
    s.byGame[room.game] = (s.byGame[room.game] || 0) + net;
  }
}

// [칭호, 점수(s, 최종 순위 0~) → 클수록 유력, null = 자격 없음]. 1등(동점이면 공동)이 받는다. 위에 있는 칭호부터 준다.
const TT_RULES = [
  ["🔥 불사조", (s, rank) => (s.bankrupt && rank < 3 ? 1 : null)], // 파산했다가 3위 안으로
  ["🎰 올인 광", (s) => (s.allIns >= 2 ? s.allIns : null)],
  ["💎 한탕주의", (s) => (s.bigWin > 0 ? s.bigWin : null)],
  ...GAMES.map((g) => ["🎯 " + g.name + " 장인", (s) => (s.byGame[g.key] > 0 ? s.byGame[g.key] : null)]),
  ["📉 하우스의 VIP", (s) => (s.wagered > s.returned ? s.wagered - s.returned : null)],
  ["🎢 롤러코스터", (s) => (s.bigWin && s.bigLoss ? s.bigWin + s.bigLoss : null)],
  ["⛏️ 탄광 VIP", (s) => s.mined || null],
  ["🥺 구걸왕", (s) => s.begged || null],
  ["😇 적선왕", (s) => s.given || null],
  ["🍀 타짜", (s) => (s.returned > s.wagered ? s.returned / s.wagered : null)], // 환수율 1위
  ["🐢 쫄보", (s) => (s.rounds ? -s.wagered / s.rounds : null)], // 판당 평균 베팅 최소
  ["🧊 강철 멘탈", (s) => (s.rounds && !s.bankrupt ? -s.bigLoss : null)], // 파산 없이 한 판 손실 최소
];

// 혼자 딴 칭호를 순위대로 한 명씩 돌아가며 하나씩(최대 2개) → 공동 수상은 아직 칭호가 없는 사람에게만 → 그래도 없으면 평범한 도박꾼
function ttAward(room) {
  const ps = [...room.players.values()].sort((a, b) => b.money - a.money), won = ps.map(() => []);
  for (const [name, score] of TT_RULES) {
    const sc = ps.map((p, rank) => score(ttOf(p), rank)), best = Math.max(...sc.filter((v) => v !== null));
    const who = ps.map((_, i) => i).filter((i) => sc[i] === best);
    for (const i of who) won[i].push({ name, solo: who.length === 1 });
  }
  ps.forEach((p) => { p.ttTitles = []; });
  for (const solo of [true, true, false]) ps.forEach((p, i) => {
    const t = won[i].find((w) => w.solo === solo && !p.ttTitles.includes(w.name));
    if (t && (solo || !p.ttTitles.length)) p.ttTitles.push(t.name);
  });
  for (const p of ps) if (!p.ttTitles.length) p.ttTitles.push("😐 평범한 도박꾼");
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
  room.players.get(ws).ttStats = ttNew(); // 시상식 칭호 통계 (도중 입장자도 빈 통계로. 나갔다 온 사람은 아래 rcJoin이 되돌린다)
  rcJoin(ws, room);
  send(ws, { type: "joined", playerId: ws.id });
  broadcastRoom(room);
  broadcastRoomList();
  if (room.phase === "racing") send(ws, raceMsg(room)); // 경주 도중 입장하면 이어서 관전
  if (room.phase === "ipDecide") ipPeek(ws, room); // 인디언 포커 도중 입장 = 구경꾼이라 카드를 다 본다
  if (room.au && room.phase === "betting") auSendMe(room, ws); // 경매 도중 입장해도 이번 상자 힌트를 받는다
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
  if (room.ip) ipCheckDone(room); // 나간 사람만 콜/다이를 고민 중이었던 경우 (나간 사람은 다이로 친다)
  if (room.wg) wgCheck(room); // 차례인 사람이 나갔거나 1명만 남은 경우
  if (room.du) duCheck(room); // 나간 사람만 아직 안 쐈던 경우
  if (room.sw) swCheck(room); // 나간 사람만 아직 안 멈췄던 경우
  if (room.dg) dgCheck(room); // 나간 사람 빼고 1명만 남은 경우
  if (room.bl) blCheckDone(room); // 나간 사람만 줄을 쥐고 있었던 경우
}

// ---------- 이모티콘 리액션 ----------
// 😂 💸 😡 🙏 🔥 👏 😱 🤑 — 번호(0~7)만 오간다 (클라이언트 EM_LIST와 같은 순서). 채팅 로그에는 안 남긴다.
const EM_COUNT = 8;
const EM_GAP = 600; // 한 사람당 연타 제한(ms)
function emReact(room, ws, me, e) {
  if (!Number.isInteger(e) || e < 0 || e >= EM_COUNT || Date.now() - (ws.emLast || 0) < EM_GAP) return;
  ws.emLast = Date.now();
  broadcast(room, { type: "emReact", id: me.id, e }); // 보낸 사람도 이걸 받아서 띄운다 (순서·연타 제한이 모두에게 같게)
}

function handleMessage(ws, msg) {
  if (msg.type === "rcHello") return rcHello(ws, msg.token); // 재접속
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
  if (msg.type === "bet" && room.ip) return; // 인디언 포커는 참가비가 고정이라 칩 베팅 대신 ipJoin
  if (msg.type === "ipJoin") return canBet && room.ip ? ipJoin(room, me, !!msg.v) : undefined;
  if (msg.type === "ipAct") return ipAct(room, me, msg.a);
  if (msg.type === "bet" && room.au) return; // 경매는 밀봉 입찰(auBid)만 받는다 — me.bets는 모두에게 방송되니까
  if (msg.type === "auBid") return room.au && canBet && auBid(room, ws, me, msg.v);
  if (msg.type === "bet" && room.wg) return; // 러시안 룰렛은 참가비가 고정 → wgAct "in"으로만
  if (msg.type === "bet" && room.du) return; // 결투도 참가비 고정 → duJoin으로만
  if (msg.type === "duJoin") return duJoin(room, me, !!msg.v);
  if (msg.type === "duShot") return duShot(room, me, msg.rt);
  if (msg.type === "bet" && room.sw) return; // 스톱워치도 참가비 고정 → swJoin으로만
  if (msg.type === "swJoin") return swJoin(room, me, !!msg.v);
  if (msg.type === "swStop") return swStop(room, me, msg.t);
  if (msg.type === "bet" && room.dg) return; // 총알 피하기도 참가비 고정 → dgJoin으로만
  if (msg.type === "dgJoin") return dgJoin(room, me, !!msg.v);
  if (msg.type === "dgPos") return dgPos(room, ws, me, msg.x, msg.y);
  if (msg.type === "dgDie") return dgDie(room, me, msg.t);
  if (msg.type === "emReact") return emReact(room, ws, me, msg.e); // 이모티콘 리액션 (방 안에서만)

  if (msg.type === "start") {
    if (room.phase === "lobby" && me === hostOf(room)) startVote(room);
  } else if (msg.type === "days") {
    if (room.phase !== "lobby" || me !== hostOf(room) || !Number.isInteger(msg.n) || msg.n < 1 || msg.n > MAX_DAYS) return;
    room.days = msg.n;
    broadcastRoom(room);
  } else if (msg.type === "chat") {
    const text = String(msg.text || "").trim().slice(0, 120);
    if (!text || Date.now() - (ws.lastChat || 0) < 400) return; // 도배 방지
    ws.lastChat = Date.now();
    broadcast(room, { type: "chat", id: me.id, name: me.name, color: me.color, text });
  } else if (msg.type === "again") {
    if (room.phase !== "final") return;
    Object.assign(room, { phase: "lobby", day: 0, game: null, entrants: null, bj: null, dice: null, pg: null, race: null, result: null, night: null, vote: null });
    room.nc = null;
    room.ip = null;
    room.au = null;
    room.wg = null;
    room.du = null;
    room.sw = null;
    room.dg = null;
    room.cn = null;
    room.pk = null;
    for (const p of room.players.values()) Object.assign(p, { money: START_MONEY, dayStart: START_MONEY, history: [START_MONEY], ready: false, begging: false, begged: false, mining: false, bets: {} });
    room.bl = null;
    room.rcLeft.clear(); rcHostFix(room); // 재접속: 지난 판 스냅샷은 버리고, 끊긴 사람(📴)은 방장 자리에서 뒤로
    for (const p of room.players.values()) p.lnDebt = 0; // 새 게임이면 사채도 탕감
    for (const p of room.players.values()) Object.assign(p, { ttStats: ttNew(), ttTitles: null }); // 시상식 칭호 초기화
    broadcastRoom(room);
    broadcastRoomList();
  } else if (msg.type === "bet") {
    const i = msg.i;
    if (!canBet || !Number.isInteger(i) || i < 0 || i >= (room.entrants ? room.entrants.length : room.dice ? DICE_BETS.length : room.bj ? 2 : 1)) return; // 경마=출전 수, 주사위=베팅 칸 수, 블랙잭=0번 본 베팅 + 1번 퍼펙트 페어, 나머지=0번 칸 하나
    const spent = Object.values(me.bets).reduce((a, b) => a + b, 0);
    const amount = Math.min(Math.floor(Number(msg.amount)), me.money, room.free ? Infinity : room.cap - spent); // 크게 오면 상한(또는 가진 돈)까지만
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
    if ((room.phase !== "betting" || me.mining) && room.phase !== "night") return;
    me.ready = !!msg.v;
    broadcastRoom(room);
    checkAllReady(room);
    checkNightReady(room);
  } else if (msg.type === "vote") {
    if (room.phase !== "vote" || room.vote.pick !== null || ![0, 1, 2, 3].includes(msg.i)) return;
    room.vote.votes[me.id] = msg.i;
    broadcastRoom(room);
    checkVoteReady(room); // 마지막 사람이 누르는 순간 추첨
  } else if (msg.type === "blAct") {
    blAct(room, me);
  } else if (msg.type === "cnAct") {
    cnAct(room, me, msg.a);
  } else if (msg.type === "pg") {
    pgAction(room, me, msg.a);
  } else if (msg.type === "wgAct") {
    wgAct(room, me, msg.a);
  } else if (msg.type === "pkZone") { // 공이 떨어질 구역 0 중앙 · 1 외곽 · 2 최외곽. 준비(베팅 잠김) 전까지만 바꿀 수 있다
    if (!canBet || !room.pk || ![0, 1, 2].includes(msg.v)) return;
    me.pkZone = msg.v;
    broadcastRoom(room);
  } else if (msg.type === "bj") {
    bjAction(room, me, msg.a);
  } else if (msg.type === "beg") {
    // 밤 정산 때 파산한 사람만, 하룻밤에 딱 한 번. (취소하면 기회는 날아간다)
    if (room.phase !== "night") return;
    if (msg.v && (me.money > 0 || me.begged)) return;
    me.begging = !!msg.v;
    if (msg.v) { me.begged = true; sys(room, "🥺 " + me.name + ": 한푼 줍쇼!"); }
    if (msg.v) ttOf(me).begged++; // 시상식 칭호 통계
    broadcastRoom(room);
    checkNightReady(room);
  } else if (msg.type === "give") {
    const to = [...room.players.values()].find((p) => p.id === msg.to);
    if (!to || to === me || !to.begging) return;
    if (me.money < ALMS) return send(ws, { type: "error", message: "적선할 돈($" + ALMS + ")이 없어요…" });
    me.money -= ALMS;
    to.money += ALMS;
    to.begging = false; // 누가 한 번 주면 그걸로 끝
    ttOf(me).given++; // 시상식 칭호 통계
    me.history[room.day] = me.money; // 적선은 밤에만 일어난다 → 오늘 밤 그래프에 반영
    to.history[room.day] = to.money;
    me.history[room.day] = lnNet(me); to.history[room.day] = lnNet(to); // 사채: 그래프는 순자산
    sys(room, "🪙 " + me.name + " → " + to.name + " $" + ALMS + " 적선");
    broadcast(room, { type: "toast", text: "🪙 " + me.name + " → " + to.name + " $" + ALMS + " 적선!", coin: true });
    broadcastRoom(room);
  } else if (msg.type === "lnAct") {
    lnAct(room, me, msg.a);
  } else if (msg.type === "mnHit") {
    mnHit(ws, room, me);
  } else if (msg.type === "leave") {
    rcLeave(ws, room, me);
    leaveRoom(ws);
    rcCheckEmpty(room); // 남은 사람이 전부 📴일 수도 있다
  }
}

// ---------- 재접속 ----------
// 토큰 = 브라우저 localStorage에 둔 내 신분증(rcHello로 받는다). players는 통째로 브로드캐스트되니 player엔 절대 안 넣고 서버 전용 Map에만 둔다.
// 끊기면(창 닫힘·폰 꺼짐·새로고침·핑 정리) 자리를 그대로 두고 p.rcAway = true(📴). 같은 토큰으로 rcHello 하면 그 자리에 다시 앉힌다.
// 📴인 동안: 베팅/밤은 자동 준비, 투표는 건너뜀, 결정이 필요한 단계는 RC_AUTO마다 rcAutoAct가 대신 처리.
// "방 나가기"는 자리를 비우되 스냅샷을 room.rcLeft에 맡겨 둔다 → 같은 토큰으로 다시 들어오면 $1000 새 사람이 아니라 그때 돈·기록으로.
// ponytail: 새 토큰(시크릿 창·다른 브라우저)으로 들어오면 새 사람이다. 막으려면 로그인 같은 진짜 신원이 필요하다.
const RC_AUTO = 8000; // 📴인 사람 대신 결정을 내리는 주기
const RC_EMPTY = 120000; // 방 인원 전원이 📴인 채로 이만큼 지나면 방을 치운다
const rcTokens = new Map(); // token -> { room, id }
// 게임별 자동 처리 (room, p): 📴인 사람에게 RC_AUTO마다 불린다. 결정할 게 없으면 아무것도 안 해야 하고, 처리했으면 그 게임의 진행 체크까지 부른다. 새 게임은 한 줄 추가.
const rcAutoAct = {
  blackjack: (room, p) => bjAction(room, p, "stand"),
  penguin: (room, p) => {
    if (room.phase !== "playing" || !p.pg || p.pg.state !== "playing") return;
    if (p.pg.step) return pgAction(room, p, "stop"); // 한 번이라도 뛰었으면 거기서 챙긴다
    p.money += p.bets[0] || 0; p.bets = {}; p.pg.state = "out"; // 안 뛰었으면 판돈 돌려주고 구경
    broadcastRoom(room);
    pgCheckDone(room);
  },
  indian: (room, p) => ipAct(room, p, "die"), // 결정 못 하고 끊기면 다이 (이미 정했으면 ipAct가 무시)
  watergun: (room, p) => wgAct(room, p, "pull"), // 자기 차례면 당긴다 (차례가 아니면 wgAct가 무시)
  balloon: (room, p) => blAct(room, p), // 쥐고 있던 풍선은 그 자리에서 놓는다
  stopwatch: (room) => swCheck(room), // 📴는 안 누른 걸로 친다 → 나머지가 다 멈췄으면 끝낸다
};
// 복귀할 때 부르는 훅 (room, ws, p): 게임별로 본인에게만 보내던 비공개 정보를 다시 보낸다. 새 게임이 rcResync.push(...)로 붙인다.
const rcResync = [
  (room, ws, p) => room.nc && room.nc.picks[p.id] && send(ws, { type: "ncPick", n: room.nc.picks[p.id] }), // 눈치 숫자: 내가 고른 숫자
  (room, ws) => room.phase === "ipDecide" && ipPeek(ws, room), // 인디언 포커: 나 빼고 남들 카드
  (room, ws) => room.au && auSendMe(room, ws), // 경매: 내 비밀 힌트·입찰액
];

function rcHello(ws, tok) {
  if (ws.room || typeof tok !== "string" || !/^[\w-]{8,64}$/.test(tok)) return;
  ws.rcToken = tok; // 복귀에 실패해도 이 연결로 create/join 하면 이 토큰으로 묶인다
  const e = rcTokens.get(tok), room = e && rooms.get(e.room.code) === e.room ? e.room : null;
  const old = room && [...room.players.keys()].find((w) => room.players.get(w).id === e.id);
  if (!old) { rcTokens.delete(tok); return send(ws, { type: "rcFail" }); } // 모르는 토큰 / 방이 사라짐 → 클라이언트는 타이틀로
  const p = room.players.get(old);
  clearInterval(old.rcTimer);
  old.room = null; // 같은 토큰의 다른 탭이 아직 붙어 있으면 끊는다 (room을 먼저 비워서 close 처리가 자리를 건드리지 않게)
  if (old.readyState === old.OPEN) { send(old, { type: "rcKicked" }); old.close(); }
  const list = [...room.players];
  room.players.clear();
  for (const [w, q] of list) room.players.set(w === old ? ws : w, q); // 키만 바꾸고 순서 유지 (첫 번째 = 방장)
  ws.id = p.id;
  ws.room = room;
  if (p.rcAway) sys(room, "🔌 " + p.name + " 돌아옴");
  p.rcAway = false;
  send(ws, { type: "joined", playerId: p.id });
  broadcastRoom(room);
  if (room.phase === "racing") send(ws, raceMsg(room));
  for (const f of rcResync) f(room, ws, p);
}

function rcAway(ws) {
  const room = ws.room, p = room && room.players.get(ws);
  if (!p || !ws.rcToken) return; // 토큰 없는 연결은 예전처럼 leaveRoom이 치운다
  ws.room = null; // 자리는 남긴다 → 바로 뒤에 도는 leaveRoom(ws)은 할 일이 없다
  p.rcAway = true;
  if (room.dg) dgDie(room, p); // 총알 피하기: 끊긴 그 시각에 사망
  ws.rcTimer = setInterval(() => rcAutoAct[room.game]?.(room, p), RC_AUTO);
  if (room.phase === "lobby") rcHostFix(room);
  sys(room, "📴 " + p.name + " 연결 끊김 — 돌아오면 그대로 이어서");
  broadcastRoom(room);
  checkAllReady(room);
  checkNightReady(room);
  checkVoteReady(room);
  rcCheckEmpty(room);
}

// 대기실에서 방장이 📴면 아무도 시작을 못 한다 → 끊긴 사람은 순서 맨 뒤로 (돌아와도 그 자리)
function rcHostFix(room) {
  for (const [w, q] of [...room.players]) if (q.rcAway) { room.players.delete(w); room.players.set(w, q); }
}

function rcCheckEmpty(room) {
  clearTimeout(room.rcEmpty);
  if ([...room.players.values()].every((p) => p.rcAway)) room.rcEmpty = setTimeout(() => rcDrop(room), RC_EMPTY);
}

function rcDrop(room) {
  if (rooms.get(room.code) !== room || [...room.players.values()].some((p) => !p.rcAway)) return; // 그새 누가 돌아왔거나 들어왔으면 그대로
  clearTimeout(room.timer);
  for (const w of room.players.keys()) clearInterval(w.rcTimer);
  for (const [t, e] of rcTokens) if (e.room === room) rcTokens.delete(t);
  rooms.delete(room.code);
  broadcastRoomList();
}

function rcLeave(ws, room, p) {
  if (!ws.rcToken) return;
  rcTokens.delete(ws.rcToken);
  room.rcLeft.set(ws.rcToken, { day: room.day, money: p.money, dayStart: p.dayStart, history: p.history, mining: p.mining, begged: p.begged, look: p.look, color: p.color,
    lnDebt: p.lnDebt, ttStats: p.ttStats, mnEarn: p.mnEarn, mnRock: p.mnRock }); // 빚·통계·오늘 캔 돈도 맡겨 둔다 (나갔다 오면 빚이 사라지는 구멍 방지)
}

// joinRoom이 새 자리를 만든 직후: 토큰을 이 자리에 묶고, 이 방에서 나갔던 사람이면 그때 돈·기록으로 되돌린다
function rcJoin(ws, room) {
  if (!ws.rcToken) return;
  const p = room.players.get(ws), s = room.rcLeft.get(ws.rcToken);
  rcTokens.set(ws.rcToken, { room, id: p.id });
  if (!s) return;
  room.rcLeft.delete(ws.rcToken);
  const upto = room.phase === "night" || room.phase === "final" ? room.day : room.day - 1;
  for (let d = s.history.length; d <= upto; d++) s.history[d] = s.money - (s.lnDebt || 0); // 없던 동안은 순자산이 그대로였다
  Object.assign(p, { money: s.money, dayStart: s.money, history: s.history, look: s.look, lnDebt: s.lnDebt || 0, ttStats: s.ttStats || p.ttStats },
    s.day === room.day && { dayStart: s.dayStart, mining: s.mining, begged: s.begged, mnEarn: s.mnEarn, mnRock: s.mnRock });
  if (![...room.players.values()].some((q) => q !== p && q.color === s.color)) p.color = s.color;
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
  ws.on("close", () => rcAway(ws)); // 재접속: leaveRoom보다 먼저 등록. 자리를 남길 땐 ws.room을 비워서 아래 leaveRoom이 할 일이 없게 한다
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
  assert(entrants.length === FIELD && implied > 0.9 && implied < 1.2 && entrants.every((e) => e.odds <= MAX_MULT)); // 롱샷을 x15로 자르면 내재확률 합이 1보다 커진다

  const r = simulate(entrants, true);
  assert(r.pos[r.order[0]].some((p) => p >= TRACK) && r.pos.every((p) => p.length === r.fx[0].length));

  entrants[2].odds = 3.5;
  const p = { id: "p", money: 700, bets: { 2: 100, 4: 200 } };
  assert.deepStrictEqual(settle([p], entrants, 2), { p: { bet: 300, win: 350 } });
  assert(p.money === 1050 && Object.keys(p.bets).length === 0);
  // 펭귄: 어디서 멈추든 기대 환급률이 95%인지 + 운을 조작한 한 판 (성공 2번 후 멈춤 / 첫 점프에 풍덩)
  PG_MULTS.forEach((m, k) => assert(Math.abs(m * PG_PROBS.slice(0, k + 1).reduce((a, b) => a * b, 1) - PG_EDGE) < 0.01, "펭귄 " + (k + 1) + "칸 환급률이 어긋남"));
  for (let i = 0; i < 30; i++) { const G = pgGold({}); assert(G.gold >= 1 && G.gold <= PG_PROBS.length - 2 && G.mults.every((m, k) => m <= MAX_MULT && m * G.probs.slice(0, k + 1).reduce((a, b) => a * b, 1) <= PG_EDGE + 0.01), "황금 얼음 환급률이 95%를 넘음"); }
  console.log("펭귄 배당", PG_MULTS.map((m, k) => Math.round(PG_PROBS[k] * 100) + "%→x" + m).join(" "));
  process.env.GAME = "penguin";
  const fp = () => ({ id: crypto.randomUUID(), room: null, readyState: 0, OPEN: 1, send() {} });
  const g1 = fp(), g2 = fp();
  handleMessage(g1, { type: "create", name: "G1" });
  handleMessage(g2, { type: "join", id: g1.room.code, name: "G2" });
  handleMessage(g1, { type: "start" });
  const gr = g1.room, G1 = gr.players.get(g1), G2 = gr.players.get(g2), realRandom = Math.random;
  Object.assign(gr.pg, { gold: 5, probs: PG_PROBS.map((q, k) => (k === 5 ? q / 2 : q)) }); gr.pg.mults = pgMults(gr.pg.probs); // 황금 얼음은 6번째 점프에 고정 (앞 칸 배당은 그대로)
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

  // 인디언 포커: 공개 전엔 자기 카드·남의 결정이 안 샌다 + 짜고 친 네 판
  // (콜·콜·시간 초과 다이+10 벌금 / 전원 다이 → 환불 / 도중 퇴장 + 동점 나눔 / 상대가 없으면 무효)
  process.env.GAME = "indian";
  assert(!playable({ players: { size: 1 } }).some((g) => g.key === "indian"), "혼자서는 못 한다");
  const ipFake = () => { const w = { id: crypto.randomUUID(), room: null, readyState: 1, OPEN: 1, sent: [], send: (d) => w.sent.push(JSON.parse(d)) }; return w; };
  const ipW = [ipFake(), ipFake(), ipFake(), ipFake()]; // A, B, C + 구경꾼
  handleMessage(ipW[0], { type: "create", name: "A" });
  for (const w of ipW.slice(1)) handleMessage(w, { type: "join", id: ipW[0].room.code, name: "X" });
  handleMessage(ipW[0], { type: "start" });
  const ipR = ipW[0].room, [ipA, ipB, ipC] = ipW.map((w) => ipR.players.get(w));
  const ipGo = (ws) => { for (const w of ws) handleMessage(w, { type: "ipJoin", v: true }); for (const w of ipW) handleMessage(w, { type: "ready", v: true }); };
  const ipRun = (f) => { clearTimeout(ipR.timer); f(ipR); clearTimeout(ipR.timer); }; // 타이머 콜백을 직접 부른다
  const ipRig = (cards) => [ipA, ipB, ipC].forEach((p, k) => { if (p.id in ipR.ip.cards) ipR.ip.cards[p.id] = cards[k]; });
  assert(ipR.game === "indian" && ipR.cap === 100 && ipR.ip.rounds === IP_ROUNDS);
  handleMessage(ipW[0], { type: "bet", i: 0, amount: 50 });
  assert(ipA.money === 1000, "칩 베팅은 막혀 있다 (참가비 고정)");
  ipGo(ipW.slice(0, 3));
  assert(ipR.phase === "ipDecide" && ipA.money === 900 && ipR.ip.ids.length === 3);
  ipRig([7, 3, 10]);
  handleMessage(ipW[0], { type: "ipAct", a: "call" });
  handleMessage(ipW[0], { type: "ipAct", a: "die" }); // 번복 불가
  handleMessage(ipW[3], { type: "ipAct", a: "call" }); // 구경꾼은 못 낀다
  handleMessage(ipW[1], { type: "ipAct", a: "call" });
  assert(ipR.phase === "ipDecide" && ipR.ip.calls[ipA.id] === true && !(ipW[3].id in ipR.ip.calls) && ipA.money === 900, "콜 비용은 공개 전엔 안 빠진다 (HUD 스포일러 방지)");
  for (const w of ipW) {
    const peek = w.sent.filter((m) => m.type === "ipCards"), views = w.sent.filter((m) => m.type === "room" && m.room.ip).map((m) => m.room.ip);
    assert(peek.length === 1 && !(w.id in peek[0].cards) && Object.keys(peek[0].cards).length === (w === ipW[3] ? 3 : 2), "자기 카드만 빼고 받는다 (구경꾼은 전부)");
    assert(views.every((v) => v.cards === null && v.calls === null) && views[views.length - 1].done.length === 2, "공개 전엔 누가 정했는지만 나간다");
    assert(!JSON.stringify(w.sent.filter((m) => m.type === "room").map((m) => m.room.players)).includes("card"), "player 객체에는 카드가 없다");
  }
  ipRun(ipReveal); // 20초 타이머: 결정 안 한 C는 다이
  const ipLast = ipW[0].sent[ipW[0].sent.length - 1].room;
  assert(ipR.phase === "ipReveal" && ipLast.ip.cards[ipA.id] === 7 && ipLast.ip.calls[ipC.id] === false && ipA.money === 900, "공개는 하되 돈은 연출이 끝난 뒤에 움직인다");
  ipRun(ipSettle);
  assert(ipA.money === 800 + 570 && ipB.money === 800 && ipC.money === 800, "A: floor((참가비 300 + 콜 200 + 벌금 100) × 0.95) = 570, C: 10 들고 다이 → 벌금 100");
  assert.deepStrictEqual(ipR.result.winners, [ipA.id]);
  assert.deepStrictEqual(ipR.result.penalties, { [ipC.id]: 100 });
  assert.deepStrictEqual(ipR.result.payouts, { [ipA.id]: { bet: 200, win: 570 }, [ipB.id]: { bet: 200, win: 0 }, [ipC.id]: { bet: 200, win: 0 } });
  assert(ipR.result.pot === 600 && !ipA.bets[0]);
  ipRun(ipNext);
  ipGo(ipW.slice(0, 2)); // 2판: C는 구경
  ipRig([10, 4]);
  ipB.money = 50;
  handleMessage(ipW[1], { type: "ipAct", a: "call" });
  assert(!(ipB.id in ipR.ip.calls), "돈이 모자라면 콜 불가");
  ipB.money = 700;
  handleMessage(ipW[0], { type: "ipAct", a: "die" });
  handleMessage(ipW[1], { type: "ipAct", a: "die" });
  assert(ipR.phase === "ipReveal", "전원 결정하면 바로 공개");
  ipRun(ipSettle);
  assert(ipA.money === 1370 && ipB.money === 800 && ipR.result.pot === 0 && !ipR.result.winners.length && !ipR.result.penalties[ipA.id], "아무도 콜 안 하면 환불, 10을 들고 죽어도 벌금 없음");
  ipRun(ipNext);
  ipGo(ipW.slice(0, 3)); // 3판: C가 고민하다 나간다 → 다이 처리, 참가비는 판돈에 남는다
  ipRig([5, 5, 9]);
  handleMessage(ipW[0], { type: "ipAct", a: "call" });
  handleMessage(ipW[1], { type: "ipAct", a: "call" });
  leaveRoom(ipW[2]);
  assert(ipR.phase === "ipReveal" && ipR.ip.calls[ipC.id] === false);
  ipRun(ipSettle);
  assert(ipA.money === 1370 - 200 + 237 && ipB.money === 800 - 200 + 237 && ipR.result.winners.length === 2, "동점이면 floor(500 × 0.95 ÷ 2)씩");
  ipR.ip.rounds = 4; // 체크용으로 한 판 더
  ipRun(ipNext);
  ipGo(ipW.slice(0, 1)); // 4판: 혼자 참가 → 무효, 참가비 환불
  assert(ipR.phase === "result" && ipA.money === 1407 && !ipR.result.winners.length && !ipR.ip.ids.length);
  ipRun(ipNext);
  assert(ipR.phase === "night");
  delete process.env.GAME;
  rooms.delete(ipR.code);

  // 미스터리 상자 경매: 분포 · 힌트(정답 아님, 안 겹침) · 입찰이 안 새는지 · 짜고 연 한 판 · 동점 추첨 · 돈보다 큰 입찰 거절
  assert(Math.abs(AU_PROBS.reduce((a, b) => a + b, 0) - 1) < 1e-9 && AU_PROBS.length === AU_MULTS.length, "상자 확률 합 = 1");
  assert(AU_EV > 0.7 && AU_EV < 0.8, "상자 기대값은 입찰 상한의 70~80%");
  console.log("경매 상자", AU_MULTS.map((m, i) => "x" + m + " " + Math.round(AU_PROBS[i] * 100) + "%").join(", "), "| 기대값 x" + AU_EV.toFixed(2));
  process.env.GAME = "auction";
  const auFake = () => { const w = { id: crypto.randomUUID(), room: null, readyState: 1, OPEN: 1, log: [] }; w.send = (d) => w.log.push(JSON.parse(d)); return w; };
  const au1 = auFake(), au2 = auFake(), au3 = auFake(), auWs = [au1, au2, au3], auRandom = Math.random;
  handleMessage(au1, { type: "create", name: "A" });
  handleMessage(au2, { type: "join", id: au1.room.code, name: "B" });
  handleMessage(au3, { type: "join", id: au1.room.code, name: "C" });
  handleMessage(au1, { type: "start" });
  const auRoom = au1.room, [auA, auB, auC] = auWs.map((w) => auRoom.players.get(w)), auLast = (w) => w.log.filter((m) => m.type === "auMe").pop();
  assert(auRoom.game === "auction" && auRoom.cap === 200 && auRoom.phase === "betting" && auRoom.au.vals.join() === "-100,0,50,100,200,300,600");
  for (let i = 0; i < 500; i++) { // 힌트: 정답이 아니고 사람끼리 안 겹친다
    if (i) auDeal(auRoom.au);
    const h = auWs.map((w) => { if (i) auSendMe(auRoom, w); return auLast(w).hint; });
    assert(new Set(h).size === 3 && !h.includes(auRoom.au.box) && h.every((x) => x >= 0 && x < AU_MULTS.length), "힌트가 정답이거나 겹침");
  }
  handleMessage(au1, { type: "bet", i: 0, amount: 100 }); // 제네릭 베팅은 막힌다
  handleMessage(au1, { type: "auBid", v: 120 });
  handleMessage(au2, { type: "auBid", v: 200 });
  auC.money = 50;
  handleMessage(au3, { type: "auBid", v: 80 }); // 가진 돈보다 큼 → 거절
  handleMessage(au3, { type: "auBid", v: 1.5 });
  assert(auRoom.au.bids[auA.id] === 120 && auRoom.au.bids[auB.id] === 200 && !(auC.id in auRoom.au.bids) && auLast(au1).bid === 120 && auLast(au2).bid === 200);
  assert(auA.money === 1000 && !Object.keys(auA.bets).length, "입찰해도 공개 전엔 돈도 me.bets도 안 움직인다");
  handleMessage(au1, { type: "ready", v: true });
  handleMessage(au2, { type: "ready", v: true });
  handleMessage(au1, { type: "auBid", v: 10 }); // 준비하면 입찰이 잠긴다
  assert(auRoom.phase === "betting" && auRoom.au.bids[auA.id] === 120);
  for (const w of auWs) for (const m of w.log) { // 공개 전까지 오간 메시지에 남의 입찰액·힌트·상자 금액이 없어야 한다
    if (m.type === "room" && m.room.au) assert(Object.keys(m.room.au).sort().join() === "ev,probs,reveal,round,rounds,vals" && m.room.au.reveal === null && m.room.players.every((p) => !Object.keys(p.bets).length), "방송에 입찰/상자가 샘");
    if (m.type === "auMe") assert(Object.keys(m).sort().join() === "bid,day,hint,round,type" && [0, auRoom.au.bids[w.id]].includes(m.bid), "남의 입찰액이 샘");
  }
  auC.money = 1000;
  handleMessage(au3, { type: "auBid", v: 900 }); // 입찰 상한 없음: 기준가($200)보다 크게 불러도 받아 준다
  assert(auRoom.au.bids[auC.id] === 900, "입찰 상한 없음");
  handleMessage(au3, { type: "auBid", v: 0 });
  auC.money = 50;
  auRoom.au.box = AU_MULTS.indexOf(1.5); // 상자 속 $300으로 조작
  handleMessage(au3, { type: "ready", v: true });
  const auR = auRoom.au.reveal;
  assert(auRoom.phase === "auReveal" && auR.winner === auB.id && auR.price === 200 && auR.value === 300 && auR.bids.map((b) => b.bid).join() === "120,200");
  assert(auB.money === 1000, "돈은 개봉 연출이 끝난 뒤에 움직인다");
  clearTimeout(auRoom.timer);
  auSettle(auRoom);
  clearTimeout(auRoom.timer);
  assert(auRoom.phase === "result" && auB.money === 1100 && auA.money === 1000 && auC.money === 50, "B만 -200 +300, 나머지는 그대로");
  assert.deepStrictEqual(auRoom.result.payouts, { [auB.id]: { bet: 200, win: 300 } });
  auRoom.au.box = 0; auRoom.au.bids = { [auB.id]: 200 }; auB.money = 250; // 💣 폭탄(-$100): 입찰가 200 + 100인데 가진 돈이 250뿐 → 250만 잃는다
  auReveal(auRoom); clearTimeout(auRoom.timer); auSettle(auRoom); clearTimeout(auRoom.timer);
  assert(auB.money === 0 && auRoom.result.payouts[auB.id].bet === 250 && auRoom.result.payouts[auB.id].win === 0, "폭탄은 가진 돈까지만");
  auB.money = 1100;
  const auTie = [0, 0.99].map((rv) => { // 동점이면 추첨, 낙찰자는 맨 마지막에 공개
    Math.random = () => rv;
    auRoom.au.bids = { [auA.id]: 150, [auB.id]: 150 };
    auReveal(auRoom);
    clearTimeout(auRoom.timer);
    Math.random = auRandom;
    const R = auRoom.au.reveal;
    assert(R.price === 150 && R.bids.length === 2 && R.bids[1].id === R.winner);
    return R.winner;
  });
  assert(new Set(auTie).size === 2, "동점은 랜덤");
  auRoom.au.bids = {}; // 아무도 안 사면 상자만 열고 돈은 그대로
  auReveal(auRoom);
  clearTimeout(auRoom.timer);
  auSettle(auRoom);
  clearTimeout(auRoom.timer);
  assert(auRoom.result.winner === null && !Object.keys(auRoom.result.payouts).length && auB.money === 1100);
  delete process.env.GAME;
  rooms.delete(auRoom.code);

  // 러시안 룰렛: 총알 위치(1번 칸)와 순서를 정해 놓은 판 — A 당김(빈칸) → B 넘기기 → C 당김(탕). 그다음 판은 넘기기 제한·타임아웃·퇴장
  process.env.GAME = "watergun";
  const wgFake = () => ({ id: crypto.randomUUID(), room: null, readyState: 1, OPEN: 1, log: [], send(d) { this.log.push(d); } });
  const wgA = wgFake(), wgB = wgFake(), wgC = wgFake(), wgRandom = Math.random;
  handleMessage(wgA, { type: "create", name: "WA" });
  handleMessage(wgB, { type: "join", id: wgA.room.code, name: "WB" });
  handleMessage(wgC, { type: "join", id: wgA.room.code, name: "WC" });
  handleMessage(wgA, { type: "start" });
  const wr = wgA.room, WA = wr.players.get(wgA), WB = wr.players.get(wgB), WC = wr.players.get(wgC);
  const wgLeak = () => [wgA, wgB, wgC].some((w) => w.log.some((d) => d.includes("chamber")));
  assert(wr.game === "watergun" && wr.cap === 100 && wr.wg.rounds === WG_ROUNDS);
  handleMessage(wgA, { type: "bet", i: 0, amount: 10 });
  assert(!WA.bets[0] && WA.money === 1000, "제네릭 칩 베팅은 막혀 있다");
  Math.random = () => 0.2; // 총알 = 1번 칸 (두 번째로 당기는 칸)
  for (const w of [wgA, wgB, wgC]) { handleMessage(w, { type: "wgAct", a: "in" }); handleMessage(w, { type: "ready", v: true }); }
  Math.random = wgRandom;
  assert(wr.phase === "wgTurn" && wr.wg.pot === 300 && WA.money === 900 && wr.wg.order[0] === WA.id && wr.wg.chamber === 1);
  handleMessage(wgB, { type: "wgAct", a: "pull" });
  assert(!wr.wg.pulls.length, "자기 차례가 아니면 무시");
  handleMessage(wgA, { type: "wgAct", a: "pull" });
  assert(wr.wg.busy && wr.wg.shot === 1 && !wr.wg.pulls[0].bang);
  clearTimeout(wr.timer);
  wgNextTurn(wr);
  handleMessage(wgB, { type: "wgAct", a: "pass" });
  assert(WB.money === 850 && wr.wg.pot === 350 && wr.wg.shot === 1 && wr.wg.order[wr.wg.turn] === WC.id, "넘기면 약실은 그대로, 다음 사람 차례");
  handleMessage(wgC, { type: "wgAct", a: "pull" });
  assert(wr.wg.settling && WC.money === 900 && WA.money === 900 && !wr.result, "돈은 탕! 연출이 끝난 뒤에 움직인다");
  assert(!wgLeak(), "총알 위치는 판이 끝나기 전엔 어디에도 내보내지 않는다");
  clearTimeout(wr.timer);
  wgSettle(wr);
  clearTimeout(wr.timer);
  assert(wr.result.loser === WC.id && wr.result.chamber === 1 && wr.result.payouts[WA.id].win === 166 && wgLeak());
  assert(WA.money === 1066 && WB.money === 1016 && WC.money === 900, "생존자 2명이 floor(350 × 0.95 / 2) = 166씩");
  wgNext(wr); // 2번째 판: 순서가 한 칸 돌아 B → C → A
  Math.random = () => 0.99; // 총알 = 마지막 칸
  for (const w of [wgA, wgB, wgC]) { handleMessage(w, { type: "wgAct", a: "in" }); handleMessage(w, { type: "ready", v: true }); }
  Math.random = wgRandom;
  assert(wr.wg.round === 2 && wr.wg.order[0] === WB.id);
  handleMessage(wgB, { type: "wgAct", a: "pass" });
  WC.money = 10;
  handleMessage(wgC, { type: "wgAct", a: "pass" });
  assert(wr.wg.order[wr.wg.turn] === WC.id && WC.money === 10 && wr.wg.pot === 350, "돈이 모자라면 못 넘긴다");
  WC.money = 800;
  wgTimeout(wr); // 제한 시간 초과 → 자동 당기기
  assert(wr.wg.pulls.length === 1 && wr.wg.pulls[0].id === WC.id && wr.wg.busy);
  clearTimeout(wr.timer);
  wgNextTurn(wr);
  handleMessage(wgA, { type: "wgAct", a: "pull" });
  clearTimeout(wr.timer);
  wgNextTurn(wr);
  handleMessage(wgB, { type: "wgAct", a: "pass" });
  assert(wr.wg.order[wr.wg.turn] === WB.id && WB.money === 1016 - 150, "넘기기는 판당 1회");
  handleMessage(wgB, { type: "leave" }); // 차례인 사람이 나가면 다음 사람으로
  assert(wr.phase === "wgTurn" && wr.wg.order[wr.wg.turn] === WC.id);
  handleMessage(wgC, { type: "leave" }); // 1명만 남으면 그 사람이 판돈을 먹는다
  assert(wr.wg.settling && wr.wg.loser === null);
  clearTimeout(wr.timer);
  wgSettle(wr);
  clearTimeout(wr.timer);
  assert(WA.money === 966 + Math.floor(350 * WG_EDGE) && wr.result.survivors.length === 1);
  delete process.env.GAME;
  rooms.delete(wr.code);
  { // 연속 2발: 한 차례에 두 번 당기고, 살아남으면 몫이 두 배
    process.env.GAME = "watergun";
    const [d1, d2, d3] = [wgFake(), wgFake(), wgFake()];
    handleMessage(d1, { type: "create", name: "D1" });
    for (const w of [d2, d3]) handleMessage(w, { type: "join", id: d1.room.code, name: "D" });
    handleMessage(d1, { type: "start" });
    const dr = d1.room, [D1, D2, D3] = [d1, d2, d3].map((w) => dr.players.get(w));
    Math.random = () => 0.99; // 총알 = 마지막 칸
    for (const w of [d1, d2, d3]) { handleMessage(w, { type: "wgAct", a: "in" }); handleMessage(w, { type: "ready", v: true }); }
    Math.random = wgRandom;
    handleMessage(d1, { type: "wgAct", a: "double" });
    assert(dr.wg.shot === 1 && dr.wg.again && dr.wg.doubled[D1.id]);
    clearTimeout(dr.timer); dr.wg.again = false; dr.wg.busy = false; wgAct(dr, D1, "pull"); // 1.4초 뒤 두 번째 당기기
    assert(dr.wg.shot === 2 && dr.wg.order[dr.wg.turn] === D1.id && dr.wg.pulls.every((q) => q.id === D1.id), "두 번 다 D1, 차례는 그대로");
    clearTimeout(dr.timer); wgNextTurn(dr);
    handleMessage(d2, { type: "wgAct", a: "pull" }); clearTimeout(dr.timer); wgNextTurn(dr);
    handleMessage(d3, { type: "wgAct", a: "double" }); // 남은 칸 3개(2·3·4번 중 총알은 5번) → 가능
    assert(dr.wg.doubled[D3.id]);
    clearTimeout(dr.timer); dr.wg.again = false; dr.wg.busy = false; wgAct(dr, D3, "pull"); clearTimeout(dr.timer); wgNextTurn(dr);
    handleMessage(d1, { type: "wgAct", a: "double" }); // 판당 1회
    assert(dr.wg.shot === 5 && !dr.wg.again && dr.wg.pulls.length === 5);
    handleMessage(d1, { type: "wgAct", a: "pull" }); // 탕
    clearTimeout(dr.timer); wgSettle(dr); clearTimeout(dr.timer);
    const u = (300 * WG_EDGE) / 3; // D2 몫 1 + D3 몫 2
    assert(dr.result.loser === D1.id && dr.result.payouts[D2.id].win === Math.floor(u) && dr.result.payouts[D3.id].win === Math.floor(u * 2), "연속 2발 생존자는 몫 두 배");
    delete process.env.GAME;
    rooms.delete(dr.code);
  }

  { // 총잡이 결투: 오발은 아웃, 신호 뒤 제일 빠른 사람이 독식, 신호 시각은 안 샌다
    process.env.GAME = "duel";
    const [a, b, c] = [wgFake(), wgFake(), wgFake()];
    handleMessage(a, { type: "create", name: "DA" });
    for (const w of [b, c]) handleMessage(w, { type: "join", id: a.room.code, name: "D" });
    handleMessage(a, { type: "start" });
    const r = a.room, [A, B, C] = [a, b, c].map((w) => r.players.get(w));
    assert(r.game === "duel" && r.cap === 100);
    handleMessage(a, { type: "bet", i: 0, amount: 10 });
    assert(!A.bets[0], "결투는 칩 베팅을 안 받는다");
    for (const w of [a, b, c]) { handleMessage(w, { type: "duJoin", v: true }); handleMessage(w, { type: "ready", v: true }); }
    assert(r.phase === "duWait" && r.du.pot === 300 && A.money === 900);
    handleMessage(c, { type: "duShot", rt: 150 }); // 신호 전 = 오발
    assert(r.du.fouls[0] === C.id && r.phase === "duWait");
    clearTimeout(r.timer); r.du.fakeTimers.forEach(clearTimeout);
    duFire(r);
    assert([a, b, c].every((w) => w.log.some((d) => d.includes('"duCue"'))) && ![a, b, c].some((w) => w.log.some((d) => d.includes('"at"'))));
    r.du.fired -= 1000; // 신호 후 1초 지났다고 치고
    handleMessage(c, { type: "duShot", rt: 50 }); // 오발한 사람은 다시 못 쏜다
    handleMessage(b, { type: "duShot", rt: 20 }); // 100ms 밑은 100으로
    assert(r.du.shots[B.id] === DU_MIN && !(C.id in r.du.shots));
    r.du.fired = Date.now() - 30; // 서버 기준 30ms만 지났으면 rt가 커도 30 → 하한 100으로
    handleMessage(a, { type: "duShot", rt: 5000 });
    assert(r.phase === "result" && r.du.shots[A.id] === DU_MIN, "전원 쏘면 바로 끝");
    assert(r.result.winners.length === 2 && A.money === 900 + Math.floor(300 * DU_EDGE / 2) && B.money === A.money && C.money === 900, "하한에 걸리면 동점 → 나눔");
    clearTimeout(r.timer);
    duNext(r);
    for (const w of [a, b]) { handleMessage(w, { type: "duJoin", v: true }); handleMessage(w, { type: "ready", v: true }); }
    handleMessage(c, { type: "ready", v: true }); // C는 구경
    assert(r.phase === "duWait" && r.du.order.length === 2);
    clearTimeout(r.timer); r.du.fakeTimers.forEach(clearTimeout);
    duFire(r); duEnd(r); // 아무도 안 쐈다 → 둘이 나눈다
    assert(r.result.winners.length === 2 && A.money === 1042 - 100 + Math.floor(200 * DU_EDGE / 2));
    clearTimeout(r.timer);
    delete process.env.GAME;
    rooms.delete(r.code);
  }

  { // 블라인드 스톱워치: 오차 제일 작은 사람 독식, 클라 시간은 서버 경과로 자름, 멈춘 시각은 결과 전까지 안 샌다, 2배 넘기면 실격
    process.env.GAME = "stopwatch";
    const [a, b, c] = [wgFake(), wgFake(), wgFake()];
    handleMessage(a, { type: "create", name: "SA" });
    for (const w of [b, c]) handleMessage(w, { type: "join", id: a.room.code, name: "S" });
    handleMessage(a, { type: "start" });
    const r = a.room, [A, B, C] = [a, b, c].map((w) => r.players.get(w));
    assert(r.game === "stopwatch" && r.cap === 100);
    handleMessage(a, { type: "bet", i: 0, amount: 10 });
    assert(!A.bets[0], "스톱워치는 칩 베팅을 안 받는다");
    for (const w of [a, b, c]) { handleMessage(w, { type: "swJoin", v: true }); handleMessage(w, { type: "ready", v: true }); }
    assert(r.phase === "swReady" && r.sw.pot === 300 && A.money === 900 && r.sw.target >= 5 && r.sw.target <= 12);
    handleMessage(a, { type: "swStop", t: 1 }); // 출발 전엔 무시
    assert(!(A.id in r.sw.stops));
    clearTimeout(r.timer);
    r.sw.target = 8;
    swGo(r);
    assert([a, b, c].every((w) => w.log.some((d) => d.includes('"swGo"'))));
    r.sw.t0 -= 10000; // 10초 지났다고 치고
    handleMessage(a, { type: "swStop", t: 7.9 }); // 오차 0.1
    handleMessage(b, { type: "swStop", t: 99 }); // 서버 경과 10초로 잘림 → 오차 2
    assert(r.sw.stops[B.id] === 10 && r.phase === "swRun");
    assert(![a, b, c].some((w) => w.log.some((d) => d.includes('"stops"'))), "멈춘 시각은 결과 전까지 안 나간다");
    handleMessage(a, { type: "swStop", t: 8 }); // 두 번은 못 누른다
    handleMessage(c, { type: "swStop", t: 8.1 }); // 오차 0.1 → A와 동점
    assert(r.phase === "result" && r.result.winners.length === 2 && !r.result.perfect, "전원 누르면 바로 끝, 동점은 나눔");
    assert(A.money === 900 + Math.floor(300 * SW_EDGE / 2) && C.money === A.money && B.money === 900);
    clearTimeout(r.timer);
    swNext(r);
    for (const w of [a, b]) { handleMessage(w, { type: "swJoin", v: true }); handleMessage(w, { type: "ready", v: true }); }
    handleMessage(c, { type: "ready", v: true }); // C는 구경
    assert(r.phase === "swReady" && r.sw.order.length === 2);
    clearTimeout(r.timer); r.sw.target = 6; swGo(r);
    r.sw.t0 -= 6000;
    handleMessage(b, { type: "swStop", t: 6.03 }); // 퍼펙트
    swEnd(r); // A는 끝까지 안 눌렀다 → 실격
    assert(r.result.winners[0] === B.id && r.result.perfect && !(A.id in r.result.err) && B.money === 900 - 100 + Math.floor(200 * SW_EDGE));
    clearTimeout(r.timer);
    delete process.env.GAME;
    rooms.delete(r.code);
  }

  { // 총알 피하기: 70/30 분배, 동시 탈락·다수 생존은 몫을 합쳐 나눔, 늦은 사망 보고는 경과 시간으로 자름, 📴은 그 시각에 사망
    assert(JSON.stringify(dgSplit({ a: 5000, b: 3000, c: 1000 }, 300)) === JSON.stringify({ a: 210, b: 90, c: 0 }));
    const s1 = dgSplit({ a: 5000, b: 3050, c: 3020 }, 300); // b·c 같은 틱 → 2위 몫 30%를 둘이 나눔
    assert(s1.a === 210 && s1.b === 45 && s1.c === 45);
    const s2 = dgSplit({ a: DG_LEN, b: DG_LEN, c: 100 }, 300); // 둘 다 생존 → 1·2위 몫을 합쳐 반씩
    assert(s2.a === 150 && s2.b === 150 && s2.c === 0);
    const s3 = dgSplit({ a: 900, b: 900, c: 900 }, 300); // 전원 같은 틱 → 100%를 셋이
    assert(s3.a === 100 && s3.b === 100 && s3.c === 100);
    process.env.GAME = "dodge";
    const [a, b, c] = [wgFake(), wgFake(), wgFake()];
    handleMessage(a, { type: "create", name: "GA" });
    for (const w of [b, c]) handleMessage(w, { type: "join", id: a.room.code, name: "G" });
    handleMessage(a, { type: "start" });
    const r = a.room, [A, B, C] = [a, b, c].map((w) => r.players.get(w));
    assert(r.game === "dodge" && r.cap === 100);
    handleMessage(a, { type: "bet", i: 0, amount: 10 });
    assert(!A.bets[0], "칩 베팅은 안 받는다");
    for (const w of [a, b, c]) { handleMessage(w, { type: "dgJoin", v: true }); handleMessage(w, { type: "ready", v: true }); }
    assert(r.phase === "dgPlay" && r.dg.pot === 300 && A.money === 900 && Number.isInteger(r.dg.seed));
    assert(a.log.some((d) => d.includes('"seed"')), "시드는 모두에게 간다");
    r.dg.t0 = Date.now() - 20000; // 시작 후 20초 지났다고 치고
    handleMessage(b, { type: "dgPos", x: 999, y: 50 });
    assert(r.dg.pos[B.id][0] === DG_A && c.log.at(-1).includes('"dgPos"') && !b.log.at(-1).includes('"dgPos"'), "위치는 잘라서 남에게만 중계");
    handleMessage(c, { type: "dgDie", t: 999999 }); // 경과 시간보다 늦은 보고 → 자른다
    assert(r.dg.dead[C.id] >= 20000 && r.dg.dead[C.id] < 21000);
    handleMessage(c, { type: "dgDie", t: 5 }); // 두 번은 안 받는다
    assert(r.dg.dead[C.id] >= 20000);
    r.dg.dead[C.id] = 12000;
    b.rcToken = "tok-dodge-b"; rcAway(b); // 📴 → 지금 시각에 사망 → 1명 남음
    assert(r.dg.dead[B.id] >= 20000 && r.dg.ending && r.phase === "dgPlay");
    clearTimeout(r.timer); clearInterval(b.rcTimer);
    dgEnd(r);
    assert(r.phase === "result" && r.result.top[0] === A.id && A.money === 900 + 210 && B.money === 900 + 90 && C.money === 900, "1위 70% · 2위 30%");
    clearTimeout(r.timer);
    delete process.env.GAME;
    rooms.delete(r.code);
  }

  // 풍선 불기: crash 분포(P(crash ≥ m) = 0.95/m) + 짜고 친 한 판 (A는 x1.5에 놓고, B는 쥐고 있다가 x2.5에서 펑) + crash가 미리 새지 않는지
  let blGe2 = 0, blGe10 = 0;
  for (let i = 0; i < 200000; i++) { const c = blCrash(); assert(c >= 1 && c <= BL_MAX); if (c >= 2) blGe2++; if (c >= 10) blGe10++; }
  console.log("풍선 P(crash≥x2)", (blGe2 / 2000).toFixed(1) + "%", "P(crash≥x10)", (blGe10 / 2000).toFixed(1) + "%");
  assert(Math.abs(blGe2 / 200000 - 0.475) < 0.01 && Math.abs(blGe10 / 200000 - 0.095) < 0.005, "풍선 crash 분포가 어긋남");
  assert(blWin(100, 1.15) === 115 && blWin(37, 1.5) === 55 && blWin(100, 0) === 0);
  process.env.GAME = "balloon";
  const blSent = [], fb = () => ({ id: crypto.randomUUID(), room: null, readyState: 1, OPEN: 1, send(d) { blSent.push(d); } }); // 보낸 걸 전부 기록
  const b1 = fb(), b2 = fb(), b3 = fb();
  handleMessage(b1, { type: "create", name: "L1" });
  handleMessage(b2, { type: "join", id: b1.room.code, name: "L2" });
  handleMessage(b3, { type: "join", id: b1.room.code, name: "L3" }); // 안 걸고 구경
  handleMessage(b1, { type: "start" });
  const lr = b1.room, L1 = lr.players.get(b1), L2 = lr.players.get(b2), L3 = lr.players.get(b3);
  assert(lr.game === "balloon" && lr.cap === 100 && lr.bl.round === 1);
  handleMessage(b1, { type: "bet", i: 0, amount: 999 });
  handleMessage(b2, { type: "bet", i: 0, amount: 50 });
  handleMessage(b1, { type: "blAct" }); // 베팅 중엔 무효
  for (const w of [b1, b2, b3]) handleMessage(w, { type: "ready", v: true });
  assert(lr.phase === "blCount" && lr.bl.hidden >= 1 && L1.bets[0] === 100 && !Object.keys(lr.bl.cash).length);
  clearTimeout(lr.timer);
  blFly(lr);
  clearTimeout(lr.timer);
  lr.bl.hidden = 2.5;
  lr.bl.t0 = Date.now() - blTime(1.505); // m(t) = x1.50대인 시점
  handleMessage(b1, { type: "blAct" });
  handleMessage(b1, { type: "blAct" }); // 두 번은 못 놓는다
  handleMessage(b3, { type: "blAct" }); // 구경꾼은 놓을 게 없다
  assert(lr.bl.cash[L1.id] === 1.5 && Object.keys(lr.bl.cash).length === 1 && lr.bl.crash === null && lr.phase === "blFly");
  assert(blSent.length > 10 && blSent.every((d) => !d.includes("hidden") && !d.includes("2.5")), "터지기 전엔 crash가 브로드캐스트에 없어야 한다");
  lr.bl.t0 = Date.now() - blTime(2.6); // 타이머가 밀려 아직 안 터졌지만 이미 crash를 지난 시각 → 무효
  handleMessage(b2, { type: "blAct" });
  blPop(lr);
  clearTimeout(lr.timer);
  handleMessage(b2, { type: "blAct" }); // 터진 뒤 놓기도 무효
  assert(lr.phase === "blPop" && lr.bl.crash === 2.5 && !(L2.id in lr.bl.cash) && blSent[blSent.length - 1].includes('"crash":2.5'));
  assert(L1.money === 900, "돈은 펑 연출이 끝난 뒤(blSettle)에 움직인다");
  blSettle(lr);
  clearTimeout(lr.timer);
  assert(L1.money === 900 + 150 && L2.money === 950 && L3.money === START_MONEY, "x1.5에 놓으면 floor(100 × 1.5), 못 놓으면 0");
  assert.deepStrictEqual(lr.result, { crash: 2.5, cashouts: { [L1.id]: 1.5 }, payouts: { [L1.id]: { bet: 100, win: 150 }, [L2.id]: { bet: 50, win: 0 } }, last: null }); // 놓은 사람이 1명이면 최후의 1인 없음
  { // 👑 최후의 1인: L1 x1.5, L2 x3 → L2가 L1 수익(50)의 5% = 2를 떼 간다
    const m1 = L1.money, m2 = L2.money;
    Object.assign(lr.bl, { cash: { [L1.id]: 1.5, [L2.id]: 3 }, crash: 4 }); L1.bets = { 0: 100 }; L2.bets = { 0: 100 };
    blSettle(lr); clearTimeout(lr.timer);
    assert(L1.money === m1 + 148 && L2.money === m2 + 302 && lr.result.last.id === L2.id && lr.result.last.bonus === 2, "최후의 1인 보너스");
    L1.money = m1; L2.money = m2;
  }
  lr.phase = "betting"; // 다음 판: 아무도 안 걸면 쥔 사람이 없으니 바로 crash를 공개하고 빨리 감는다
  blStart(lr);
  assert(lr.bl.crash === null && !Object.keys(lr.bl.cash).length);
  clearTimeout(lr.timer);
  blFly(lr);
  assert(lr.phase === "blFly" && lr.bl.crash === lr.bl.hidden);
  lr.bl.hidden = lr.bl.crash = BL_MAX; // 상한까지 버틴 사람은 자동 회수
  L2.bets = { 0: 10 };
  clearTimeout(lr.timer);
  blPop(lr);
  clearTimeout(lr.timer);
  assert(lr.bl.cash[L2.id] === BL_MAX && blWin(10, BL_MAX) === 10 * BL_MAX);
  delete process.env.GAME;
  rooms.delete(lr.code);

  // 도박 코인 단타: 이벤트 평균 0 + 끝까지 들고 있어도 기댓값은 제자리(드리프트 0), 그리고 가격을 정해 놓은 한 판
  assert(Math.abs(CN_EVENTS.reduce((a, e) => a + (e[1] + e[2]) / 2, 0)) < 1e-9, "코인 이벤트 평균이 0이 아님");
  assert(Math.abs(CN_BIG.reduce((a, e) => a + e[1] * e[2], 0)) < 0.01 && Math.abs(CN_BIG[0][2] + CN_BIG[1][2] - 1) < 1e-9, "코인 초대형 이벤트 평균이 0이 아님");
  let cnSum = 0;
  for (let i = 0; i < 20000; i++) { let v = 100; for (let t = 0; t < CN_TICKS; t++) v = cnNext(v)[0]; cnSum += v; }
  console.log("코인 평균 마감가", (cnSum / 20000).toFixed(1), "(시작가 100) | 환급률 1회 왕복", ((1 - CN_FEE) ** 2 * 100).toFixed(1) + "%, 2회", ((1 - CN_FEE) ** 4 * 100).toFixed(1) + "%");
  assert(Math.abs(cnSum / 20000 - 100) < 4, "코인 가격에 드리프트가 있음");
  process.env.GAME = "coin";
  const fc = () => { const w = { id: crypto.randomUUID(), room: null, readyState: 1, OPEN: 1, sent: [], send(d) { w.sent.push(JSON.parse(d)); } }; return w; }; // 받은 메시지를 기록하는 가짜 ws
  const c1 = fc(), c2 = fc();
  handleMessage(c1, { type: "create", name: "C1" });
  handleMessage(c2, { type: "join", id: c1.room.code, name: "C2" });
  handleMessage(c1, { type: "start" });
  const cr = c1.room, C1 = cr.players.get(c1), C2 = cr.players.get(c2);
  assert(cr.game === "coin" && cr.cap === 200 && cr.cn.prices.length === 1);
  handleMessage(c1, { type: "bet", i: 0, amount: 100 });
  handleMessage(c2, { type: "bet", i: 0, amount: 50 });
  handleMessage(c1, { type: "ready", v: true });
  handleMessage(c2, { type: "ready", v: true });
  assert(cr.phase === "cnMarket" && C1.cn.cash === 100 && !C1.cn.coins && C1.money === 900, "전원 현금으로 시작");
  clearTimeout(cr.timer);
  cnTick(cr); // 틱 한 번 = 가격 하나. 메시지에는 현재가뿐이고 그 뒤의 가격은 서버에도 아직 없다
  clearTimeout(cr.timer);
  const tk = c2.sent[c2.sent.length - 1];
  assert(tk.type === "cnTick" && tk.t === 1 && tk.price === cr.cn.prices[1] && cr.cn.prices.length === 2);
  assert(Object.keys(tk).every((k) => ["type", "t", "price", "news"].includes(k)) && !JSON.stringify(tk).includes("prices"), "cnTick에 미래 가격이 실려 있음");
  cr.cn.prices[1] = 100; // 여기서부터는 가격을 직접 정한다: 100에 사서 200에 판다
  handleMessage(c1, { type: "cnAct", a: "buy" });
  handleMessage(c1, { type: "cnAct", a: "sell" }); // 연타는 무시 (0.3초 제한)
  handleMessage(c2, { type: "cnAct", a: "sell" }); // 가진 코인이 없으면 무시
  handleMessage(c2, { type: "cnAct", a: "buy" });
  assert(C1.cn.coins > 0 && C1.cn.cash === 0 && !cr.cn.trades[C1.id][1] && cr.cn.trades[C2.id].length === 1);
  cr.cn.prices.push(200);
  C1.cn.last = 0;
  handleMessage(c1, { type: "cnAct", a: "sell" });
  assert(!C1.cn.coins && C1.money === 900, "돈은 장 마감 뒤에 움직인다");
  cnClose(cr); // C2는 들고 있다가 마감가 200에 강제 매도
  clearTimeout(cr.timer);
  assert(cr.phase === "cnClose" && !C2.cn.coins && cr.cn.trades[C2.id][1].forced && cr.cn.trades[C2.id][1].price === 200);
  cnSettle(cr);
  clearTimeout(cr.timer);
  assert(C1.money === 900 + Math.floor(100 * 0.985 * 2 * 0.985) && cr.result.payouts[C1.id].win === 194, "100에 사서 200에 팔면 $194 (수수료 1.5% 두 번)");
  assert(C2.money === 950 + Math.floor(50 * 0.985 * 2 * 0.985) && cr.result.prices.length === 3 && cr.result.trades[C1.id].length === 2);
  rooms.delete(cr.code);
  const c3 = fc(); // 방이 사라지면(마지막 사람 퇴장) 틱도 멈춘다
  handleMessage(c3, { type: "create", name: "C3" });
  handleMessage(c3, { type: "start" });
  handleMessage(c3, { type: "bet", i: 0, amount: 10 });
  handleMessage(c3, { type: "ready", v: true });
  const cr3 = c3.room;
  assert(cr3.phase === "cnMarket" && !cr3.timer._destroyed);
  handleMessage(c3, { type: "leave" });
  assert(!rooms.has(cr3.code) && cr3.timer._destroyed, "빈 방의 틱 타이머가 살아 있음"); // _destroyed = clearTimeout된 Timeout (Node 내부 필드)
  delete process.env.GAME;

  // 플링코: 칸→구역, 구역별 경우의 수(C(10,k)의 합)·배당·기대 환급률 + 짜고 떨어뜨린 한 판
  // (최외곽에 걸고 전부 오른쪽 → 10번 칸 적중 x8.69 / 중앙(기본)에 걸고 5번 칸 적중 x1.45 / 외곽에 걸었는데 5번 칸 → 꽝)
  assert.deepStrictEqual(PK_ZONE_OF, [2, 2, 2, 1, 0, 0, 0, 1, 2, 2, 2]);
  assert.deepStrictEqual(PK_WAYS, [672, 240, 112]);
  assert(PK_WAYS.reduce((a, b) => a + b) === 2 ** PK_ROWS, "구역이 모든 칸을 빠짐없이 덮어야 함");
  PK_ODDS.forEach((o, z) => assert(Math.abs((o * PK_WAYS[z]) / 2 ** PK_ROWS - PK_EDGE) <= 0.01, "플링코 " + z + "번 구역 환급률이 어긋남"));
  for (const j of PK_JACKS) { // 잭팟 칸이 어디든 최외곽 환급률 ≤ 95%
    const K = pkJack({}); K.jack = j; const w = pkC(PK_ROWS, j);
    K.odds[2] = Math.floor(((PK_EDGE * 2 ** PK_ROWS - MAX_MULT * w) / (PK_WAYS[2] - w)) * 100) / 100;
    const rtp = (K.odds[2] * (PK_WAYS[2] - w) + MAX_MULT * w) / 2 ** PK_ROWS;
    assert(rtp <= PK_EDGE && rtp > PK_EDGE - 0.01 && K.odds[2] > PK_ODDS[1], "플링코 잭팟 칸 " + j + " 환급률 " + rtp);
  }
  console.log("플링코 배당", PK_ODDS.map((o, z) => ["중앙", "외곽", "최외곽"][z] + " " + ((PK_WAYS[z] / 2 ** PK_ROWS) * 100).toFixed(1) + "%→x" + o).join(" "));
  process.env.GAME = "plinko";
  const pkFake = () => ({ id: crypto.randomUUID(), room: null, readyState: 0, OPEN: 1, send() {} });
  const pk1 = pkFake(), pk2 = pkFake(), pk3 = pkFake();
  handleMessage(pk1, { type: "create", name: "K1" });
  handleMessage(pk2, { type: "join", id: pk1.room.code, name: "K2" });
  handleMessage(pk3, { type: "join", id: pk1.room.code, name: "K3" });
  handleMessage(pk1, { type: "start" });
  const pkr = pk1.room, PK1 = pkr.players.get(pk1), PK2 = pkr.players.get(pk2), PK3 = pkr.players.get(pk3);
  assert(pkr.game === "plinko" && pkr.cap === 100 && pkr.pk.odds.length === 3 && pkr.pk.zoneOf.length === PK_ROWS + 1);
  handleMessage(pk1, { type: "pkZone", v: 2 });
  handleMessage(pk1, { type: "pkZone", v: 3 });   // 없는 구역
  handleMessage(pk1, { type: "pkZone", v: "0" }); // 문자열도 무시
  handleMessage(pk3, { type: "pkZone", v: 1 });
  handleMessage(pk1, { type: "bet", i: 0, amount: 999 });
  handleMessage(pk2, { type: "bet", i: 0, amount: 50 });
  handleMessage(pk3, { type: "bet", i: 0, amount: 50 });
  handleMessage(pk2, { type: "ready", v: true });
  handleMessage(pk2, { type: "pkZone", v: 2 });   // 준비하면 잠김 → 기본(중앙) 그대로
  assert(PK1.pkZone === 2 && PK2.pkZone === undefined && PK1.bets[0] === 100 && PK1.money === 900);
  handleMessage(pk3, { type: "ready", v: true });
  handleMessage(pk1, { type: "ready", v: true });
  assert(pkr.phase === "pkDrop" && pkr.pk.drops.length === 3 && pkr.pk.drops.every((d) => d.path.length === PK_ROWS && d.path.every((v) => v === 0 || v === 1)));
  assert.deepStrictEqual(pkr.pk.drops.map((d) => d.zone), [2, 0, 1]);
  handleMessage(pk1, { type: "pkZone", v: 0 });   // 공이 떨어지는 중에도 무시
  assert(PK1.pkZone === 2);
  clearTimeout(pkr.timer);
  Object.assign(pkr.pk, { jack: 10, odds: PK_ODDS.slice() }); // 잭팟 칸 = 10번으로 고정
  pkr.pk.drops[0].path = Array(PK_ROWS).fill(1); // 전부 오른쪽 → 10번 칸(최외곽 + 잭팟)
  pkr.pk.drops[1].path = pkr.pk.drops[2].path = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]; // 5번 칸(중앙)
  pkSettle(pkr);
  clearTimeout(pkr.timer);
  assert(pkr.phase === "result" && pkr.result.bins[PK1.id] === 10 && pkr.result.zones[PK3.id] === 1 && pkr.result.mults[PK3.id] === 0);
  assert(PK1.money === 900 + 1500 && PK2.money === 950 + 72 && PK3.money === 950 && pkr.result.payouts[PK1.id].win === 1500 && !PK1.bets[0], "잭팟 칸 $100×15, 중앙 적중 $50×1.45(내림), 빗나가면 0");
  delete process.env.GAME;
  rooms.delete(pkr.code);

  // 주사위: 경우의 수·배당·기대 환급률, 그리고 짜고 굴린 한 판
  assert.deepStrictEqual(DICE_BETS.slice(0, 5).map((b) => b.ways), [18, 18, 15, 15, 6]);
  assert.deepStrictEqual(DICE_BETS.slice(5).map((b) => b.ways), [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]);
  for (const b of DICE_BETS) assert(b.odds === MAX_MULT ? b.odds * b.ways / 36 < DICE_EDGE : Math.abs(b.odds * b.ways / 36 - DICE_EDGE) < 0.02, b.key + " 환급률이 어긋남");
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
  handleMessage(w1, { type: "bet", i: 0, amount: 1500 });
  assert(P1.bets[0] === 1000 && P1.money === 0 && br.free, "블랙잭은 상한 없음 — 가진 돈까지 올인");
  handleMessage(w1, { type: "clear" });
  handleMessage(w1, { type: "bet", i: 0, amount: 100 });
  handleMessage(w2, { type: "bet", i: 0, amount: 50 });
  assert(P1.bets[0] === 100 && P1.money === 900);
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

  // 게임 투표: 없는 칸은 무시, 다 누르기 전엔 바꿀 수 있고 추첨도 안 돌고, 마지막 사람이 누르는 순간 추첨. 전원이 같은 칸이면 100% 그게 뽑힌다
  delete process.env.GAME;
  const v1 = fake(), v2 = fake();
  handleMessage(v1, { type: "create", name: "V1" });
  handleMessage(v2, { type: "join", id: v1.room.code, name: "V2" });
  handleMessage(v1, { type: "start" });
  const vr = v1.room;
  assert(vr.phase === "vote" && vr.day === 0 && new Set(vr.vote.options).size === 3);
  handleMessage(v1, { type: "vote", i: 4 });
  handleMessage(v1, { type: "vote", i: 0 });
  handleMessage(v1, { type: "vote", i: 2 }); // 바꿔 누르기
  handleMessage(v1, { type: "ready", v: true }); // 준비 버튼은 이제 없다
  assert(vr.vote.pick === null && !vr.timer, "한 명이라도 안 눌렀으면 안 돌아간다 (타이머도 없음)");
  handleMessage(v2, { type: "vote", i: 2 });
  assert.deepStrictEqual(voteCounts(vr), [0, 0, 2, 0]);
  handleMessage(v2, { type: "vote", i: 0 }); // 추첨이 시작되면 못 바꾼다
  const voted = vr.vote.options[2];
  assert(vr.vote.pick === 2 && vr.vote.game === voted && [v1.id, v2.id].includes(vr.vote.voter));
  clearTimeout(vr.timer);
  startDay(vr, voted);
  assert(vr.phase === "betting" && vr.day === 1 && vr.game === voted && !vr.vote);

  // 진행 일수: 대기실에서 방장만 정하고(시작도 방장만), 시작하면 못 바꾸고, 그 날수가 지나면 끝난다
  const h1 = fake(), h2 = fake();
  handleMessage(h1, { type: "create", name: "H1" });
  handleMessage(h2, { type: "join", id: h1.room.code, name: "H2" });
  const hr = h1.room, nextNight = () => { clearTimeout(hr.timer); startNight(hr); handleMessage(h1, { type: "ready", v: true }); handleMessage(h2, { type: "ready", v: true }); };
  handleMessage(h2, { type: "days", n: 3 });  // 방장 아님
  handleMessage(h1, { type: "days", n: 0 });  // 범위 밖
  handleMessage(h1, { type: "days", n: 2.5 });
  handleMessage(h2, { type: "start" });       // 방장 아님
  assert(hr.days === DAYS && hr.phase === "lobby");
  handleMessage(h1, { type: "days", n: 2 });
  process.env.GAME = "dice";
  handleMessage(h1, { type: "start" });
  handleMessage(h1, { type: "days", n: 5 });  // 시작 후엔 무시
  assert(hr.days === 2 && hr.day === 1);
  nextNight();
  assert(hr.day === 2 && hr.phase === "betting");
  nextNight();
  assert(hr.phase === "final", "2일 뒤엔 끝");
  delete process.env.GAME;

  // 재접속: 진짜 connection 핸들러에 가짜 ws를 물린다(close 순서까지 그대로). 끊김 → 📴 자리 유지·자동 준비 → 새 연결로 복귀
  //   → 다른 탭이 같은 토큰으로 붙으면 옛 탭은 끊김 → 블랙잭 도중 📴면 자동 스탠드 → 명시적 퇴장 후 재입장은 스냅샷 복원 → 전원 📴 2분이면 방 삭제
  process.env.GAME = "blackjack";
  const wire = [], tokA = crypto.randomUUID(), tokB = crypto.randomUUID();
  const conn = (tok) => {
    const w = Object.assign(new (require("events"))(), { readyState: 1, OPEN: 1, got: [], ping() {},
      send(d) { wire.push(d); w.got.push(JSON.parse(d)); }, close() { if (w.readyState === 3) return; w.readyState = 3; w.emit("close"); } });
    wss.emit("connection", w);
    w.say = (m) => w.emit("message", JSON.stringify(m));
    w.say({ type: "rcHello", token: tok });
    return w;
  };
  const ra = conn(tokA), rb = conn(tokB);
  assert(ra.got.at(-1).type === "rcFail" && !ra.room, "처음 보는 토큰은 복귀 실패 → 타이틀");
  ra.say({ type: "create", name: "RA" });
  const rr = ra.room, RA = rr.players.get(ra);
  rb.say({ type: "join", id: rr.code, name: "RB" });
  const RB = rr.players.get(rb), bid = RB.id;
  ra.say({ type: "start" });
  ra.say({ type: "bet", i: 0, amount: 100 });
  rb.say({ type: "bet", i: 0, amount: 50 });
  rr.bj.deck = ["K2", "70", "91", "63", "50", "62", "K0"]; // 딜러 K0,62 / A 50,63 / B 91,70 → 둘 다 고민 중
  rb.close();
  assert(RB.rcAway && RB.ready && rr.players.size === 2 && rr.players.get(rb) === RB && !rb.room, "끊겨도 자리·베팅 유지 + 자동 준비");
  ra.say({ type: "ready", v: true });
  assert(rr.phase === "playing" && RB.bj.state !== "out", "📴인 B 때문에 판이 안 멈춘다");
  const rb2 = conn(tokB);
  assert(rb2.room === rr && rb2.id === bid && rr.players.get(rb2) === RB && !RB.rcAway && RB.money === 950 && RB.bets[0] === 50, "같은 자리·돈·베팅으로 복귀");
  assert(rb2.got.some((m) => m.type === "joined" && m.playerId === bid) && [...rr.players.keys()][1] === rb2, "Map 순서 유지");
  ra.close();
  const ra2 = conn(tokA); // 방장이 새로고침해도 방장 그대로
  assert([...rr.players.keys()][0] === ra2 && hostOf(rr) === RA && !RA.rcAway, "방장 자리 유지");
  const rb3 = conn(tokB); // 다른 탭
  assert(rb2.readyState === 3 && rb2.got.at(-1).type === "rcKicked" && rr.players.get(rb3) === RB && !RB.rcAway && rr.players.size === 2, "옛 탭은 끊고 새 탭으로");
  rb3.close();
  assert(RB.rcAway && RB.bj.state === "playing");
  rb3.rcTimer._onTimeout(); // RC_AUTO 콜백을 직접 부른다
  assert(RB.bj.state === "stand", "📴면 자동 스탠드");
  ra2.say({ type: "bj", a: "stand" });
  while (rr.phase === "playing") { clearTimeout(rr.timer); bjDealerStep(rr); }
  clearTimeout(rr.timer);
  const rb4 = conn(tokB);
  RB.money = 0; RB.history[1] = 123; // 파산한 채로 나갔다 들어오기
  rb4.say({ type: "leave" });
  assert(rr.players.size === 1 && !rb4.room && !rcTokens.has(tokB));
  const rb5 = conn(tokB); // 새로고침 = 새 연결
  assert(rb5.got.at(-1).type === "rcFail");
  rb5.say({ type: "join", id: rr.code, name: "RB" });
  const RB2 = rr.players.get(rb5);
  assert(RB2 !== RB && RB2.money === 0 && RB2.history[1] === 123 && RB2.color === RB.color, "나갔다 오면 $" + START_MONEY + "이 아니라 그때 돈·기록");
  for (const tok of [tokA, tokB]) assert(!wire.some((d) => d.includes(tok)), "토큰은 어떤 메시지에도 안 나간다");
  ra2.close(); rb5.close();
  assert(rooms.has(rr.code) && rr.rcEmpty, "전원 📴 → 2분 타이머");
  rr.rcEmpty._onTimeout();
  assert(!rooms.has(rr.code) && !rcTokens.has(tokA), "2분 지나면 방 삭제");
  for (const w of rr.players.keys()) clearInterval(w.rcTimer);
  const la = conn(crypto.randomUUID()), lb = conn(crypto.randomUUID()); // 대기실에서 방장이 📴면 다음 사람이 방장
  la.say({ type: "create", name: "LA" });
  lb.say({ type: "join", id: la.room.code, name: "LB" });
  const rcLr = la.room;
  la.close();
  assert(hostOf(rcLr) === rcLr.players.get(lb) && rcLr.players.size === 2);
  lb.say({ type: "leave" });
  clearTimeout(rcLr.rcEmpty); rcDrop(rcLr);
  assert(!rooms.has(rcLr.code), "남은 사람이 전부 📴면 그 방도 치운다");
  { // 머지 연결: 새 게임의 📴 자동 처리·복귀 재전송 + 나갔다 와도 빚이 안 사라짐
    process.env.GAME = "indian";
    const tA = crypto.randomUUID(), tB = crypto.randomUUID(), ia = conn(tA), ib = conn(tB);
    ia.say({ type: "create", name: "IA" });
    const ir = ia.room;
    ib.say({ type: "join", id: ir.code, name: "IB" });
    ia.say({ type: "start" });
    for (const w of [ia, ib]) { w.say({ type: "ipJoin", v: true }); w.say({ type: "ready", v: true }); }
    const IB = ir.players.get(ib);
    assert(ir.phase === "ipDecide");
    ib.close();
    const ib2 = conn(tB), cards = ib2.got.filter((m) => m.type === "ipCards").at(-1);
    assert(cards && !(IB.id in cards.cards) && Object.keys(cards.cards).length === 1, "복귀하면 남의 카드만 다시 받는다");
    ib2.close();
    ib2.rcTimer._onTimeout();
    assert(ir.ip.calls[IB.id] === false, "결정 전에 📴면 다이");
    clearTimeout(ir.timer); clearInterval(ib2.rcTimer);
    const ib3 = conn(tB);
    IB.lnDebt = 300;
    ib3.say({ type: "leave" });
    const ib4 = conn(tB);
    ib4.say({ type: "join", id: ir.code, name: "IB" });
    assert(ir.players.get(ib4).lnDebt === 300, "나갔다 와도 빚은 그대로");
    clearTimeout(ir.timer);
    for (const w of ir.players.keys()) clearInterval(w.rcTimer);
    rooms.delete(ir.code);
    delete process.env.GAME;
  }

  { // 블록으로 묶어서 다른 셀프 체크의 변수 이름과 안 부딪히게
  // 사채: 밤에만 · 한도 $1000 · 빌린 밤은 무이자 → 다음 밤 20% → 그다음 밤 복리 · 갚기(부분/전액/돈 부족) · 파산자가 빌리면 탄광 안 감 · 최종 순위는 순자산
  const lf = () => ({ id: crypto.randomUUID(), room: null, readyState: 1, OPEN: 1, log: [], send(d) { this.log.push(d); } });
  const l1 = lf(), l2 = lf();
  handleMessage(l1, { type: "create", name: "L1" });
  handleMessage(l2, { type: "join", id: l1.room.code, name: "L2" });
  const lr = l1.room, L1 = lr.players.get(l1), L2 = lr.players.get(l2), lnReady = () => { handleMessage(l1, { type: "ready", v: true }); handleMessage(l2, { type: "ready", v: true }); };
  handleMessage(l1, { type: "days", n: 3 });
  process.env.GAME = "dice";
  handleMessage(l1, { type: "start" });
  handleMessage(l1, { type: "lnAct", a: "borrow" });
  assert(!L1.lnDebt && L1.money === START_MONEY, "밤이 아니면 무시");
  L1.money = 0; L2.money = 900; // 1일차: L1 파산
  clearTimeout(lr.timer); startNight(lr);
  for (let k = 0; k < 3; k++) handleMessage(l1, { type: "lnAct", a: "borrow" });
  handleMessage(l1, { type: "lnAct", a: "steal" });
  assert(L1.lnDebt === 300 && L1.money === 300 && !lr.night[L1.id].lnInt && L1.history[1] === 0, "빌린 밤엔 이자 없음, 순자산 그대로");
  lnReady();
  assert(lr.day === 2 && !L1.mining, "파산자가 사채를 쓰면 탄광에 안 간다");
  clearTimeout(lr.timer); startNight(lr);
  assert(L1.lnDebt === 360 && lr.night[L1.id].lnInt === 60 && L1.history[2] === 300 - 360, "다음 밤 20%");
  for (let k = 0; k < 9; k++) handleMessage(l1, { type: "lnAct", a: "borrow" });
  assert(L1.lnDebt === 960 && L1.money === 900, "빚 $1000을 넘게는 못 빌림");
  lnReady();
  clearTimeout(lr.timer); startNight(lr); // 3일차(마지막) 밤
  assert(L1.lnDebt === 960 + 192 && lr.night[L1.id].lnInt === 192, "복리");
  handleMessage(l1, { type: "lnAct", a: "repay" });
  assert(L1.lnDebt === 1052 && L1.money === 800, "$100 갚기");
  L1.money = 30;
  handleMessage(l1, { type: "lnAct", a: "repayAll" });
  assert(L1.lnDebt === 1022 && L1.money === 0, "돈이 모자라면 가진 만큼만");
  L1.money = 1100;
  handleMessage(l1, { type: "lnAct", a: "repayAll" });
  assert(L1.lnDebt === 0 && L1.money === 78, "전액 갚기");
  handleMessage(l1, { type: "lnAct", a: "borrow" }); handleMessage(l1, { type: "lnAct", a: "borrow" }); // 마지막 밤: 현금 $278 / 빚 $200 → 순자산 $78 < L2 $900
  lnReady();
  const lastChat = JSON.parse(l1.log.filter((d) => d.includes('"chat"')).pop()).text;
  assert(lr.phase === "final" && lastChat.includes("L2 ($900)"), "최종 우승은 순자산 기준: " + lastChat);
  handleMessage(l1, { type: "again" });
  assert(L1.lnDebt === 0 && L1.money === START_MONEY, "새 게임이면 빚 탕감");
  delete process.env.GAME;
  }
  // 탄광 미니게임: 파산 → 구걸 실패 → 탄광 → 곡괭이질(초당 8번까지, 친 사람에게만 응답) → 바위 파괴·전리품 → 밤 일당 = 기본 + 캔 돈 (최대 $1000) → 다음 날엔 못 캠
  const mf = () => ({ id: crypto.randomUUID(), room: null, readyState: 1, OPEN: 1, got: [], send(d) { this.got.push(JSON.parse(d)); } });
  const m1 = mf(), m2 = mf(), hit = (n = 1) => { for (let i = 0; i < n; i++) handleMessage(m1, { type: "mnHit" }); };
  handleMessage(m1, { type: "create", name: "M1" });
  handleMessage(m2, { type: "join", id: m1.room.code, name: "M2" });
  process.env.GAME = "dice";
  handleMessage(m1, { type: "start" });
  const mr = m1.room, M1 = mr.players.get(m1), M2 = mr.players.get(m2);
  hit();
  assert(!M1.mnRock, "탄광 아닌 사람의 곡괭이질은 무시");
  M1.money = M2.money = 0;
  clearTimeout(mr.timer); startNight(mr);
  hit();
  assert(!M1.mnRock, "밤엔 못 캔다");
  handleMessage(m1, { type: "beg", v: true });
  handleMessage(m2, { type: "beg", v: true }); // 둘 다 구걸만 하고 아무도 안 줌 → 둘 다 탄광행 (전원 탄광이라 바로 굴린다)
  clearTimeout(mr.timer);
  assert(M1.mining && M2.mining && mr.day === 2 && mr.phase === "rolling");
  const seen = m2.got.length;
  hit(9);
  assert(M1.mnRock.n === 0 && M1.mnRock.hp === 12 - 8, "초당 8번까지만");
  assert(m2.got.length === seen && m1.got.filter((m) => m.type === "mnHit").length === 8, "안 깨지는 타격은 친 사람에게만");
  m1.mnHits = []; // 1초 지난 셈
  Math.random = () => 0; // 전리품 = 돌, 최솟값
  hit(4);
  assert(M1.mnEarn === 1 && M1.mnRock.n === 1 && M1.mnRock.hp === 13, "12번째 타격에 첫 바위가 깨지고 돌 $1");
  assert.deepStrictEqual(m1.got.filter((m) => m.type === "mnHit").pop().loot, { k: "stone", v: 1 });
  assert(m2.got.slice(seen).some((m) => m.type === "room" && m.room.players.find((p) => p.id === M1.id).mnEarn === 1), "바위가 깨지면 모두에게 방송");
  M1.mnRock = mnRock(10); M1.mnRock.hp = 1; m1.mnHits = [];
  Math.random = () => 0.999; // 다이아 최댓값: (500 + 0.999 × 200) × 1.3 = $910 → 한도($900 - $1)까지만
  hit();
  assert(M1.mnEarn === MN_MAX - WAGE && M1.mnDia === 1);
  assert(m2.got.some((m) => m.type === "toast" && m.text === "💎 M1 다이아 발견! +$899") && m2.got.some((m) => m.sys && m.text.startsWith("💎 M1")));
  m1.mnHits = []; hit();
  assert(M1.mnRock.hp === M1.mnRock.max, "한도를 채우면 더 못 캔다");
  Math.random = realRandom;
  clearTimeout(mr.timer); startNight(mr);
  assert(M1.money === 1000 && M2.money === 100, "캔 사람은 한도 $1000, 안 캔 사람은 기본 $100");
  assert(mr.night[M1.id].wage === 1000 && mr.night[M1.id].mnDia === 1 && mr.night[M2.id].wage === 100 && !mr.night[M2.id].mnDia);
  assert(M1.mnEarn === 0 && !M1.mnRock && !M1.mining, "밤에 일당으로 바꾸면 초기화");
  handleMessage(m1, { type: "ready", v: true });
  handleMessage(m2, { type: "ready", v: true });
  m1.mnHits = []; hit();
  assert(mr.day === 3 && mr.phase === "betting" && !M1.mnRock, "탄광이 끝난 다음 날엔 못 캔다");
  delete process.env.GAME;
  rooms.delete(mr.code);

  // 이모티콘 리액션: 방 밖·없는 번호·연타(0.6초 안)는 무시, 통과하면 방 전원에게 {type, id, e}. 채팅으로는 안 나간다
  const emGot = [], emWs = () => ({ id: crypto.randomUUID(), room: null, readyState: 1, OPEN: 1, send(d) { emGot.push(JSON.parse(d)); } });
  const emA = emWs(), emB = emWs(), emOut = emWs();
  handleMessage(emOut, { type: "emReact", e: 0 }); // 방 밖
  handleMessage(emA, { type: "create", name: "EA" });
  handleMessage(emB, { type: "join", id: emA.room.code, name: "EB" });
  emGot.length = 0;
  for (const e of [-1, 8, 1.5, "2", null, undefined]) handleMessage(emA, { type: "emReact", e });
  handleMessage(emA, { type: "emReact", e: 3 });
  handleMessage(emA, { type: "emReact", e: 4 }); // 연타
  handleMessage(emB, { type: "emReact", e: 7 });
  emA.emLast -= 600; // 0.6초 지남
  handleMessage(emA, { type: "emReact", e: 0 });
  const emMsg = (id, e) => ({ type: "emReact", id, e });
  assert.deepStrictEqual(emGot, [emMsg(emA.id, 3), emMsg(emA.id, 3), emMsg(emB.id, 7), emMsg(emB.id, 7), emMsg(emA.id, 0), emMsg(emA.id, 0)], "이모티콘 검증/연타 제한/브로드캐스트");
  rooms.delete(emA.room.code);
  { // 시상식 칭호 (지역 변수가 다른 블록과 안 겹치게 따로 묶음)
    // 같은 결과는 한 번만 기록, 밤 이벤트 기록, 칭호 배정(혼자 딴 것부터·최대 2개·최소 1개), again 후 초기화
    process.env.GAME = "dice";
    const t1 = fake(), t2 = fake(), t3 = fake(), t4 = fake();
    handleMessage(t1, { type: "create", name: "T1" });
    handleMessage(t2, { type: "join", id: t1.room.code, name: "T2" });
    handleMessage(t3, { type: "join", id: t1.room.code, name: "T3" });
    handleMessage(t1, { type: "days", n: 1 });
    handleMessage(t1, { type: "start" });
    const tr = t1.room, [T1, T2, T3] = [t1, t2, t3].map((w) => tr.players.get(w));
    handleMessage(t1, { type: "bet", i: 0, amount: 100 }); // 홀에 상한까지 = 올인
    handleMessage(t2, { type: "bet", i: 1, amount: 30 });  // 짝, T3은 구경
    for (const w of [t1, t2, t3]) handleMessage(w, { type: "ready", v: true });
    clearTimeout(tr.timer);
    tr.dice.roll = [1, 2]; // 합 3(홀): T1 100 → 190, T2 30 → 0
    diceSettle(tr);
    clearTimeout(tr.timer);
    broadcastRoom(tr); broadcastRoom(tr); // 같은 결과로 몇 번을 보내도
    assert.deepStrictEqual(T1.ttStats, { ...ttNew(), wagered: 100, returned: 190, rounds: 1, bigWin: 90, allIns: 1, byGame: { dice: 90 } });
    assert(T2.ttStats.bigLoss === 30 && T2.ttStats.allIns === 0 && T3.ttStats.rounds === 0);
    tr.game = "zzz"; T2.money = 0; // 병렬로 생길 새 게임 흉내: payouts 형식만 맞으면 잡힌다. 가진 돈을 다 건 판 = 올인
    tr.result = { payouts: { [T2.id]: { bet: 50, win: 0 }, [T3.id]: { bet: 0, win: 0 } } };
    broadcastRoom(tr);
    handleMessage(t4, { type: "join", id: tr.code, name: "T4" }); // 도중 입장 (broadcast가 또 가도 중복 기록 없음)
    const T4 = tr.players.get(t4);
    assert(T2.ttStats.allIns === 1 && T2.ttStats.bigLoss === 50 && T2.ttStats.rounds === 2 && T2.ttStats.byGame.zzz === -50 && T3.ttStats.rounds === 0);
    assert.deepStrictEqual(T4.ttStats, ttNew());
    T3.mining = true;
    startNight(tr); // T2 파산, T3 탄광 일당
    handleMessage(t2, { type: "beg", v: true });
    handleMessage(t1, { type: "give", to: T2.id });
    assert(T2.ttStats.bankrupt === 1 && T2.ttStats.begged === 1 && T1.ttStats.given === 1 && T3.ttStats.mined === 1 && T1.ttStats.bankrupt === 0);
    for (const w of [t1, t2, t3, t4]) handleMessage(w, { type: "ready", v: true });
    assert(tr.phase === "final"); // 최종: T3 $1200, T4 $1000, T1 $990, T2 $100 (4위라 불사조는 못 받음)
    assert.deepStrictEqual([T1, T2, T3, T4].map((p) => p.ttTitles), [["💎 한탕주의", "🎯 주사위 장인"], ["📉 하우스의 VIP", "🥺 구걸왕"], ["⛏️ 탄광 VIP"], ["😐 평범한 도박꾼"]]);
    const ttAll = [T1, T2, T3, T4].flatMap((p) => p.ttTitles);
    assert(new Set(ttAll).size === ttAll.length && [T1, T2, T3, T4].every((p) => p.ttTitles.length >= 1 && p.ttTitles.length <= 2));
    T2.money = 1000; ttAward(tr); // 3위 안으로 올라오면 불사조가 먼저
    assert.deepStrictEqual(T2.ttTitles, ["🔥 불사조", "📉 하우스의 VIP"]);
    handleMessage(t1, { type: "again" });
    assert(tr.phase === "lobby" && [T1, T2, T3, T4].every((p) => !p.ttTitles && JSON.stringify(p.ttStats) === JSON.stringify(ttNew())));
    delete process.env.GAME;
  }
  console.log("OK");
  process.exit(0);
}

const PORT = process.env.PORT || 3100;
server.listen(PORT, () => {
  console.log("뒷방 한탕 서버 실행 중 - 포트 " + PORT);
});
