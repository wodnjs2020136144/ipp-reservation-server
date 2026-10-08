# ipp-reservation-server

충남교육청 과학교육원(cnse.or.kr)의 체험 프로그램 예약 현황을 주기적으로 크롤링해 캐싱하고, REST API와 Gemini 기반 AI 챗봇으로 제공하는 백엔드 서버입니다.

모바일 클라이언트는 [`ipp-reservation-app`](https://github.com/wodnjs2020136144/ipp-reservation-app) 리포지토리를 참고하세요.

## 기술 스택

- **런타임**: Node.js 22
- **웹 프레임워크**: Express 5
- **DB**: SQLite (`better-sqlite3`)
- **크롤링**: axios + cheerio, `node-cron`
- **AI**: Google Gemini (`@google/genai`, `gemini-3.6-flash`, function calling)
- **API 문서**: OpenAPI(`openapi.yaml`) + Swagger UI
- **배포**: fly.io (Dockerfile, GitHub Actions)

## 폴더 구조

```
index.js         진입점 — Express 앱, 라우트, 크론 스케줄링, Swagger UI 마운트
crawler.js       cnse.or.kr 크롤링 (예약 슬롯 파싱, 재시도, DB 저장)
agent.js         Gemini function calling 기반 AI 챗봇 핸들러
db.js            better-sqlite3 DAO
time.js          KST 시간 유틸
openapi.yaml     REST API 스펙
```

## 시작하기

Node.js 22가 필요합니다.

```bash
npm install
cp .env.example .env   # 값 채우기
npm start              # http://localhost:4000
```

| 변수명 | 필수 | 설명 |
|---|---|---|
| `GEMINI_API_KEY` | 권장 | Google Gemini API 키. 미설정 시 `/api/chat`이 데모 응답 모드로 동작 |
| `PORT` | 선택 | 서버 포트 (기본값 4000) |
| `CRAWL_ALERT_WEBHOOK_URL` | 선택 | 크롤링 실패 시 알림을 보낼 webhook URL(Slack Incoming Webhook 등) |
| `SWAGGER_UI_ENABLED` | 선택 | `false`로 설정 시 `/api-docs` 비활성화 (기본값 true) |
| `CORS_ALLOWED_ORIGINS` | 선택 | 브라우저 기반 클라이언트에 허용할 origin 목록(쉼표 구분). 모바일 앱은 영향받지 않음 |

서버 기동 시 전체 프로그램을 1회 크롤링한 뒤, 09:00~18:59(KST) 사이 10분마다 자동 크롤링합니다.

## API

Swagger UI: `http://localhost:4000/api-docs` (배포 환경: `https://ipp-reservation-server.fly.dev/api-docs`)

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/` | 헬스체크 |
| `GET` | `/api/reservations?type=` | 특정 프로그램의 금일 예약 현황. `type`: `ai`(인공지능로봇배움터), `earthquake`(지진VR), `drone`(드론VR), `science`(기초과학해설), `toddler`(유아과학관 자유체험), `robot`(로봇댄스) |
| `GET` | `/api/reservations/all` | 전체 프로그램 예약 현황 (`ipp`/`commentator` 그룹) |
| `POST` | `/api/chat` | AI 예약 비서. body `{ "message": string }` → `{ "reply": string }`, 분당 10회 제한 |

조회 날짜는 항상 서버 기준 **오늘(KST)** 입니다.

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
