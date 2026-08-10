// index.js — 예약 현황 API 서버 (SQLite 캐시 + 백그라운드 스케줄러 구조)
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const db = require('./db');
const crawler = require('./crawler');
const agent = require('./agent');
const { nowKST } = require('./time');

const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');
const swaggerDocument = YAML.load(path.join(__dirname, 'openapi.yaml'));

const app = express();
const PORT = process.env.PORT || 4000;

// CORS 허용 origin 목록 (쉼표로 구분된 CORS_ALLOWED_ORIGINS 환경변수로 오버라이드 가능)
// 모바일 앱(Expo/React Native)의 네이티브 fetch는 브라우저 CORS 정책 대상이 아니므로 영향받지 않음.
// 이 화이트리스트는 Swagger UI, 로컬 웹 개발(expo start --web) 등 브라우저 기반 접근을 위한 것.
const defaultAllowedOrigins = [
  'http://localhost:19006', // expo web 기본 포트
  'http://localhost:8081',
  'https://ipp-reservation-server.fly.dev',
];
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : defaultAllowedOrigins;

// CORS 및 JSON 파서 미들웨어 설정
app.use(cors({
  origin(origin, callback) {
    // origin이 없는 요청(모바일 앱 네이티브 fetch, curl, 서버 간 호출)은 허용
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS 정책에 의해 차단된 origin입니다.'));
  }
}));
app.use(express.json({ limit: '100kb' }));

// /api/chat 전용 rate limiter — Gemini API 과금/DoS 방지
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});

// Swagger UI 문서 라우팅 등록
// SWAGGER_UI_ENABLED=false로 끌 수 있음 (미설정 시 기존과 동일하게 항상 활성화)
if (process.env.SWAGGER_UI_ENABLED !== 'false') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

// ================================================================
// Background Scheduler Setup (node-cron)
// ================================================================

// 10분마다, 9시부터 18시 사이(KST)에 크롤러 백그라운드 실행
const CRAWL_CRON_SCHEDULE = '*/10 9-18 * * *';
cron.schedule(CRAWL_CRON_SCHEDULE, async () => {
  console.log('[Scheduler] 주기적 크롤링 스케줄 동작 중...');
  await crawler.crawlAll();
}, {
  timezone: 'Asia/Seoul'
});

// ================================================================
// API Endpoints
// ================================================================

/**
 * 특정 타입 예약 정보 가져오기
 * GET /api/reservations?type=ai|earthquake|drone|...
 */
app.get('/api/reservations', async (req, res) => {
  const type = req.query.type;
  if (!crawler.reservationMap[type]) {
    return res.status(400).json({ error: 'invalid type' });
  }

  const todayDateStr = nowKST().format('YYYY-MM-DD');

  try {
    // 1. DB에서 캐시된 예약 데이터 조회
    let result = db.getReservations(type, todayDateStr);

    // 2. 캐시 데이터가 없는 경우 (Cold Start 또는 서버 재시작 직후) 온디맨드 크롤링 수행
    if (!result || result.length === 0) {
      console.log(`[Cache Miss] On-demand crawling triggered for ${type}`);
      await crawler.crawlAndSave(type);
      result = db.getReservations(type, todayDateStr);
    }

    res.json({ message: '정상 조회', data: result });
  } catch (err) {
    console.error('[API Error]', type, err);
    res.status(500).json({ error: '데이터 조회 실패' });
  }
});

/**
 * 모든 예약 정보를 한 번에 가져오는 엔드포인트
 * GET /api/reservations/all
 */
app.get('/api/reservations/all', async (req, res) => {
  const todayDateStr = nowKST().format('YYYY-MM-DD');

  try {
    // 1. DB에서 모든 캐시 정보 조회
    let result = db.getReservationsAll(todayDateStr);

    // 2. 모든 캐시가 유실되었거나 비어있을 시 전체 크롤링 후 재조회
    const ippEmpty = Object.values(result.ipp).every(arr => arr.length === 0);
    const commentatorEmpty = Object.values(result.commentator).every(arr => arr.length === 0);

    if (ippEmpty && commentatorEmpty) {
      console.log('[Cache Miss] Full crawl triggered for all categories');
      await crawler.crawlAll();
      result = db.getReservationsAll(todayDateStr);
    }

    res.json(result);
  } catch (err) {
    console.error('[API All Error]', err);
    res.status(500).json({ error: '전체 데이터 조회 실패' });
  }
});

// 헬스체크 및 메인 엔드포인트
app.get('/', (_, res) => {
  res.send('예약 캐시 백엔드 서버가 정상 작동 중입니다.');
});

/**
 * AI 예약 비서 챗봇 엔드포인트
 * POST /api/chat
 * Body: { message: string }
 */
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const reply = await agent.handleAgentChat(message);
    res.json({ reply });
  } catch (err) {
    console.error('[AI Chat API Error]', err);
    res.status(500).json({ error: 'AI Agent failed to process' });
  }
});

// 전역 에러 핸들러 — CORS 차단 등 미들웨어 단계에서 발생한 에러가
// 기본 Express 핸들러를 통해 스택트레이스와 함께 노출되는 것을 방지
app.use((err, req, res, _next) => {
  console.error('[Unhandled Error]', err);
  res.status(err.status || 500).json({ error: '요청을 처리할 수 없습니다.' });
});

// ================================================================
// Startup
// ================================================================
app.listen(PORT, async () => {
  console.log(`✅ 예약 캐시 서버 실행 중: http://localhost:${PORT}`);
  
  // 서버가 가동될 때 캐시를 최신 상태로 유지하기 위한 Warm-up 크롤링 수행
  console.log('[Startup] DB Cache Warm-up 시작...');
  crawler.crawlAll().then(() => {
    console.log('[Startup] DB Cache Warm-up 완료!');
  }).catch(err => {
    console.error('[Startup] DB Cache Warm-up 실패:', err.message);
  });
});