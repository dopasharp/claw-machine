// 폰 = 조종기. 조이스틱 방향만 보내고, 기계(PC)가 움직임을 계산해요.
import { joinRoom, normalizeRoomId } from './net.js?v=1';

const $ = (id) => document.getElementById(id) || document.createElement('div');
const params = new URLSearchParams(location.search);
const SOLO = document.body.dataset.mode === 'solo'; // 폰 하나로: 같은 페이지의 기계를 직접 조종
const EMOJI = { bear: '🧸', bunny: '🐰', chick: '🐥', frog: '🐸', pig: '🐷', cat: '🐱', puppy: '🐶', dopa: '💚' };
const vibe = (p) => {
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate?.(p); } catch { /* iOS 등 미지원 */ }
};

let room = null;
let roomId = '';
let state = null;
let machineUp = true;
let lastWinId = null;
let resultShown = false;
const PLAY_SECS = 30;

// ------------------------------------------------------------------ 입장
function showJoin(err = '') {
  $('joinScreen').hidden = false;
  $('ctrlScreen').hidden = true;
  $('joinError').textContent = err;
  if (roomId) $('codeInput').value = roomId;
}

async function join(id) {
  roomId = normalizeRoomId(id);
  if (roomId.length < 4) return showJoin('방 코드를 확인해 주세요');
  try {
    room = await joinRoom(roomId, { onState, onMachine });
  } catch (e) {
    return showJoin(e.message === 'NOT_FOUND' ? '방을 찾을 수 없어요. PC 화면의 코드를 확인해 주세요.' : '연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
  const u = new URL(location.href);
  u.searchParams.set('room', roomId);
  history.replaceState(null, '', u);
  $('joinScreen').hidden = true;
  $('ctrlScreen').hidden = false;
  $('hudRoom').textContent = roomId;
  window.DopaSharp?.track('game_start', { role: 'controller' });
  render();
}

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  join($('codeInput').value);
});

// ------------------------------------------------------------------ 상태 표시
function onMachine(up) {
  machineUp = up;
  $('connDot').className = `dot ${up ? 'on' : 'off'}`;
  $('connText').textContent = up ? '기계 연결됨' : '기계 연결이 끊겼어요… PC 화면을 확인해 주세요';
  render();
}

function onState(s) {
  const prev = state;
  state = s;
  if (s.last && s.last.id !== lastWinId) {
    const fresh = lastWinId !== null || (prev && prev.caught < s.caught);
    lastWinId = s.last.id;
    if (fresh) {
      vibe([80, 60, 80, 60, 200]);
      flash(`${s.last.emoji} GET!`, `${s.last.name}을(를) 뽑았어요!`, 2600);
    }
  }
  if (prev && prev.phase === 'play' && s.phase === 'down') vibe(40);
  if (prev && prev.phase !== 'close' && s.phase === 'up') vibe(25);
  if (prev && prev.phase !== 'top' && s.phase === 'top') vibe([90, 40, 30]);
  if (s.phase === 'over' && !resultShown) {
    resultShown = true;
    setTimeout(showResult, 900);
  }
  if (s.phase !== 'over') resultShown = false;
  render();
}

let flashUntil = 0;
let flashMsg = null;
function flash(big, sub, ms) {
  flashMsg = { big, sub };
  flashUntil = Date.now() + ms;
  render();
  setTimeout(render, ms + 20);
}

function render() {
  const s = state || { phase: 'idle', coins: 5, caught: 0, left: PLAY_SECS };
  $('hudCoins').textContent = s.coins;
  $('hudCaught').textContent = s.caught;
  const fill = $('timeFill');
  const pct = s.phase === 'play' ? Math.max(0, (s.left - 1) / PLAY_SECS) * 100 : 0;
  fill.style.width = `${pct}%`;
  fill.classList.toggle('hurry', s.phase === 'play' && s.left <= 5);

  const btn = $('actionBtn');
  const joy = $('joy');
  joy.classList.toggle('off', s.phase !== 'play' || !machineUp);
  btn.classList.remove('drop');
  let big = '';
  let sub = '';
  if (!machineUp) {
    big = '연결 끊김';
    sub = 'PC 화면이 켜져 있는지 확인해 주세요';
    btn.disabled = true;
    btn.textContent = '…';
  } else if (s.phase === 'idle' || s.phase === 'boot') {
    big = s.msg || '코인을 넣어주세요';
    sub = `남은 코인 ${s.coins}개`;
    btn.disabled = s.coins <= 0;
    btn.textContent = '🪙 코인 넣기';
  } else if (s.phase === 'play') {
    big = `${s.left}`;
    sub = '조이스틱으로 움직이고 뽑기!';
    btn.disabled = false;
    btn.classList.add('drop');
    btn.textContent = '뽑기!';
  } else if (s.phase === 'over') {
    big = '게임 끝!';
    sub = `${s.caught}개 뽑았어요`;
    btn.disabled = false;
    btn.textContent = '🪙 다시 하기';
  } else {
    big = { down: '내려간다…', close: '꽉!', up: '올라간다…', top: '쾅!', carry: '두근두근…', release: '두근두근…', settle: '과연…?' }[s.phase] || '…';
    sub = '';
    btn.disabled = true;
    btn.textContent = '잡는 중…';
  }
  if (Date.now() < flashUntil && flashMsg) ({ big, sub } = flashMsg);
  const bigEl = $('msgBig');
  bigEl.textContent = big;
  bigEl.classList.toggle('get', Date.now() < flashUntil);
  $('msgSub').textContent = sub;
}

