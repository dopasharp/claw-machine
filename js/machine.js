// PC 화면 = 인형뽑기 기계. three.js 장면 + 간단한 구슬 물리(Verlet) + 게임 진행.
import * as THREE from 'three';
import { mode, makeRoomId, normalizeRoomId, hostRoom } from './net.js?v=1';
import * as sfx from './sound.js?v=2';

// 없는 요소는 빈 div 로 대신 (폰 혼자 모드 화면엔 PC용 HUD 가 없음)
const $ = (id) => document.getElementById(id) || document.createElement('div');
const params = new URLSearchParams(location.search);
const SOLO = document.body.dataset.mode === 'solo'; // 폰 하나로 하기
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ 상수
const BOX = { x0: -1.5, x1: 1.5, z0: -0.9, z1: 0.9, top: 3.0 }; // 유리 안쪽
const CHUTE = { x0: -1.5, x1: -0.8, z0: 0.2, z1: 0.9, h: 0.72 }; // 앞-왼쪽 배출구
const HOME = { x: (CHUTE.x0 + CHUTE.x1) / 2, z: (CHUTE.z0 + CHUTE.z1) / 2 };
const MOVE = { x0: -1.3, x1: 1.3, z0: -0.7, z1: 0.7 }; // 집게가 갈 수 있는 범위
const CLAW_TOP = 2.55;
const TIP = 0.5; // 허브 중심 → 집게 끝
const SPEED = 0.95;
const PLAY_SECS = 30;
const COINS = 5;
const PRIZE_COUNT = 21;
const G = 9.8;

const KINDS = {
  bear: { name: '곰돌이', emoji: '🧸', color: 0xcf9a6b, paw: 0xf3d6b4, belly: 0xf3d6b4, w: 6 },
  bunny: { name: '토끼', emoji: '🐰', color: 0xfff7f0, paw: 0xffe3ea, w: 6 },
  chick: { name: '병아리', emoji: '🐥', color: 0xffe36a, paw: 0xffa53d, wings: true, w: 5 },
  frog: { name: '개구리', emoji: '🐸', color: 0xa3e590, belly: 0xeaf8cf, w: 5 },
  pig: { name: '돼지', emoji: '🐷', color: 0xffc1d4, w: 5 },
  cat: { name: '고양이', emoji: '🐱', color: 0xf8b56e, paw: 0xfff1e0, belly: 0xfff1e0, w: 5 },
  puppy: { name: '강아지', emoji: '🐶', color: 0xf5e6cc, w: 6 },
  dopa: { name: '레어 도파# 인형', emoji: '💚', color: 0xd9ff44, w: 0, rare: true },
};
const KIND_LIST = Object.keys(KINDS).filter((k) => KINDS[k].w > 0);
function pickKind() {
  const total = KIND_LIST.reduce((s, k) => s + KINDS[k].w, 0);
  let r = Math.random() * total;
  for (const k of KIND_LIST) if ((r -= KINDS[k].w) < 0) return k;
  return 'bear';
}

// ------------------------------------------------------------------ 렌더러/장면
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e0d);
scene.fog = new THREE.Fog(0x0b0e0d, 18, 40);

// ------------------------------------------------------------------ 카메라: 기계 전체 / 집게 카메라 + 드래그로 돌려보기
const FOV = { machine: 36, claw: 74 };
const camera = new THREE.PerspectiveCamera(FOV.machine, 1, 0.05, 60);
const LOOK = new THREE.Vector3(0, 1.2, 0);
const view = {
  mode: SOLO ? 'claw' : 'machine',
  yaw: 0, pitch: 0, zoom: 1, // 현재값
  ty: 0, tp: 0, tz: 1, // 목표값 (드래그/휠)
  r: 10, p0: 0.12, // 기계 전체 보기 기본 거리/각도
  shake: 0,
  cam: new THREE.Vector3(), look: new THREE.Vector3(), init: false,
};
function resize() {
  const w = canvas.clientWidth || innerWidth;
  const h = canvas.clientHeight || innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const t = Math.tan(THREE.MathUtils.degToRad(FOV.machine / 2));
  const dist = Math.max(6.3 / 2 / t, 4.9 / 2 / (t * camera.aspect));
  const up = 0.5 + dist * 0.08;
  view.r = Math.hypot(dist, up);
  view.p0 = Math.atan2(up, dist);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
resize();

function setViewMode(m) {
  view.mode = m;
  view.ty = view.tp = 0;
  view.tz = 1;
  view.init = false;
  camera.fov = FOV[m];
  camera.updateProjectionMatrix();
  for (const b of document.querySelectorAll('[data-view-toggle]')) b.textContent = m === 'claw' ? '🎥 기계 전체' : '🎥 집게 시점';
}
setViewMode(view.mode);

// 마우스/손가락으로 끌어서 위아래·좌우 돌려보기, 휠/핀치로 확대, 더블탭으로 원위치
const drags = new Map();
let pinch0 = 0;
canvas.addEventListener('pointerdown', (e) => {
  drags.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
  canvas.classList.add('dragging');
  if (drags.size === 2) {
    const [a, b] = [...drags.values()];
    pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener('pointermove', (e) => {
  const d = drags.get(e.pointerId);
  if (!d) return;
  if (drags.size === 2) {
    d.x = e.clientX;
    d.y = e.clientY;
    const [a, b] = [...drags.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch0 > 0) view.tz = clamp(view.tz * (pinch0 / dist), 0.6, 1.5);
    pinch0 = dist;
    return;
  }
  const dx = e.clientX - d.x;
  const dy = e.clientY - d.y;
  d.x = e.clientX;
  d.y = e.clientY;
  view.ty = clamp(view.ty - dx * 0.006, -1.15, 1.15);
  view.tp = clamp(view.tp + dy * 0.006, -0.3, 1.15);
});
const endDrag = (e) => {
  drags.delete(e.pointerId);
  pinch0 = 0;
  if (!drags.size) canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  view.tz = clamp(view.tz * (1 + Math.sign(e.deltaY) * 0.08), 0.6, 1.5);
}, { passive: false });
canvas.addEventListener('dblclick', () => { view.ty = 0; view.tp = 0; view.tz = 1; });
for (const b of document.querySelectorAll('[data-view-toggle]')) {
  b.addEventListener('click', () => setViewMode(view.mode === 'claw' ? 'machine' : 'claw'));
}

function applyCamera(dt) {
  const k = Math.min(1, dt * 10);
  view.yaw += (view.ty - view.yaw) * k;
  view.pitch += (view.tp - view.pitch) * k;
  view.zoom += (view.tz - view.zoom) * k;
  const cam = new THREE.Vector3();
  const look = new THREE.Vector3();
  if (view.mode === 'claw') {
    // 집게 바로 뒤 위쪽에 달린 카메라: 집게발이 화면에 보이고, 집게와 같이 움직이고 흔들림
    const back = 0.85 * view.zoom;
    const down = clamp(1.0 + view.pitch * 0.9, 0.25, 2.0); // 드래그 위아래 = 내려다보는 깊이
    const cx = cl.wx;
    const cy = cl.y + cl.bob;
    const cz = cl.wz;
    const sy = Math.sin(view.yaw);
    const cyaw = Math.cos(view.yaw);
    // 유리 앞으로 나가는 건 괜찮지만(투명) 기둥·간판 속으로는 안 들어가게
    cam.set(
      clamp(cx + sy * back, BOX.x0 + 0.08, BOX.x1 - 0.08),
      Math.min(cy + 0.32 * view.zoom, BOX.top - 0.04),
      clamp(cz + cyaw * back, BOX.z0 + 0.08, 1.7),
    );
    look.set(cx - sy * 0.25, cy - down, cz - cyaw * 0.25);
  } else {
    const p = view.p0 + view.pitch;
    const R = view.r * view.zoom;
    cam.set(LOOK.x + Math.sin(view.yaw) * Math.cos(p) * R, LOOK.y + Math.sin(p) * R, LOOK.z + Math.cos(view.yaw) * Math.cos(p) * R);
    look.copy(LOOK);
  }
  if (!view.init) { view.cam.copy(cam); view.look.copy(look); view.init = true; }
  const f = Math.min(1, dt * (view.mode === 'claw' ? 14 : 30));
  view.cam.lerp(cam, f);
  view.look.lerp(look, f);
  camera.position.copy(view.cam);
  if (view.shake > 0) {
    camera.position.x += (Math.random() - 0.5) * view.shake;
    camera.position.y += (Math.random() - 0.5) * view.shake;
    view.shake = Math.max(0, view.shake - dt * 0.2);
  }
  camera.lookAt(view.look);
}

scene.add(new THREE.HemisphereLight(0xfff3f8, 0x2a1b2a, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.6, 7, 2.2);
sun.target.position.set(0, 0, 0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 1, far: 10 });
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const fill = new THREE.PointLight(0xff9ec0, 6, 9, 1.6);
fill.position.set(-2.6, 2.2, 3);
const fill2 = new THREE.PointLight(0xd9ff44, 4, 9, 1.6);
fill2.position.set(2.6, 1.6, 3);
scene.add(fill, fill2);
const inside = new THREE.PointLight(0xfff1d6, 5, 5, 1.5);
inside.position.set(0, 2.85, 0.2);
scene.add(inside);

// ------------------------------------------------------------------ 텍스처
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const backTex = canvasTex(1024, 1024, (g, w, h) => {
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, '#2b1d3d');
  grd.addColorStop(1, '#4a2140');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const cx = x * 120 + (y % 2) * 60 + 30;
      const cy = y * 120 + 40;
      g.fillStyle = (x + y) % 3 === 0 ? 'rgba(217,255,68,.5)' : (x + y) % 3 === 1 ? 'rgba(255,108,145,.45)' : 'rgba(134,239,200,.4)';
      g.beginPath();
      if ((x + y) % 2) g.arc(cx, cy, 10, 0, Math.PI * 2);
      else star(g, cx, cy, 15, 6);
      g.fill();
    }
  }
});
function star(g, cx, cy, ro, ri) {
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    g[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  g.closePath();
}

function signTexture() {
  return canvasTex(1024, 256, (g, w, h) => {
    g.fillStyle = '#101310';
    g.fillRect(0, 0, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '150px "Black Han Sans", "Pretendard Variable", sans-serif';
    g.lineJoin = 'round';
    g.lineWidth = 18;
    g.strokeStyle = '#FF6C91';
    g.strokeText('인형뽑기', w / 2, h / 2 + 8);
    g.fillStyle = '#D9FF44';
    g.fillText('인형뽑기', w / 2, h / 2 + 8);
    g.font = '700 34px "Pretendard Variable", sans-serif';
    g.fillStyle = '#86EFC8';
    g.fillText('D#', 70, h / 2);
    g.fillText('D#', w - 70, h / 2);
  });
}

// ------------------------------------------------------------------ 기계 본체
const PINK = 0xff6c91;
const LIME = 0xd9ff44;
const M = {
  pink: new THREE.MeshStandardMaterial({ color: PINK, roughness: 0.45, metalness: 0.05 }),
  pinkDark: new THREE.MeshStandardMaterial({ color: 0xc94470, roughness: 0.5 }),
  lime: new THREE.MeshStandardMaterial({ color: LIME, emissive: LIME, emissiveIntensity: 0.6, roughness: 0.4 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x15191a, roughness: 0.6 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xdfe4ea, roughness: 0.18, metalness: 0.95 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xffd36b, roughness: 0.25, metalness: 0.9 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0xcfefff, roughness: 0.05, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }),
  acrylic: new THREE.MeshPhysicalMaterial({ color: 0xbff7ff, roughness: 0.1, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }),
  floor: new THREE.MeshStandardMaterial({ color: 0x5a2b49, roughness: 1 }),
  hole: new THREE.MeshBasicMaterial({ color: 0x050505 }),
};
const box = (w, h, d, mat, x, y, z, shadow = true) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  scene.add(m);
  return m;
};

// 바닥/뒷벽
const floor = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.8), M.floor);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const holeMesh = new THREE.Mesh(new THREE.PlaneGeometry(CHUTE.x1 - CHUTE.x0, CHUTE.z1 - CHUTE.z0), M.hole);
holeMesh.rotation.x = -Math.PI / 2;
holeMesh.position.set(HOME.x, 0.004, HOME.z);
scene.add(holeMesh);
const back = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 3.0), new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.9 }));
back.position.set(0, 1.5, BOX.z0);
back.receiveShadow = true;
scene.add(back);
const sideMat = new THREE.MeshStandardMaterial({ color: 0x2b1d3d, roughness: 0.9, transparent: true, opacity: 0.35 });
for (const sx of [-1, 1]) {
  const s = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 3.0), sideMat);
  s.rotation.y = -sx * Math.PI / 2;
  s.position.set(sx * BOX.x1, 1.5, 0);
  scene.add(s);
}
// 유리 (앞)
const glass = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 3.0), M.glass);
glass.position.set(0, 1.5, BOX.z1 + 0.01);
glass.renderOrder = 10;
scene.add(glass);
for (const [x, w] of [[-0.9, 0.08], [-0.75, 0.03], [0.85, 0.06]]) {
  const shine = new THREE.Mesh(new THREE.PlaneGeometry(w, 3.6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, depthWrite: false }));
  shine.position.set(x, 1.5, BOX.z1 + 0.02);
  shine.rotation.z = 0.5;
  shine.renderOrder = 11;
  scene.add(shine);
}

