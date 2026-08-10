# ipp-reservation-server

충남교육청 과학교육원(cnse.or.kr)의 체험 프로그램 예약 현황을 주기적으로 크롤링해 캐싱하고, REST API와 Gemini 기반 AI 챗봇으로 제공하는 백엔드 서버입니다.

모바일 클라이언트는 [`ipp-reservation-app`](../ipp-reservation-app) 리포지토리를 참고하세요.

## 기술 스택

- **런타임**: Node.js `>=18.18.0 <19`
- **웹 프레임워크**: Express 5
- **DB**: SQLite (`better-sqlite3`, WAL 모드)
- **크롤링**: axios + cheerio (`node-cron`으로 주기 실행)
- **AI**: Google Gemini (`@google/generative-ai`, `gemini-2.0-flash`, function calling)
- **API 문서**: OpenAPI(`openapi.yaml`) + Swagger UI
- **배포**: fly.io (Dockerfile, GitHub Actions)

## 폴더 구조

```
index.js         진입점 — Express 앱, 라우트, 크론 스케줄링, Swagger UI 마운트
crawler.js       cnse.or.kr 크롤링 로직 (프로그램별 예약 슬롯 파싱, 재시도, DB 저장)
agent.js         Gemini function calling 기반 AI 챗봇 핸들러
db.js            better-sqlite3 DAO (reservations 테이블 CRUD)
openapi.yaml     REST API 스펙 (Swagger UI에서 사용)
Dockerfile       fly.io 배포용 멀티스테이지 빌드
fly.toml         fly.io 앱 설정
.github/workflows/fly-deploy.yml   main 브랜치 push 시 자동 배포
```

## 시작하기

### 요구 사항
- Node.js 18.x (18.18.0 이상, 19 미만)

### 설치
```bash
npm install
```

### 환경변수
`.env.example`을 복사해 `.env`를 만들고 값을 채웁니다.
```bash
cp .env.example .env
```

| 변수명 | 필수 | 설명 |
|---|---|---|
| `GEMINI_API_KEY` | 권장 | Google Gemini API 키. 미설정 시 `/api/chat`이 데모 응답 모드로 동작 |
| `PORT` | 선택 | 서버 포트 (기본값 4000) |
| `CORS_ALLOWED_ORIGINS` | 선택 | 브라우저 기반 클라이언트에 허용할 origin 목록(쉼표 구분). 모바일 앱은 영향받지 않음 |

### 로컬 실행
```bash
npm start        # node index.js, 포트 4000 고정
npm run dev       # nodemon 필요 (devDependencies에 미포함 — 로컬에서 별도 설치 필요: npm i -D nodemon)
```

서버 기동 시 전체 프로그램에 대해 1회 warm-up 크롤링을 수행한 뒤, 09:00~18:59(KST) 사이 10분마다 자동 크롤링합니다.

## API

Swagger UI: `http://localhost:4000/api-docs` (배포 환경: `https://ipp-reservation-server.fly.dev/api-docs`)

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/` | 헬스체크 |
| `GET` | `/api/reservations?type=` | 특정 프로그램의 금일 예약 현황 조회. `type`: `ai`(인공지능로봇배움터), `earthquake`(지진VR), `drone`(드론VR), `science`(기초과학해설), `toddler`(유아과학관 자유체험), `robot`(로봇댄스) |
| `GET` | `/api/reservations/all` | 전체 프로그램 예약 현황 일괄 조회 (`ipp`/`commentator` 그룹으로 반환) |
| `POST` | `/api/chat` | AI 예약 비서. body `{ "message": string }` → `{ "reply": string }` |

> `/api/chat`은 현재 `openapi.yaml`에 문서화되어 있지 않습니다.

조회는 항상 서버 기준 **오늘(KST) 날짜**로 고정되어 있으며, 미래 날짜 조회는 지원하지 않습니다.

## 데이터 흐름

```
cnse.or.kr 예약 캘린더 페이지
      │ crawler.js (axios + cheerio, 재시도 3회)
      ▼
SQLite reservations 테이블 (UPSERT)
      ▲                    │
node-cron 10분 간격          │ db.js
+ 서버 기동 warm-up          ▼
              GET /api/reservations(/all)
              POST /api/chat → Gemini function calling → 동일 DAO 조회 → 자연어 응답
```

## 배포

- fly.io 앱: `ipp-reservation-server` (region: `nrt`, VM shared-cpu-1x/512MB)
- `main` 브랜치에 push되면 `.github/workflows/fly-deploy.yml`이 `flyctl deploy --remote-only` 실행
- fly.io secrets로 `GEMINI_API_KEY`를 등록해야 합니다: `flyctl secrets set GEMINI_API_KEY=...`
- SQLite(`data.db`)는 볼륨 마운트가 없어 머신 재시작 시 초기화됩니다(warm-up 크롤링으로 자동 복구되나 전일 스냅샷 기반 마감 추론 근거는 유실됨).

## 알려진 이슈 및 개선 필요 사항

코드 리뷰를 통해 확인된 항목입니다. 보안 우선 개선 로드맵에 따라 순차적으로 해결 중입니다.

### 해결 완료
| 항목 | 위치 | 조치 |
|---|---|---|
| CORS 전체 오픈 | `index.js` | origin 화이트리스트 적용(`CORS_ALLOWED_ORIGINS`) |
| `/api/chat` rate limit 부재 | `index.js`, `agent.js` | `express-rate-limit` 적용(분당 10회) |
| 에러 응답에 `err.message` 노출 | `index.js`, `agent.js` | 일반화된 메시지로 대체, 상세는 서버 로그에만 기록 |
| `express.json()` body size limit 미지정 | `index.js` | `limit: '100kb'` 명시 |
| 포트 하드코딩 | `index.js` | `process.env.PORT`로 오버라이드 가능하게 변경(기본값 4000 유지) |
| `.env.example` 부재 | - | 작성 완료 |
| 크롤링 실패 알림/동시 실행 방지 부재 | `crawler.js` | `crawlAll()`에 in-memory 락 추가(크론-warmup 겹침 방지), 실패 요약 로그 및 `CRAWL_ALERT_WEBHOOK_URL`(선택) webhook 알림 지원 |

### 남은 이슈
| 심각도 | 항목 | 위치 |
|---|---|---|
| 낮음 | 재시도 횟수·타임아웃·크론 스케줄 등 매직넘버가 코드에 흩어져 있음 | `crawler.js` 다수 |
| 낮음 | `nowKST()` 함수가 `index.js`, `crawler.js`에 중복 정의됨 | `index.js:31`, `crawler.js:30` |
| 낮음 | `package.json`의 `allowScripts`에 이미 제거된 `puppeteer` 항목이 잔재로 남아있음 | `package.json:25-28` |
| 낮음 | Swagger UI가 프로덕션 환경에서도 항상 공개되어 있음 | `index.js:29` |

확인 결과 문제가 없는 항목: SQL 쿼리는 전부 파라미터 바인딩 사용(SQL 인젝션 없음), git 히스토리에 시크릿 커밋 이력 없음, Dockerfile에 시크릿 하드코딩 없음.
