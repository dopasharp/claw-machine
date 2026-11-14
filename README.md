# 🧸 인형뽑기

PC 화면은 **인형뽑기 기계**, 휴대폰은 **조종기**가 되는 도파# 게임.

- **기계 화면** (`index.html`): PC(또는 TV·태블릿)에서 열기. 방을 만들고 QR 코드를 띄움. three.js로 그린 3D 기계.
- **조종기** (`pad.html?room=코드`): QR로 접속. 조이스틱으로 집게를 움직이고 **뽑기!** 버튼.
- **폰 하나로** (`solo.html`): PC 없이. 위는 집게에 달린 카메라 시점, 아래는 조이스틱 + 뽑기 버튼. 네트워크 안 씀.

화면을 끌면 시점을 위아래·좌우로 돌려볼 수 있어요 (휠/핀치 확대, 더블클릭 원위치, `V` 집게 시점 ↔ 기계 전체).

GitHub Pages(정적 호스팅) + Firebase Realtime Database(실시간 연동)로 동작합니다.

## 플레이 방법

1. PC에서 사이트를 열고 **기계 켜기** → 조종기 QR이 떠요.
   기계 화면을 새로고침해도 같은 방 코드로 다시 열려서 조종기가 그대로 연결돼요.
2. 휴대폰 카메라로 QR 스캔 → 조종기 화면.
3. **🪙 코인 넣기** → 30초 안에 조이스틱으로 집게를 옮기고 **뽑기!**
   - 시간이 다 되면 자동으로 내려가요.
   - 인형 정중앙을 노릴수록 잘 잡혀요. 위에 다른 인형이 깔려 있으면 잘 안 잡혀요.
   - 집게는 줄에 매달려 있어서 조이스틱을 막 돌리면 흔들려요. 흔들리는 채로 내리면 빗나가요.
   - 인형이 쌓여 있으면 집게발이 더미에 걸려 맨 아래까지 안 내려가요.
   - 꼭대기에 올라가면 **쾅!** 하고 덜컹, 집게 힘이 풀려 인형이 주르륵 흘러내리고 가끔 툭 떨어져요.
   - 올라가다·옮기다 미끄러지기도 해요 (진짜 기계처럼). 3번 연속 실패하면 다음 판은 집게 힘이 세져요.
   - 가끔 떨어진 인형이 굴러서 배출구로 들어가는 행운도!
4. 코인 5개. 끝나면 폰에 결과 시트(공유·다시 하기)가 떠요.
5. 레어: 왕관 쓴 연두색 **도파# 인형** 💚

PC 키보드로도 플레이 가능: `Enter` 코인 · `←↑↓→` 이동 · `Space` 뽑기 · `R` 다시 하기

## 1. Firebase 설정

1. [Firebase 콘솔](https://console.firebase.google.com) → **프로젝트 추가** (예: `claw-machine`).
2. 빌드 → **Realtime Database** → 데이터베이스 만들기 (위치: 싱가포르 `asia-southeast1`, "잠금 모드"로 시작해도 OK).
3. Realtime Database → **규칙** 탭에 [`database.rules.json`](database.rules.json) 내용을 붙여넣고 **게시**.
   - 이 게임은 `clawRooms/` 경로만 써요.
4. 프로젝트 설정(⚙️) → 내 앱 → **웹 앱(</>) 추가** → 표시되는 `firebaseConfig` 값을
   [`js/firebase-config.js`](js/firebase-config.js)에 붙여넣기.
   - `databaseURL`이 꼭 있어야 해요 (Realtime Database를 만든 뒤에 복사하면 들어있음).

> Firebase 웹 설정값(apiKey 등)은 공개돼도 되는 값이에요. 보안은 DB 규칙으로 지킵니다.

## 2. GitHub Pages 배포

```bash
git remote add origin https://github.com/dopasharp/claw-machine.git
git push -u origin main
```

GitHub 저장소 → Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)` → Save.
잠시 후 `https://dopasharp.github.io/claw-machine/` 에서 열려요.

허브에 노출하려면 `dopasharp.github.io/games.js`의 `DOPA_GAMES`에 한 줄 추가:

```js
{ id: 'claw-machine', code: 'CLAW', emoji: '🧸', name: '인형뽑기', hook: 'PC는 기계, 폰은 조이스틱! 몇 개나 뽑을 수 있을까?', tags: ['solo', 'duo', 'party'], meta: ['PC + 폰', '3D'] },
```

## 로컬 테스트 (Firebase 없이)

`firebase-config.js`가 비어 있거나 `YOUR_`로 시작하면 자동으로 **로컬 테스트 모드**가 됩니다 (같은 브라우저의 탭끼리 BroadcastChannel로 연동).

```bash
python -m http.server 8781
```

`http://localhost:8781` (기계)을 열고 **기계 켜기** → QR 아래 링크를 새 창으로 열면 조종기예요.
조종기 창에서는 마우스로 조이스틱을 드래그하거나 방향키/스페이스로 조종할 수 있어요.
Firebase를 설정한 뒤에도 주소에 `?local` 을 붙이면 로컬 모드로 테스트할 수 있어요.

## 파일 구조

```
index.html            기계 화면 (PC)
pad.html              조종기 화면 (폰)
solo.html             폰 하나로 (집게 카메라 + 조종기, machine.js + pad.js 를 한 페이지에서)
css/style.css         공통 스타일
js/machine.js         3D 기계, 인형 물리(Verlet), 집게·확률·진행
js/pad.js             조이스틱/버튼, 상태 표시, 결과 시트
js/net.js             연동 (Firebase RTDB / 로컬 BroadcastChannel)
js/sound.js           WebAudio 합성 효과음 (코인, 모터, 집게, 팡파레)
js/firebase-config.js Firebase 설정
database.rules.json   Realtime Database 보안 규칙
```

### 연동 데이터 (`clawRooms/{방코드}`)

| 경로 | 쓰는 쪽 | 내용 |
| --- | --- | --- |
| `meta` | 기계 | 방 생성 시각. 기계가 끊기면 방 전체 삭제 |
| `pad` | 조종기 | 접속 표시 (끊기면 삭제) |
| `input` | 조종기 | 조이스틱 방향 `{x, z}` (-1~1, 바뀔 때만 최대 ~14회/초) |
| `cmds` | 조종기 | `coin` / `drop` / `reset` 명령 (기계가 읽고 지움) |
| `state` | 기계 | 단계·코인·잡은 개수·남은 시간·마지막 GET |

집게 움직임은 기계(PC)가 계산하고, 폰은 방향만 보내서 네트워크가 느려도 화면은 부드러워요.

## 도파# 브랜드 프레임

`dopasharp/` 폴더는 모든 dopa.shap 게임 저장소에 **똑같이** 복사해 쓰는 공통 디자인 시스템입니다. 원본은 `soju-game/dopasharp/`이고, 여기서 고치지 말고 원본을 고친 뒤 모든 저장소에 다시 복사합니다.