// 기둥 + 상단 간판 + 하단 캐비닛
for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.16, 3.1, 0.16, M.pink, sx * 1.58, 1.5, sz * 0.98);
box(3.34, 0.1, 2.12, M.pink, 0, 3.05, 0);
const header = box(3.34, 0.75, 2.12, M.pink, 0, 3.47, 0);
header.castShadow = false;
const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 0.62), new THREE.MeshBasicMaterial({ map: signTexture() }));
sign.position.set(0, 3.47, 1.065);
scene.add(sign);
document.fonts?.load('150px "Black Han Sans"').then(() => {
  sign.material.map = signTexture();
  sign.material.needsUpdate = true;
});
// 간판 전구
const bulbs = [];
const bulbGeo = new THREE.SphereGeometry(0.035, 12, 8);
for (let i = 0; i < 36; i++) {
  const t = i / 36;
  const per = 2 * (2.9 + 0.66);
  let d = t * per;
  let x;
  let y;
  if (d < 2.9) { x = -1.45 + d; y = 3.8; }
  else if ((d -= 2.9) < 0.66) { x = 1.45; y = 3.8 - d; }
  else if ((d -= 0.66) < 2.9) { x = 1.45 - d; y = 3.14; }
  else { d -= 2.9; x = -1.45; y = 3.14 + d; }
  const mat = new THREE.MeshStandardMaterial({ color: 0xfff6d0, emissive: i % 2 ? LIME : 0xffe7a0, emissiveIntensity: 1 });
  const b = new THREE.Mesh(bulbGeo, mat);
  b.position.set(x, y, 1.08);
  scene.add(b);
  bulbs.push(mat);
}
// 하단 캐비닛
box(3.34, 1.6, 2.12, M.pink, 0, -0.8, 0);
box(3.36, 0.06, 2.14, M.lime, 0, 0.0, 0, false);
box(3.36, 0.06, 2.14, M.lime, 0, 3.0, 0, false);
// 컨트롤 패널 (폰 조이스틱을 따라 움직이는 미니 조이스틱)
box(3.34, 0.12, 0.6, M.pinkDark, 0, -0.18, 1.3);
box(3.34, 0.36, 0.06, M.pinkDark, 0, -0.42, 1.58);
const stick = new THREE.Group();
stick.position.set(0.3, -0.12, 1.32);
const stickRod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 12), M.chrome);
stickRod.position.y = 0.15;
const stickBall = new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 16), new THREE.MeshStandardMaterial({ color: 0xff3b5c, roughness: 0.3 }));
stickBall.position.y = 0.32;
stick.add(stickRod, stickBall);
stick.traverse((o) => { o.castShadow = true; });
scene.add(stick);
const btnBase = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 24), M.dark);
btnBase.position.set(0.85, -0.1, 1.32);
const btnTop = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.06, 24), new THREE.MeshStandardMaterial({ color: LIME, emissive: LIME, emissiveIntensity: 0.4 }));
btnTop.position.set(0.85, -0.06, 1.32);
scene.add(btnBase, btnTop);
// 상품 배출구 문
box(0.72, 0.5, 0.04, M.dark, HOME.x, -0.75, 1.07, false);
const flap = box(0.66, 0.44, 0.02, new THREE.MeshStandardMaterial({ color: 0x86efc8, transparent: true, opacity: 0.55 }), HOME.x, -0.75, 1.1, false);
// 코인 투입구
box(0.3, 0.42, 0.04, M.dark, 0.95, -0.85, 1.07, false);
box(0.04, 0.14, 0.05, M.lime, 0.95, -0.78, 1.08, false);

