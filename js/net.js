// 기계(PC) <-> 조종기(폰) 연동 레이어.
// - firebase: Realtime Database (서로 다른 기기 간 연동)
// - local:    BroadcastChannel (같은 브라우저의 탭끼리, Firebase 설정 전 테스트용)
import { firebaseConfig } from './firebase-config.js?v=1';

const ROOT = 'clawRooms';
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const params = new URLSearchParams(location.search);
const cfg = firebaseConfig || {};
const configured = !!cfg.databaseURL && !/YOUR_/.test(`${cfg.apiKey}${cfg.databaseURL}`);

export const mode = params.has('local') || !configured ? 'local' : 'firebase';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeRoomId(len = 5) {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(len))) s += ALPHABET[b % ALPHABET.length];
  return s;
}
export function normalizeRoomId(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

let fbPromise;
function fb() {
  fbPromise ??= (async () => {
    const [{ initializeApp }, d] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-database.js`),
    ]);
    return { d, db: d.getDatabase(initializeApp(firebaseConfig)) };
  })();
  return fbPromise;
}

/** 기계(호스트)가 방을 연다. */
export async function hostRoom(roomId, { onPad, onInput, onCmd }) {
  if (mode === 'local') return localHost(roomId, { onPad, onInput, onCmd });

  const { d, db } = await fb();
  const path = (p = '') => d.ref(db, `${ROOT}/${roomId}${p}`);
  let lastState = null;

  d.onValue(d.ref(db, '.info/connected'), (snap) => {
    if (snap.val() !== true) return;
    d.onDisconnect(path()).remove();
    d.set(path('/meta'), { createdAt: d.serverTimestamp() });
    if (lastState) d.set(path('/state'), lastState);
  });
  d.onValue(path('/pad'), (s) => onPad(s.val()));
  d.onValue(path('/input'), (s) => s.exists() && onInput(s.val()));
  d.onChildAdded(path('/cmds'), (s) => {
    onCmd(s.val());
    d.remove(s.ref);
  });

  return {
    setState(state) {
      lastState = state;
      d.set(path('/state'), state);
    },
  };
}

/** 조종기가 방에 들어간다. */
export async function joinRoom(roomId, { onState, onMachine }) {
  if (mode === 'local') return localJoin(roomId, { onState, onMachine });

  const { d, db } = await fb();
  const path = (p = '') => d.ref(db, `${ROOT}/${roomId}${p}`);

  const meta = await d.get(path('/meta'));
  if (!meta.exists()) throw new Error('NOT_FOUND');

  const announce = () => d.set(path('/pad'), { at: d.serverTimestamp() });
  d.onValue(d.ref(db, '.info/connected'), (snap) => {
    if (snap.val() !== true) return;
    d.onDisconnect(path('/pad')).remove();
    announce();
  });
  // 기계 화면이 새로고침되면 방이 지워졌다 다시 생기므로, 다시 생길 때 접속을 재등록
  let up = true;
  d.onValue(path('/meta'), (s) => {
    const now = s.exists();
    if (now && !up) announce();
    up = now;
    onMachine(now);
  });
  d.onValue(path('/state'), (s) => s.exists() && onState(s.val()));

  return {
    sendInput(x, z) { d.set(path('/input'), { x, z }); },
    sendCmd(type) { d.set(d.push(path('/cmds')), { type, at: d.serverTimestamp() }); },
  };
}

// ---------------------------------------------------------------- local mode

const channel = (roomId) => new BroadcastChannel(`claw-room-${roomId}`);

function localHost(roomId, { onPad, onInput, onCmd }) {
  const ch = channel(roomId);
  let state = null;
  ch.onmessage = ({ data: m }) => {
    if (m.type === 'pad') onPad(m.info);
    else if (m.type === 'input') onInput(m.v);
    else if (m.type === 'cmd') onCmd(m.cmd);
    else if (m.type === 'hello') {
      ch.postMessage({ type: 'meta' });
      if (state) ch.postMessage({ type: 'state', state });
    }
  };
  ch.postMessage({ type: 'meta' });
  addEventListener('pagehide', () => ch.postMessage({ type: 'bye' }));
  return {
    setState(s) {
      state = s;
      ch.postMessage({ type: 'state', state: s });
    },
  };
}

function localJoin(roomId, { onState, onMachine }) {
  const ch = channel(roomId);
  const api = {
    sendInput(x, z) { ch.postMessage({ type: 'input', v: { x, z } }); },
    sendCmd(type) { ch.postMessage({ type: 'cmd', cmd: { type, at: Date.now() } }); },
  };
  addEventListener('pagehide', () => ch.postMessage({ type: 'pad', info: null }));

  return new Promise((resolve, reject) => {
    let found = false;
    ch.onmessage = ({ data: m }) => {
      if (m.type === 'meta') {
        if (!found) { found = true; resolve(api); }
        onMachine(true);
        ch.postMessage({ type: 'pad', info: { at: Date.now() } });
      } else if (m.type === 'state') onState(m.state);
      else if (m.type === 'bye') onMachine(false);
    };
    ch.postMessage({ type: 'hello' });
    setTimeout(() => { if (!found) reject(new Error('NOT_FOUND')); }, 1500);
  });
}
