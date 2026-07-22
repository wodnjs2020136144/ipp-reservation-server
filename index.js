// index.js — 예약 현황 API 서버 (SQLite 캐시 + 백그라운드 스케줄러 구조)
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

const db = require('./db');
const crawler = require('./crawler');

dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
const PORT = 4000;

// CORS 설정: 실제 상용화 환경에서는 허용 도메인 목록을 구체적으로 정하는 것이 좋음
app.use(cors());

const nowKST = () => dayjs().tz('Asia/Seoul');

// ================================================================
// Background Scheduler Setup (node-cron)
// ================================================================

// 10분마다 크롤러 백그라운드 실행 (매일 09:00 ~ 18:00 KST 활성화)
// Cron: 매 10분마다, 9시부터 18시 사이에 작동
cron.schedule('*/10 9-18 * * *', async () => {
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
    console.error('[API Error]', type, err.message);
    res.status(500).json({ error: '데이터 조회 실패', detail: err.message });
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
    console.error('[API All Error]', err.message);
    res.status(500).json({ error: '전체 데이터 조회 실패', detail: err.message });
  }
});

// 헬스체크 및 메인 엔드포인트
app.get('/', (_, res) => {
  res.send('예약 캐시 백엔드 서버가 정상 작동 중입니다.');
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