// 배출구 아크릴 벽
const cw = CHUTE.x1 - CHUTE.x0;
const cd = CHUTE.z1 - CHUTE.z0;
const acry = (w, d, x, z) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, CHUTE.h, d), M.acrylic);
  m.position.set(x, CHUTE.h / 2, z);
  m.renderOrder = 5;
  scene.add(m);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0x86efc8, transparent: true, opacity: 0.7 }));
  edge.position.copy(m.position);
  scene.add(edge);
};
acry(0.03, cd, CHUTE.x1, HOME.z);
acry(cw, 0.03, HOME.x, CHUTE.z0);

// 갠트리 (위쪽 레일)
for (const sx of [-1, 1]) box(0.06, 0.06, 1.8, M.chrome, sx * 1.46, 2.9, 0);
const bridge = box(2.92, 0.05, 0.08, M.chrome, 0, 2.86, 0);
const carriage = box(0.2, 0.1, 0.2, M.dark, 0, 2.86, 0);

// ------------------------------------------------------------------ 집게
const claw = new THREE.Group();
scene.add(claw);
const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.16, 24), M.gold);
hub.castShadow = true;
const cap = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.gold);
cap.position.y = 0.08;
cap.castShadow = true;
claw.add(hub, cap);
const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 8), M.dark);
cable.castShadow = true;
scene.add(cable);
const prongs = [];
for (let i = 0; i < 3; i++) {
  const yaw = new THREE.Group();
  yaw.rotation.y = (i / 3) * Math.PI * 2 + Math.PI / 6;
  const pivot = new THREE.Group();
  pivot.position.set(0, -0.06, 0.09);
  const upper = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.025), M.chrome);
  upper.position.set(0, -0.15, 0);
  const elbow = new THREE.Group();
  elbow.position.set(0, -0.3, 0);
  elbow.rotation.x = 0.6;
  const lower = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.025), M.chrome);
  lower.position.set(0, -0.1, 0);
  const tipBall = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), M.chrome);
  tipBall.position.set(0, -0.2, 0);
  elbow.add(lower, tipBall);
  pivot.add(upper, elbow);
  pivot.traverse((o) => { o.castShadow = true; });
  yaw.add(pivot);
  claw.add(yaw);
  prongs.push(pivot);
}
function setOpen(o) {
  // o: 0 = 닫힘, 1 = 활짝
  for (const p of prongs) p.rotation.x = 0.02 - o * 0.6;
}
// 집게발 끝의 위치 (허브 중심 기준): 축에서 거리 rr, 높이 dy
function tipLocal(o) {
  const tu = 0.02 - o * 0.6;
  const tl = tu + 0.6;
  return {
    rr: 0.09 - 0.3 * Math.sin(tu) - 0.2 * Math.sin(tl),
    dy: -0.06 - 0.3 * Math.cos(tu) - 0.2 * Math.cos(tl),
  };
}
const PRONG_YAW = [0, 1, 2].map((i) => (i / 3) * Math.PI * 2 + Math.PI / 6);
// 바닥 위 조준 링
const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.14, 32), new THREE.MeshBasicMaterial({ color: LIME, transparent: true, opacity: 0.55, depthWrite: false }));
ring.rotation.x = -Math.PI / 2;
ring.renderOrder = 3;
scene.add(ring);

// ------------------------------------------------------------------ 인형 만들기
const SPH = new THREE.SphereGeometry(1, 32, 24);
const SPH_S = new THREE.SphereGeometry(1, 16, 12);
const black = new THREE.MeshStandardMaterial({ color: 0x1a1414, roughness: 0.12 });
const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, emissive: 0xffffff, emissiveIntensity: 0.25 });
const cheekMat = new THREE.MeshStandardMaterial({ color: 0xff8fb0, roughness: 0.9, emissive: 0xff6c91, emissiveIntensity: 0.12, transparent: true, opacity: 0.9 });
const pinkMat = new THREE.MeshStandardMaterial({ color: 0xff8fb0, roughness: 0.6 });
const MOUTH = new THREE.TorusGeometry(1, 0.22, 6, 14, Math.PI);
const CONE4 = new THREE.ConeGeometry(1, 1.5, 4);
const CONE = new THREE.ConeGeometry(1, 1.6, 12);
const furCache = new Map();
function fur(color) {
  if (!furCache.has(color)) {
    const c = new THREE.Color(color);
    furCache.set(color, new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.95, sheen: 1, sheenRoughness: 0.4, sheenColor: c.clone().lerp(new THREE.Color(0xffffff), 0.6) }));
  }
  return furCache.get(color);
}