function showResult() {
  const s = state;
  if (!s) return;
  const art = (s.prizes || []).map((k) => EMOJI[k] || '🧸').join('') || '🫥';
  window.DopaSharp?.showResult({
    art,
    title: s.caught === 0 ? '빈손이에요…' : s.caught >= 3 ? '인형뽑기 장인!' : '득템 성공!',
    stat: `5판 중 ${s.caught}개 GET`,
    detail: 'PC 화면은 기계, 폰은 조이스틱!',
    shareText: `도파# 인형뽑기 — 코인 5개로 ${s.caught}개 뽑았어요 ${art}`,
    retryLabel: '🪙 다시 하기',
    onRetry: () => room?.sendCmd('reset'),
  });
}

// ------------------------------------------------------------------ 버튼
$('actionBtn').addEventListener('click', () => {
  if (!room || !state) return;
  const ph = state.phase;
  if (ph === 'idle') { room.sendCmd('coin'); vibe(30); }
  else if (ph === 'play') { sendStick(0, 0, true); room.sendCmd('drop'); vibe(60); }
  else if (ph === 'over') { window.DopaSharp?.close(); room.sendCmd('reset'); vibe(30); }
});

// ------------------------------------------------------------------ 조이스틱
const joy = $('joy');
const knob = $('knob');
let activeId = null;
let sent = { x: 0, z: 0 };
let pending = null;
let lastSend = 0;
let timer = null;

function sendStick(x, z, force = false) {
  pending = { x, z };
  const now = performance.now();
  const flush = () => {
    timer = null;
    lastSend = performance.now();
    if (!pending || (pending.x === sent.x && pending.z === sent.z)) return;
    sent = pending;
    room?.sendInput(sent.x, sent.z);
  };
  if (force || now - lastSend > 70) { clearTimeout(timer); flush(); }
  else if (!timer) timer = setTimeout(flush, 70 - (now - lastSend));
}

let lastDir = '';
function moveKnob(e) {
  const r = joy.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const max = r.width * 0.32;
  let dx = e.clientX - cx;
  let dy = e.clientY - cy;
  const d = Math.hypot(dx, dy);
  if (d > max) { dx *= max / d; dy *= max / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  let nx = dx / max;
  let nz = dy / max;
  const m = Math.hypot(nx, nz);
  if (m < 0.18) { nx = 0; nz = 0; }
  const q = (v) => Math.round(v * 10) / 10;
  const dir = `${Math.sign(q(nx))},${Math.sign(q(nz))}`;
  if (dir !== lastDir && dir !== '0,0') vibe(8);
  lastDir = dir;
  sendStick(q(nx), q(nz));
}
function release() {
  activeId = null;
  knob.classList.add('free');
  knob.style.transform = '';
  lastDir = '';
  sendStick(0, 0, true);
}
joy.addEventListener('pointerdown', (e) => {
  if (state?.phase !== 'play' || activeId !== null) return;
  activeId = e.pointerId;
  try { joy.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 등 */ }
  knob.classList.remove('free');
  moveKnob(e);
});
joy.addEventListener('pointermove', (e) => { if (e.pointerId === activeId) moveKnob(e); });
joy.addEventListener('pointerup', (e) => { if (e.pointerId === activeId) release(); });
joy.addEventListener('pointercancel', (e) => { if (e.pointerId === activeId) release(); });
addEventListener('blur', () => { if (activeId !== null) release(); });
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 데스크톱에서 조종기 탭을 테스트할 때 키보드도 지원
const keys = new Set();
const KEY = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' };
function keyStick() {
  const x = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
  const z = (keys.has('d') ? 1 : 0) - (keys.has('u') ? 1 : 0);
  sendStick(x, z, true);
}
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input')) return;
  if (KEY[e.key]) { keys.add(KEY[e.key]); keyStick(); e.preventDefault(); }
  else if (e.key === ' ' && !e.repeat) { e.preventDefault(); $('actionBtn').click(); }
});
addEventListener('keyup', (e) => { if (KEY[e.key]) { keys.delete(KEY[e.key]); keyStick(); } });

// ------------------------------------------------------------------ 시작
function startSolo() {
  // 네트워크 없이 같은 페이지의 기계(machine.js)에 바로 연결
  room = {
    sendInput: (x, z) => window.claw?.setInput(x, z),
    sendCmd: (type) => {
      const c = window.claw;
      if (!c) return;
      if (type === 'coin') c.insertCoin();
      else if (type === 'drop') c.dropClaw();
      else if (type === 'reset') c.resetGame();
    },
  };
  addEventListener('claw:state', (e) => onState(e.detail));
  $('ctrlScreen').hidden = false;
  $('soloStart').addEventListener('click', () => {
    const go = () => {
      $('startOverlay').classList.remove('show');
      window.claw.start();
      window.DopaSharp?.track('game_start', { role: 'solo' });
    };
    if (window.claw) go();
    else addEventListener('claw:ready', go, { once: true });
  });
  render();
}

const fromUrl = params.get('room');
if (SOLO) startSolo();
else if (fromUrl) join(fromUrl);
else showJoin();