// 아기 같은 비율: 통통한 몸, 아래쪽에 크고 반짝이는 눈, 볼터치, ω 입, 짧은 팔다리
function makePlush(kind, r) {
  const k = KINDS[kind];
  const g = new THREE.Group();
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const part = (geo, mat, pos, scale, rot, parent = g) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(pos);
    if (typeof scale === 'number') m.scale.setScalar(scale);
    else m.scale.copy(scale);
    if (rot) m.rotation.set(...rot);
    const big = typeof scale === 'number' ? scale : Math.max(scale.x, scale.y, scale.z);
    m.castShadow = big >= r * 0.18; // 자잘한 건 그림자 생략
    parent.add(m);
    return m;
  };
  // 몸 표면 위의 점 (몸은 위아래로 살짝 눌린 공)
  const on = (x, y, z, s = 1) => {
    const v = V(x, y, z).normalize();
    v.multiply(V(r * 1.02, r * 0.92, r * 0.98)).multiplyScalar(s);
    return v;
  };
  const base = fur(k.color);
  const paw = fur(k.paw ?? k.color);
  const body = part(SPH, base, V(0, 0, 0), V(r * 1.02, r * 0.92, r * 0.98));
  body.receiveShadow = true;
  if (k.belly) part(SPH_S, fur(k.belly), on(0, -0.5, 0.86, 0.9), V(r * 0.5, r * 0.4, r * 0.2));

  // 짧은 발 + 앞발
  for (const s of [-1, 1]) {
    part(SPH_S, paw, V(s * r * 0.4, -r * 0.8, r * 0.42), V(r * 0.21, r * 0.14, r * 0.24));
    if (!k.wings) part(SPH_S, paw, on(s * 0.78, -0.38, 0.5, 0.97), V(r * 0.14, r * 0.2, r * 0.14), [0.4, 0, s * 0.6]);
  }

  // 얼굴: 크고 낮게 붙은 눈 + 하이라이트 두 개 + 볼터치
  const eyes = (y = -0.02, gap = 0.36, size = 0.12) => {
    for (const s of [-1, 1]) {
      part(SPH_S, black, on(s * gap, y, 0.92, 0.97), V(r * size, r * size * 1.15, r * size * 0.6));
      part(SPH_S, white, on(s * gap - 0.05, y + 0.08, 0.92, 1.02), r * size * 0.38);
      part(SPH_S, white, on(s * gap + 0.04, y - 0.06, 0.92, 1.02), r * size * 0.18);
      part(SPH_S, cheekMat, on(s * (gap + 0.24), y - 0.2, 0.8, 0.985), V(r * 0.15, r * 0.085, r * 0.04));
    }
  };
  // ω 입 (작은 반원 두 개)
  const mouth = (y = -0.24, z = 1, s0 = 0.985, size = 0.055) => {
    for (const s of [-1, 1]) part(MOUTH, black, on(s * size * 1.05, y, z, s0), r * size, [0, 0, Math.PI]);
  };

  if (kind === 'bear') {
    eyes();
    for (const s of [-1, 1]) {
      part(SPH_S, base, on(s * 0.62, 0.74, 0.05, 0.92), r * 0.3);
      part(SPH_S, fur(0xf3d6b4), on(s * 0.64, 0.76, 0.24, 0.99), V(r * 0.17, r * 0.17, r * 0.07));
    }
    part(SPH_S, fur(0xf6e2c6), on(0, -0.26, 1, 0.9), V(r * 0.27, r * 0.19, r * 0.17));
    part(SPH_S, black, on(0, -0.17, 1, 1.06), V(r * 0.075, r * 0.055, r * 0.05));
    mouth(-0.3, 1, 1.05, 0.05);
    part(SPH_S, base, V(0, -r * 0.35, -r * 0.95), r * 0.13); // 꼬리
  } else if (kind === 'bunny') {
    eyes();
    for (const s of [-1, 1]) {
      part(SPH_S, base, V(s * r * 0.3, r * 1.22, -r * 0.05), V(r * 0.17, r * 0.52, r * 0.13), [0, 0, -s * 0.15]);
      part(SPH_S, fur(0xffbfd0), V(s * r * 0.31, r * 1.18, r * 0.06), V(r * 0.085, r * 0.38, r * 0.05), [0, 0, -s * 0.15]);
    }
    // 리본
    const bow = new THREE.Group();
    bow.position.copy(V(r * 0.42, r * 0.82, r * 0.12));
    bow.rotation.z = -0.4;
    for (const s of [-1, 1]) part(CONE, pinkMat, V(s * r * 0.11, 0, 0), V(r * 0.09, r * 0.11, r * 0.06), [0, 0, s * Math.PI / 2], bow);
    part(SPH_S, pinkMat, V(0, 0, 0), r * 0.05, null, bow);
    g.add(bow);
    part(SPH_S, pinkMat, on(0, -0.13, 1, 1.0), V(r * 0.055, r * 0.04, r * 0.04));
    mouth(-0.22);
    part(SPH_S, fur(0xffffff), V(0, -r * 0.4, -r * 0.95), r * 0.17); // 솜꼬리
  } else if (kind === 'chick') {
    eyes(0.02, 0.34);
    part(CONE, new THREE.MeshStandardMaterial({ color: 0xff9a2e, roughness: 0.5 }), on(0, -0.12, 1, 1.04), V(r * 0.1, r * 0.13, r * 0.1), [Math.PI / 2, 0, 0]);
    for (let i = -1; i <= 1; i++) part(SPH_S, base, V(i * r * 0.1, r * 0.96, 0), V(r * 0.05, r * 0.17, r * 0.05), [0, 0, -i * 0.55]);
    for (const s of [-1, 1]) part(SPH_S, fur(0xffcf3a), V(s * r * 0.95, -r * 0.12, 0), V(r * 0.12, r * 0.3, r * 0.24), [0, 0, s * 0.35]);
  } else if (kind === 'frog') {
    for (const s of [-1, 1]) {
      part(SPH_S, base, V(s * r * 0.42, r * 0.74, r * 0.22), r * 0.3);
      part(SPH_S, white, V(s * r * 0.42, r * 0.78, r * 0.44), V(r * 0.21, r * 0.21, r * 0.1));
      part(SPH_S, black, V(s * r * 0.42, r * 0.77, r * 0.52), V(r * 0.11, r * 0.13, r * 0.05));
      part(SPH_S, white, V(s * r * 0.38, r * 0.83, r * 0.56), r * 0.035);
      part(SPH_S, cheekMat, on(s * 0.6, -0.12, 0.78, 0.985), V(r * 0.15, r * 0.085, r * 0.04));
    }
    part(new THREE.TorusGeometry(1, 0.08, 6, 20, Math.PI), black, on(0, 0.02, 1, 0.95), r * 0.26, [0, 0, Math.PI]);
  } else if (kind === 'pig') {
    eyes(0.04, 0.38);
    part(new THREE.CylinderGeometry(1, 1, 1, 24), fur(0xff9dbb), on(0, -0.18, 1, 0.97), V(r * 0.23, r * 0.13, r * 0.17), [Math.PI / 2, 0, 0]);
    for (const s of [-1, 1]) {
      part(SPH_S, fur(0xd8668b), on(s * 0.08, -0.17, 1, 1.07), V(r * 0.035, r * 0.055, r * 0.03));
      part(CONE4, base, on(s * 0.52, 0.8, 0.15, 0.95), r * 0.16, [0.4, 0, -s * 0.5]);
    }
    part(new THREE.TorusGeometry(1, 0.3, 6, 16, Math.PI * 1.6), fur(0xff9dbb), V(0, -r * 0.25, -r * 0.98), r * 0.09, [0, Math.PI / 2, 0]);
  } else if (kind === 'cat') {
    eyes();
    for (const s of [-1, 1]) {
      part(CONE4, base, on(s * 0.55, 0.82, 0.05, 0.9), r * 0.2, [0, Math.PI / 4, -s * 0.35]);
      part(CONE4, fur(0xffd6b8), on(s * 0.55, 0.8, 0.26, 0.93), r * 0.11, [0.2, Math.PI / 4, -s * 0.35]);
    }
    for (const x of [-0.12, 0, 0.12]) part(SPH_S, fur(0xd98031), on(x, 0.62, 0.78, 0.99), V(r * 0.035, r * 0.12, r * 0.03));
    part(SPH_S, pinkMat, on(0, -0.14, 1, 1.0), V(r * 0.05, r * 0.035, r * 0.035));
    mouth(-0.22);
    part(new THREE.TorusGeometry(1, 0.18, 6, 16, Math.PI), base, V(r * 0.5, -r * 0.45, -r * 0.82), r * 0.3, [0, -0.4, 0]); // 꼬리
  } else if (kind === 'puppy') {
    eyes();
    part(SPH_S, fur(0xc48a5a), on(0.36, 0.08, 0.9, 0.96), V(r * 0.22, r * 0.24, r * 0.1)); // 눈 얼룩
    for (const s of [-1, 1]) part(SPH_S, fur(0xb57c4f), V(s * r * 0.82, r * 0.25, 0), V(r * 0.16, r * 0.4, r * 0.24), [0, 0, s * 0.35]); // 늘어진 귀
    part(SPH_S, fur(0xfff4e2), on(0, -0.26, 1, 0.9), V(r * 0.26, r * 0.18, r * 0.16));
    part(SPH_S, black, on(0, -0.16, 1, 1.06), V(r * 0.08, r * 0.06, r * 0.05));
    mouth(-0.3, 1, 1.05, 0.05);
    part(SPH_S, pinkMat, on(0, -0.42, 1, 0.99), V(r * 0.06, r * 0.07, r * 0.03)); // 혀
    part(SPH_S, base, V(0, -r * 0.2, -r * 0.98), V(r * 0.08, r * 0.2, r * 0.08), [-0.6, 0, 0]); // 꼬리
  } else if (kind === 'dopa') {
    body.material = new THREE.MeshPhysicalMaterial({ color: k.color, roughness: 0.8, sheen: 1, sheenColor: new THREE.Color(0xffffff), emissive: 0x4d6600, emissiveIntensity: 0.35 });
    eyes();
    mouth(-0.24);
    const crown = new THREE.Group();
    crown.position.set(0, r * 0.88, 0);
    crown.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.32, r * 0.36, r * 0.18, 16, 1, true), M.gold));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(r * 0.08, r * 0.2, 6), M.gold);
      spike.position.set(Math.cos(a) * r * 0.32, r * 0.17, Math.sin(a) * r * 0.32);
      crown.add(spike);
    }
    crown.traverse((o) => { o.castShadow = true; });
    g.add(crown);
  }
  return g;
}

// ------------------------------------------------------------------ 인형 물리
let prizes = [];
let nextId = 1;
function addPrize(kind, x, y, z) {
  const r = kind === 'dopa' ? 0.27 : rand(0.27, 0.32);
  const inner = makePlush(kind, r);
  inner.rotation.z = rand(-0.16, 0.16); // 갸웃
  const mesh = new THREE.Group();
  mesh.add(inner);
  mesh.rotation.y = rand(-0.6, 0.6);
  scene.add(mesh);
  const p = { id: nextId++, kind, r, mesh, p: new THREE.Vector3(x, y, z), q: new THREE.Vector3(x, y, z), state: 'free', spin: rand(-1, 1), tilt: 0, contact: false };
  prizes.push(p);
  return p;
}
function randomSpot() {
  for (;;) {
    const x = rand(BOX.x0 + 0.3, BOX.x1 - 0.3);
    const z = rand(BOX.z0 + 0.3, BOX.z1 - 0.3);
    if (x < CHUTE.x1 + 0.35 && z > CHUTE.z0 - 0.35) continue;
    return [x, z];
  }
}
function fillPrizes(count, from = 0.6) {
  const free = prizes.filter((p) => p.state === 'free').length;
  const add = [];
  const hasRare = prizes.some((p) => p.kind === 'dopa' && p.state !== 'gone');
  for (let i = free; i < count; i++) {
    const [x, z] = randomSpot();
    const kind = !hasRare && !add.includes('dopa') && Math.random() < 0.6 ? 'dopa' : pickKind();
    add.push(kind);
    addPrize(kind, x, from + (i - free) * 0.35, z);
  }
}

const SUB = 1 / 120;
const clawObstacle = { on: false, p: new THREE.Vector3(), r: 0.16 };
const tmp = new THREE.Vector3();

function physicsStep(dt) {
  const free = prizes.filter((p) => p.state === 'free');
  for (const a of free) {
    tmp.subVectors(a.p, a.q).multiplyScalar(0.992);
    // 바닥에 닿으면 마찰 크게, 인형 위에 올라탄 상태면 살짝만 (굴러 떨어지도록)
    const f = a.contact ? 0.86 : a.stack ? 0.97 : 1;
    tmp.x *= f;
    tmp.z *= f;
    if ((a.contact || a.stack) && tmp.lengthSq() < 4e-8) tmp.set(0, 0, 0);
    // 밀어내기 보정이 속도로 바뀌어 튕겨 나가지 않게 속도 상한
    const vmax = 4 * dt;
    const vl = tmp.length();
    if (vl > vmax) tmp.multiplyScalar(vmax / vl);
    a.q.copy(a.p);
    a.p.add(tmp);
    a.p.y -= G * dt * dt;
    a.contact = false;
    a.stack = false;
  }
  const held = prizes.filter((p) => p.state === 'held');
  for (let it = 0; it < 4; it++) {
    for (let i = 0; i < free.length; i++) {
      const a = free[i];
      for (let j = i + 1; j < free.length; j++) {
        const b = free[j];
        tmp.subVectors(b.p, a.p);
        const d2 = tmp.lengthSq();
        const min = (a.r + b.r) * 0.96;
        if (d2 >= min * min || d2 === 0) continue;
        const d = Math.sqrt(d2);
        tmp.multiplyScalar((min - d) / d / 2);
        a.p.sub(tmp);
        b.p.add(tmp);
        if (tmp.y > 0) b.stack = true; else a.stack = true;
      }
      for (const h of held) {
        tmp.subVectors(a.p, h.p);
        const d = tmp.length();
        const min = (a.r + h.r) * 0.96;
        if (d < min && d > 0) {
          a.p.addScaledVector(tmp, (min - d) / d);
          if (tmp.y > 0) a.stack = true;
        }
      }
      // 집게 옆에 있는 인형만 살짝 밀림 (집게가 올라탄 바로 아래 인형은 안 밀림)
      if (clawObstacle.on && a.p.y > clawObstacle.p.y - a.r * 0.3) {
        tmp.subVectors(a.p, clawObstacle.p);
        tmp.y = Math.max(0, tmp.y) * 0.3;
        const d = tmp.length();
        const min = a.r + clawObstacle.r;
        if (d < min && d > 1e-4) a.p.addScaledVector(tmp, Math.min(0.0005, (min - d) * 0.1) / d);
      }
      constrainBox(a);
    }
  }
}

function inChute(p) {
  return p.p.x < CHUTE.x1 && p.p.z > CHUTE.z0;
}
function constrainBox(a) {
  const r = a.r;
  if (inChute(a)) {
    // 구멍 안: 바닥 없음, 배출구 벽 안쪽으로만
    a.p.x = clamp(a.p.x, CHUTE.x0 + r * 0.7, CHUTE.x1 - r * 0.7);
    a.p.z = clamp(a.p.z, CHUTE.z0 + r * 0.7, CHUTE.z1 - r * 0.7);
    if (a.p.y < CHUTE.h) a.state = 'chute';
    return;
  }
  if (a.p.y < r) { a.p.y = r; a.contact = true; }
  if (a.p.y > BOX.top - r) a.p.y = BOX.top - r;
  a.p.x = clamp(a.p.x, BOX.x0 + r, BOX.x1 - r);
  a.p.z = clamp(a.p.z, BOX.z0 + r, BOX.z1 - r);
  // 배출구 벽(상자)과 충돌
  const cx = clamp(a.p.x, CHUTE.x0, CHUTE.x1);
  const cy = clamp(a.p.y, 0, CHUTE.h);
  const cz = clamp(a.p.z, CHUTE.z0, CHUTE.z1);
  tmp.set(a.p.x - cx, a.p.y - cy, a.p.z - cz);
  const d = tmp.length();
  if (d < r && d > 1e-6) {
    a.p.addScaledVector(tmp, (r - d) / d);
    if (tmp.y > 0) a.contact = true;
  }
}

// (x, z) 지점에서 인형 더미의 맨 위 높이. pad = 그 지점에 닿는 물체의 굵기
function surfaceAt(x, z, pad = 0.05) {
  let top = 0;
  for (const p of prizes) {
    if (p.state !== 'free') continue;
    const dh = Math.hypot(p.p.x - x, p.p.z - z);
    const rr = p.r + pad;
    if (dh < rr) top = Math.max(top, p.p.y + Math.sqrt(rr * rr - dh * dh) - pad);
  }
  if (x < CHUTE.x1 + pad && z > CHUTE.z0 - pad) top = Math.max(top, CHUTE.h);
  return top;
}
const surfaceUnder = (x, z) => surfaceAt(x, z, 0.05);

// ------------------------------------------------------------------ 게임 상태
const game = {
  phase: 'boot', // boot | idle | play | down | close | up | carry | release | settle | over
  coins: COINS,
  caught: [],
  left: PLAY_SECS,
  t: 0,
  missStreak: 0,
  last: null,
  msg: null,
};
// x/z = 레일 위 캐리지 위치, wx/wz = 실제 집게 위치 (줄에 매달려 흔들림 sw 만큼 어긋남)
const cl = {
  x: HOME.x, z: HOME.z, y: CLAW_TOP, vx: 0, vz: 0, open: 1, held: null, plan: null, grabY: 0, sway: 0,
  wx: HOME.x, wz: HOME.z, bob: 0, bobV: 0, loose: 0,
};
const sw = { x: 0, z: 0, vx: 0, vz: 0 };
const input = { pad: { x: 0, z: 0 }, keys: new Set() };
let room = null;
let padOn = SOLO;

function publish() {
  const state = {
    phase: game.phase,
    coins: game.coins,
    caught: game.caught.length,
    prizes: game.caught.map((c) => c.kind),
    left: Math.ceil(game.left),
    last: game.last,
    msg: game.msg,
  };
  if (SOLO) dispatchEvent(new CustomEvent('claw:state', { detail: state }));
  if (!room) return;
  room.setState({
    phase: game.phase,
    coins: game.coins,
    caught: game.caught.length,
    prizes: game.caught.map((c) => c.kind),
    left: Math.ceil(game.left),
    last: game.last,
    msg: game.msg,
  });
}

function setPhase(ph) {
  game.phase = ph;
  game.t = 0;
  publish();
  renderHud();
}

function insertCoin() {
  if (game.phase !== 'idle' || game.coins <= 0) return;
  game.coins--;
  game.left = PLAY_SECS;
  game.msg = null;
  sfx.coin();
  setTimeout(sfx.start, 250);
  pressBtn();
  banner('🕹️ START!', 'go');
  setPhase('play');
}
function dropClaw() {
  if (game.phase !== 'play') return;
  sfx.drop();
  pressBtn();
  setPhase('down');
}
function resetGame() {
  if (game.phase !== 'over' && game.phase !== 'idle') return;
  game.coins = COINS;
  game.caught = [];
  game.last = null;
  game.msg = null;
  game.missStreak = 0;
  fillPrizes(PRIZE_COUNT, 3.2);
  hideResult();
  setPhase('idle');
}

let btnPress = 0;
function pressBtn() { btnPress = 1; }

// ------------------------------------------------------------------ 진행 루프
const CABLE_TOP = 2.83;
function update(dt) {
  game.t += dt;
  const ph = game.phase;
  const pvx = cl.vx;
  const pvz = cl.vz;

  // 입력 → 속도
  let ix = input.pad.x;
  let iz = input.pad.z;
  const k = input.keys;
  if (k.size) {
    ix = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
    iz = (k.has('down') ? 1 : 0) - (k.has('up') ? 1 : 0);
  }
  if (view.mode === 'claw' && Math.abs(view.yaw) > 0.01) {
    // 집게 카메라를 돌려 봤으면 조이스틱 방향도 화면 기준으로
    const c = Math.cos(view.yaw);
    const s = Math.sin(view.yaw);
    [ix, iz] = [ix * c + iz * s, -ix * s + iz * c];
  }
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }
  if (ph !== 'play') { ix = 0; iz = 0; }
  stick.rotation.z += (-ix * 0.45 - stick.rotation.z) * Math.min(1, dt * 14);
  stick.rotation.x += (iz * 0.45 - stick.rotation.x) * Math.min(1, dt * 14);

  if (ph === 'play') {
    const a = Math.min(1, dt * 12);
    cl.vx += (ix * SPEED - cl.vx) * a;
    cl.vz += (iz * SPEED - cl.vz) * a;
    const nx = clamp(cl.x + cl.vx * dt, MOVE.x0, MOVE.x1);
    const nz = clamp(cl.z + cl.vz * dt, MOVE.z0, MOVE.z1);
    if (nx !== cl.x + cl.vx * dt) cl.vx = 0; // 끝에 부딪히면 탁 멈춤 → 흔들림
    if (nz !== cl.z + cl.vz * dt) cl.vz = 0;
    cl.x = nx;
    cl.z = nz;
    sfx.motor(Math.min(1, Math.hypot(cl.vx, cl.vz) / SPEED));
    const before = Math.ceil(game.left);
    game.left -= dt;
    const now = Math.ceil(game.left);
    if (now !== before) {
      if (now <= 5 && now > 0) sfx.tick(now <= 3);
      publish();
      renderHud();
    }
    if (game.left <= 0) { game.left = 0; dropClaw(); }
  } else if (ph === 'down') {
    sfx.motor(0.4);
    cl.vx = cl.vz = 0;
    cl.y -= 0.85 * dt;
    // 집게발 끝이나 허브 바닥이 인형 더미에 닿으면 거기서 멈춤 (맨 아래까지 못 내려감)
    const tl = tipLocal(cl.open);
    const tipY = cl.y + tl.dy;
    // 인형은 말랑해서 집게발이 조금 파고든 뒤에 멈춤
    let hit = cl.y - 0.1 <= surfaceAt(cl.wx, cl.wz, 0.08) - 0.04 || tipY <= 0.04;
    for (const a of PRONG_YAW) {
      const px = cl.wx + Math.sin(a) * tl.rr;
      const pz = cl.wz + Math.cos(a) * tl.rr;
      if (tipY <= surfaceAt(px, pz, 0.02) - 0.12) hit = true;
    }
    if (hit) {
      sfx.motor(0);
      sfx.thud();
      cl.bobV = -0.25; // 줄이 살짝 출렁
      cl.target = findTarget();
      setPhase('close');
    }
  } else if (ph === 'close') {
    const to = cl.target ? 0.62 : 0;
    cl.open = Math.max(to, 1 - game.t / 0.55);
    if (game.t >= 0.55) {
      tryGrab();
      setPhase('up');
    }
  } else if (ph === 'up') {
    sfx.motor(0.5);
    cl.y = Math.min(CLAW_TOP, cl.y + 0.75 * dt);
    if (cl.held && cl.plan) {
      const risen = cl.y - cl.grabY;
      if ((cl.plan.tease && risen > 0.2) || (cl.plan.slip === 'up' && risen > cl.plan.at)) letGo(true);
    }
    if (cl.y >= CLAW_TOP) {
      // 쾅! 꼭대기에 부딪히면서 덜컹, 집게 힘이 풀려 인형이 주르륵
      cl.y = CLAW_TOP;
      sfx.motor(0);
      sfx.clunk();
      view.shake = 0.05;
      cl.bobV = 0.9;
      sw.vx += rand(-0.5, 0.5);
      sw.vz += rand(-0.35, 0.35);
      if (cl.held) {
        cl.loose = 0.1;
        cl.held.goal.y -= rand(0.06, 0.12);
        cl.held.goal.x *= 1.4;
        cl.held.goal.z *= 1.4;
      }
      setPhase('top');
    }
  } else if (ph === 'top') {
    if (cl.held && cl.plan?.slip === 'top' && game.t > 0.18) letGo(true);
    if (game.t >= 0.75) setPhase('carry');
  } else if (ph === 'carry') {
    const dx = HOME.x - cl.x;
    const dz = HOME.z - cl.z;
    const d = Math.hypot(dx, dz);
    const sp = Math.min(0.8, d * 2.2 + 0.05); // 출발·도착은 부드럽게
    const a = Math.min(1, dt * 4);
    sfx.motor(d > 0.01 ? 0.7 : 0);
    if (d <= 0.01) {
      cl.x = HOME.x; cl.z = HOME.z; cl.vx = cl.vz = 0;
      setPhase('release');
    } else {
      cl.vx += ((dx / d) * sp - cl.vx) * a;
      cl.vz += ((dz / d) * sp - cl.vz) * a;
      const st = Math.min(d, Math.hypot(cl.vx, cl.vz) * dt);
      const vl = Math.hypot(cl.vx, cl.vz) || 1;
      cl.x += (cl.vx / vl) * st;
      cl.z += (cl.vz / vl) * st;
      if (cl.held && cl.plan?.slip === 'carry' && d < cl.plan.at) letGo(true);
      // 옮기는 동안에도 조금씩 흘러내림
      if (cl.held) cl.held.goal.y = Math.max(cl.held.goal.y - dt * 0.03, -(0.22 + cl.held.r * 0.95) - 0.2);
    }
  } else if (ph === 'release') {
    sfx.motor(0);
    cl.open = Math.min(1, game.t / 0.4);
    if (game.t > 0.15 && cl.held) letGo(false);
    if (game.t >= 0.5) setPhase('settle');
  } else if (ph === 'settle') {
    const busy = prizes.some((p) => p.state === 'chute');
    if (game.t > 1.4 && !busy) {
      if (!game.roundWon) {
        game.missStreak++;
        game.msg = '아깝다!';
        sfx.miss();
        banner('😢 아깝다!', 'miss');
      }
      game.roundWon = false;
      setPhase(game.coins > 0 ? 'idle' : 'over');
      if (game.phase === 'over') showResult();
    }
  }

  // 올라가거나 옮기는 중: 쥔 게 있으면 감싼 채로(쾅 이후엔 헐겁게), 놓쳤으면 빈 집게를 오므림
  if (ph === 'up' || ph === 'top' || ph === 'carry') {
    const to = cl.held ? 0.62 + cl.loose : 0;
    cl.open += (to - cl.open) * Math.min(1, dt * 10);
  }

  // ---- 진자: 캐리지가 가속하면 줄에 매달린 집게가 반대로 흔들림
  const L = Math.max(0.2, CABLE_TOP - cl.y) + 0.3;
  let ax = (cl.vx - pvx) / Math.max(dt, 1e-4);
  let az = (cl.vz - pvz) / Math.max(dt, 1e-4);
  ax = clamp(ax, -14, 14);
  az = clamp(az, -14, 14);
  const w2 = G / L;
  const damp = game.phase === 'down' || game.phase === 'close' ? 3 : cl.held ? 0.9 : 0.6;
  sw.vx += (-w2 * sw.x - ax - damp * sw.vx) * dt;
  sw.vz += (-w2 * sw.z - az - damp * sw.vz) * dt;
  sw.x += sw.vx * dt;
  sw.z += sw.vz * dt;
  const MAXS = 0.24;
  const sl = Math.hypot(sw.x, sw.z);
  if (sl > MAXS) { sw.x *= MAXS / sl; sw.z *= MAXS / sl; sw.vx *= 0.5; sw.vz *= 0.5; }
  // 유리벽 밖으로는 못 나감
  cl.wx = clamp(cl.x + sw.x, BOX.x0 + 0.25, BOX.x1 - 0.25);
  cl.wz = clamp(cl.z + sw.z, BOX.z0 + 0.25, BOX.z1 - 0.25);
  cl.sway = Math.hypot(sw.vx, sw.vz);

  // 줄 출렁 (쾅/닿음)
  cl.bobV += (-90 * cl.bob - 9 * cl.bobV) * dt;
  cl.bob += cl.bobV * dt;

  // 잡은 인형 따라오기 (집게 기울기만큼 더 쏠림)
  if (cl.held) {
    const h = cl.held;
    const tgt = h.offset;
    tgt.lerp(h.goal, Math.min(1, dt * (game.phase === 'top' ? 9 : 6)));
    const lean = -tgt.y / L;
    h.p.set(cl.wx + tgt.x + sw.x * lean, cl.y + cl.bob + tgt.y, cl.wz + tgt.z + sw.z * lean);
    h.q.copy(h.p);
  }

  // 물리 (서브스텝)
  clawObstacle.on = (game.phase === 'down' || game.phase === 'close') && cl.y - TIP < 1.2;
  clawObstacle.p.set(cl.wx, cl.y - TIP + 0.1, cl.wz);
  let acc = dt;
  while (acc > 1e-6) {
    const s = Math.min(SUB, acc);
    physicsStep(s);
    acc -= s;
  }

  // 배출구에 떨어진 인형
  for (const p of prizes) {
    if (p.state === 'chute') {
      p.vy = (p.vy || 0) - G * dt;
      p.p.y += p.vy * dt;
      if (p.p.y < -0.6) award(p);
    }
  }
  if (game.phase !== 'boot') {
    for (const p of prizes) {
      if (p.state === 'free' && !inChute(p) && p.p.y < -1) p.p.set(0, 1.5, 0); // 안전장치
    }
  }
}

function findTarget() {
  const tipY = cl.y + tipLocal(cl.open).dy;
  let best = null;
  let bestScore = -Infinity;
  for (const p of prizes) {
    if (p.state !== 'free') continue;
    const dh = Math.hypot(p.p.x - cl.wx, p.p.z - cl.wz);
    if (dh > p.r * 1.25) continue;
    if (p.p.y + p.r < tipY - 0.15 || p.p.y - p.r > tipY + 0.3) continue;
    const score = p.p.y - dh * 1.5;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

function tryGrab() {
  const best = cl.target && cl.target.state === 'free' ? cl.target : findTarget();
  cl.target = null;
  cl.loose = 0;
  sfx.grab();
  if (!best) { cl.plan = null; return; }
  const off = Math.hypot(best.p.x - cl.wx, best.p.z - cl.wz) / best.r;
  // 집게발이 인형 꼭대기보다 한참 위에서 멈췄으면(더미에 걸림) 헛손질하기 쉬움
  const tipY = cl.y + tipLocal(1).dy;
  const gap = Math.max(0, tipY - (best.p.y + best.r * 0.4));
  // 위에 다른 인형이 올라타 있으면 잘 안 잡힘
  const buried = prizes.some((o) => o !== best && o.state === 'free' && o.p.y > best.p.y + best.r * 0.5 && Math.hypot(o.p.x - best.p.x, o.p.z - best.p.z) < best.r + o.r * 0.6);
  let p = 0.92 - 0.75 * off * off;
  p *= clamp(1 - gap / 0.5, 0.3, 1);
  if (KINDS[best.kind].rare) p *= 0.75;
  if (buried) p *= 0.55;
  const pity = game.missStreak >= 3;
  if (pity) p = Math.max(p, 0.8);
  const grabbed = Math.random() < p;
  let slip = null;
  let at = 0;
  if (grabbed && !pity && Math.random() < 0.24 + 0.4 * off) {
    const r = Math.random();
    if (r < 0.5) slip = 'top'; // 쾅 하면서 툭
    else if (r < 0.7) { slip = 'up'; at = rand(0.3, 1.2); }
    else { slip = 'carry'; at = rand(0.15, 1.2); }
  }
  cl.plan = { tease: !grabbed, slip, at };
  cl.grabY = cl.y;
  best.state = 'held';
  best.offset = new THREE.Vector3(best.p.x - cl.wx, best.p.y - cl.y, best.p.z - cl.wz);
  best.goal = new THREE.Vector3(best.offset.x * 0.4, -(0.22 + best.r * 0.95), best.offset.z * 0.4);
  cl.held = best;
}

function letGo(slipped) {
  const h = cl.held;
  if (!h) return;
  cl.held = null;
  h.state = 'free';
  h.q.copy(h.p);
  // 집게가 흔들리던 속도 그대로 날아감
  h.q.x -= (cl.vx + sw.vx) * SUB;
  h.q.z -= (cl.vz + sw.vz) * SUB;
  if (slipped) {
    sfx.slip();
    if (!cl.plan?.tease) banner('앗! 미끄러졌다', 'miss', 900);
  }
  cl.plan = null;
}

function award(p) {
  if (game.phase === 'boot') {
    // 아직 게임 전: 쌓다가 넘친 인형은 다시 위에서 떨어뜨림
    const [x, z] = randomSpot();
    p.state = 'free';
    p.vy = 0;
    p.p.set(x, 2.2, z);
    p.q.copy(p.p);
    return;
  }
  p.state = 'gone';
  scene.remove(p.mesh);
  prizes = prizes.filter((x) => x !== p);
  const k = KINDS[p.kind];
  game.caught.push({ kind: p.kind });
  game.last = { id: p.id, kind: p.kind, name: k.name, emoji: k.emoji };
  game.msg = null;
  game.missStreak = 0;
  if (['release', 'settle', 'carry', 'up', 'top'].includes(game.phase)) game.roundWon = true;
  sfx.win();
  banner(`${k.emoji} GET! ${k.name}`, k.rare ? 'rare' : 'win', 2200);
  popOut(p.kind, p.r);
  confetti(k.rare ? 80 : 44);
  publish();
  renderHud();
}

// 배출구 문에서 인형이 '뽁' 나오는 연출
const pops = [];
function popOut(kind, r) {
  const m = makePlush(kind, r * 0.8);
  m.position.set(HOME.x, -0.75, 1.2);
  scene.add(m);
  pops.push({ m, t: 0 });
}

// ------------------------------------------------------------------ 그리기
function draw(dt, now) {
  // 집게: 줄 끝에 매달려 기울어짐
  const cy = cl.y + cl.bob;
  claw.position.set(cl.wx, cy, cl.wz);
  const L = Math.max(0.2, CABLE_TOP - cy) + 0.3;
  claw.rotation.z = Math.atan2(cl.wx - cl.x, L);
  claw.rotation.x = -Math.atan2(cl.wz - cl.z, L);
  setOpen(cl.open);
  bridge.position.z = cl.z;
  carriage.position.set(cl.x, 2.86, cl.z);
  // 줄: 캐리지 → 집게 꼭대기
  cableA.set(cl.x, CABLE_TOP, cl.z);
  cableB.set(cl.wx, cy + 0.14, cl.wz);
  cableDir.subVectors(cableA, cableB);
  const clen = Math.max(0.01, cableDir.length());
  cable.position.addVectors(cableA, cableB).multiplyScalar(0.5);
  cable.scale.set(1, clen, 1);
  cable.quaternion.setFromUnitVectors(UP, cableDir.normalize());

  ring.visible = game.phase === 'play';
  if (ring.visible) {
    ring.position.set(cl.wx, surfaceUnder(cl.wx, cl.wz) + 0.02, cl.wz);
    ring.material.opacity = 0.35 + Math.sin(now / 160) * 0.2;
  }

  for (const p of prizes) {
    p.mesh.position.copy(p.p);
    if (p.state === 'held') {
      p.mesh.rotation.z = claw.rotation.z * 1.3;
      p.mesh.rotation.x = claw.rotation.x * 1.3;
    } else {
      p.mesh.rotation.z *= 0.9;
      p.mesh.rotation.x *= 0.9;
    }
  }

  btnPress = Math.max(0, btnPress - dt * 4);
  btnTop.position.y = -0.06 - btnPress * 0.025;

  // 전구 체이스
  const chase = Math.floor(now / (game.phase === 'play' ? 90 : 180));
  bulbs.forEach((m, i) => { m.emissiveIntensity = (i + chase) % 3 === 0 ? 2.2 : 0.35; });

  for (let i = pops.length - 1; i >= 0; i--) {
    const o = pops[i];
    o.t += dt;
    const t = o.t;
    o.m.position.z = 1.2 + Math.min(1, t * 3) * 0.35;
    o.m.position.y = -0.75 + Math.sin(Math.min(1, t * 2.2) * Math.PI) * 0.35 - Math.max(0, t - 2) * 2;
    o.m.rotation.y = Math.sin(t * 6) * 0.3;
    flap.rotation.x = -Math.max(0, 1 - t * 1.5) * 1.1;
    if (t > 2.6) { scene.remove(o.m); pops.splice(i, 1); }
  }
  applyCamera(dt);
  renderer.render(scene, camera);
}
const UP = new THREE.Vector3(0, 1, 0);
const cableA = new THREE.Vector3();
const cableB = new THREE.Vector3();
const cableDir = new THREE.Vector3();

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  draw(dt, now);
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ HUD
function renderHud() {
  $('coins').innerHTML = Array.from({ length: COINS }, (_, i) => `<i class="${i < game.coins ? 'on' : ''}">🪙</i>`).join('');
  const ph = game.phase;
  const timer = $('timer');
  timer.textContent = ph === 'play' ? Math.ceil(game.left) : '--';
  timer.classList.toggle('hurry', ph === 'play' && game.left <= 5);
  $('shelf').innerHTML = game.caught.length
    ? game.caught.map((c) => `<span class="${KINDS[c.kind].rare ? 'rare' : ''}" title="${KINDS[c.kind].name}">${KINDS[c.kind].emoji}</span>`).join('')
    : '<em>아직 없어요</em>';
  $('caughtCount').textContent = game.caught.length;
  const hint = {
    idle: game.coins > 0 ? (padOn ? '폰에서 🪙 코인을 넣어주세요' : '폰을 연결하거나 Enter 로 코인 투입') : '',
    play: '조이스틱으로 움직이고 뽑기!',
    down: '내려가는 중…', close: '집는 중…', up: '올라가는 중…', top: '쾅!', carry: '두근두근…', release: '두근두근…', settle: '…',
    over: '게임 끝!',
  }[ph] || '';
  $('hint').textContent = hint;
}

let bannerTimer;
function banner(text, kind = 'win', ms = 1500) {
  const b = $('banner');
  b.textContent = text;
  b.className = `banner show ${kind}`;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
}

function confetti(n) {
  const layer = $('confetti');
  const colors = ['#D9FF44', '#FF6C91', '#86EFC8', '#FFD36B', '#ffffff'];
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    s.style.left = `${50 + rand(-8, 8)}%`;
    s.style.background = colors[i % colors.length];
    s.style.setProperty('--dx', `${rand(-45, 45)}vw`);
    s.style.setProperty('--dy', `${rand(-70, -25)}vh`);
    s.style.setProperty('--r', `${rand(-720, 720)}deg`);
    s.style.animationDelay = `${rand(0, 0.15)}s`;
    layer.appendChild(s);
    setTimeout(() => s.remove(), 2200);
  }
}

function showResult() {
  sfx.over();
  const n = game.caught.length;
  $('resultArt').textContent = n ? game.caught.map((c) => KINDS[c.kind].emoji).join('') : '🫥';
  $('resultTitle').textContent = n === 0 ? '빈손이에요…' : n >= 3 ? '인형뽑기 장인!' : '득템 성공!';
  $('resultStat').textContent = `${COINS}판 중 ${n}개 GET`;
  $('result').classList.add('show');
  window.DopaSharp?.track('game_complete', { score: n });
}
function hideResult() { $('result').classList.remove('show'); }

function setPad(on) {
  padOn = on;
  $('padDot').className = `dot ${on ? 'on' : 'off'}`;
  $('padText').textContent = on ? '조종기 연결됨' : '조종기를 기다리는 중…';
  if (on) {
    $('qrOverlay').classList.remove('show');
  } else {
    input.pad.x = input.pad.z = 0;
  }
  renderHud();
}

// ------------------------------------------------------------------ 키보드 (폰 없이 테스트/플레이)
const KEYMAP = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down' };
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const dir = KEYMAP[e.key] || KEYMAP[e.key.toLowerCase?.()];
  if (dir) { input.keys.add(dir); e.preventDefault(); return; }
  if (e.repeat) return;
  if (e.key === ' ') { e.preventDefault(); dropClaw(); }
  else if (e.key === 'Enter' || e.key === 'c') insertCoin();
  else if (e.key === 'r') resetGame();
  else if (e.key === 'v') setViewMode(view.mode === 'claw' ? 'machine' : 'claw');
});
addEventListener('keyup', (e) => {
  const dir = KEYMAP[e.key] || KEYMAP[e.key.toLowerCase?.()];
  if (dir) input.keys.delete(dir);
});
addEventListener('blur', () => input.keys.clear());

// ------------------------------------------------------------------ 방 / 연결
async function openRoom() {
  const saved = normalizeRoomId(params.get('room') || sessionStorage.getItem('claw-room'));
  const id = saved.length >= 4 ? saved : makeRoomId();
  sessionStorage.setItem('claw-room', id);
  room = await hostRoom(id, {
    onPad: (info) => setPad(!!info),
    onInput: (v) => {
      input.pad.x = clamp(+v.x || 0, -1, 1);
      input.pad.z = clamp(+v.z || 0, -1, 1);
    },
    onCmd: (c) => {
      if (!c) return;
      if (c.type === 'coin') insertCoin();
      else if (c.type === 'drop') dropClaw();
      else if (c.type === 'reset') resetGame();
    },
  });
  const url = new URL('pad.html', location.href);
  url.searchParams.set('room', id);
  if (mode === 'local') url.searchParams.set('local', '');
  for (const el of document.querySelectorAll('[data-room]')) el.textContent = id;
  $('padLink').href = url.href;
  $('padLink').textContent = url.href.replace(/^https?:\/\//, '');
  $('modeBadge').hidden = mode !== 'local';
  for (const [el, size] of [[$('qr'), 240], [$('qrMini'), 112]]) {
    el.innerHTML = '';
    if (window.QRCode) new QRCode(el, { text: url.href, width: size, height: size, colorDark: '#0B0E0D', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
  }
  publish();
}

$('createBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.setAttribute('aria-busy', 'true');
  sfx.unlock();
  try {
    await openRoom();
    $('lobby').classList.remove('show');
    $('qrOverlay').classList.add('show');
    setPhase('idle');
    window.DopaSharp?.track('game_start');
  } catch (err) {
    console.error(err);
    $('lobbyError').textContent = '방을 만들지 못했어요. 잠시 후 다시 시도해 주세요.';
  } finally {
    btn.removeAttribute('aria-busy');
  }
});
$('closeQr').addEventListener('click', () => $('qrOverlay').classList.remove('show'));
$('qrMiniBtn').addEventListener('click', () => $('qrOverlay').classList.add('show'));
$('soundBtn').addEventListener('click', () => {
  sfx.unlock();
  sfx.setMuted(!sfx.isMuted());
  $('soundBtn').textContent = sfx.isMuted() ? '🔇' : '🔊';
});
$('againBtn').addEventListener('click', () => resetGame());
addEventListener('pointerdown', () => sfx.unlock());

// 시작: 인형을 미리 쌓아 두고 안정시킨 뒤 보여줌
fillPrizes(PRIZE_COUNT, 0.5);
for (let i = 0; i < 600; i++) {
  physicsStep(SUB);
  for (const p of prizes) if (p.state === 'chute') award(p);
}
for (const p of prizes) p.q.copy(p.p);
setOpen(1);
renderHud();
setPad(SOLO);
window.__clawReady = true;
// 폰 혼자 모드: 같은 페이지의 조종기(pad.js)가 이 API 로 직접 조종
window.claw = {
  game, cl, sw, view, prizes: () => prizes, insertCoin, dropClaw, resetGame, input, setViewMode,
  setInput(x, z) { input.pad.x = clamp(+x || 0, -1, 1); input.pad.z = clamp(+z || 0, -1, 1); },
  start() { sfx.unlock(); if (game.phase === 'boot') setPhase('idle'); else publish(); },
  step: (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) update(dt); },
  render: (n = 1) => { for (let i = 0; i < n; i++) draw(1 / 60, performance.now()); },
};
dispatchEvent(new Event('claw:ready'));
requestAnimationFrame(loop);
