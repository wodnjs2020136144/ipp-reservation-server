// index.js — 예약 현황 크롤러 (axios + cheerio)
// 지원: 인공지능로봇배움터(ai), 지진 VR(earthquake), 드론 VR(drone)
// 사용: nodemon index.js 또는 node index.js
// 의존성: npm i express cors axios cheerio

const fs = require('fs'); //임시 저장용 매개변수
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

// axios 인스턴스 – 60 초 타임아웃 + 모바일 UA
const axiosClient = axios.create({
  timeout: 60000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  },
});

// --- timezone (KST) setup ------------------------------
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
// -------------------------------------------------------

// ---- snapshot store: 마지막 예약(신청/정원) 보존용 -----------------
let prevSlots = {};
try {
  prevSlots = JSON.parse(fs.readFileSync('./snapshots.json', 'utf8'));
} catch (_) { }

const saveSnapshots = () => {
  try {
    if (typeof prevSlots !== 'object' || prevSlots === null) prevSlots = {};
    const today = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
    prevSlots._date = today;
    fs.writeFileSync('./snapshots.json', JSON.stringify(prevSlots));
  } catch (_) { }
};

const makeKey = (type, time) => `${type}-${time}`;
const nowKST = () => dayjs().tz('Asia/Seoul');

// --- simple retry wrapper for axiosClient.get ---
async function fetchHtmlWithRetry(url, maxRetry = 3) {
  let lastErr;
  for (let i = 0; i < maxRetry; i++) {
    try {
      return await axiosClient.get(url);
    } catch (err) {
      lastErr = err;
      console.warn('[retry]', i + 1, 'fail', err.code || err.message);
      await new Promise(r => setTimeout(r, 1000 * (i + 1))); // 1s → 2s → 3s
    }
  }
  throw lastErr;
}

// 매일 0시(KST) 넘어가면 스냅샷 초기화 (정원마감 락이 다음날로 넘어오지 않도록)
function ensureSnapshotDate() {
  try {
    const today = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
    if (prevSlots && prevSlots._date !== today) {
      prevSlots = { _date: today };
      fs.writeFileSync('./snapshots.json', JSON.stringify(prevSlots));
      console.log('[snapshots] reset for new day:', today);
    }
  } catch (e) {
    console.warn('[snapshots] ensureSnapshotDate failed:', e.message);
  }
}

// ================================================================
// Express App Setup
// ================================================================

const app = express();
const PORT = 4000;
app.use(cors());

/**
 * ✨ [추가] 예약 종류별 달력 URL 확장
 */
const reservationMap = {
  // --- IPP 실습생용 ---
  ai: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=1f960d474357a0fac696373aa47231c9819814b7d50f96cb7e020bd713813353',
  earthquake: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=836d40ad6724f3585ecc91c192de8f29d7b34b85db4c936465070bb8a1d25af5',
  drone: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=33152e18b25f10571da6b0aa11ccf9f07e6211fe37567968e6c591f23fa5c429',

  // --- 과학해설사용 ---
  science: 'https://www.cnse.or.kr/main/reserve/guide_calendar.action?q=399c727ae1585fb2c8ac05f7295f26d0b761f9927b66e8ae3cdfc42b8534895d',
  toddler: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=fc018295988dd7a5d5492bc11a0bd1b31d314419ee6dca65debf4a97ef02f8bb',
  robot: 'https://www.cnse.or.kr/main/reserve/guide_calendar.action?q=cbc435e029c9390985c5e31542b88464a21905bdc4584bb7549414974b78147a',
};


/**
 * ✨ [신규] 핵심 크롤링 로직을 재사용 가능한 함수로 분리
 * - 기존 GET /api/reservations 핸들러의 로직을 그대로 옮겨와 재사용성을 높였습니다.
 * @param {string} type - 'ai', 'earthquake' 등 예약의 종류 키
 * @returns {Promise<Array>} - 파싱된 예약 정보가 담긴 배열
 */
async function fetchAndParseReservations(type) {
  const url = reservationMap[type];
  if (!url) {
    console.warn(`[invalid type] Invalid type requested: ${type}`);
    return []; // 유효하지 않은 타입은 빈 배열 반환
  }

  // 오늘 날짜 정보 (KST 기준)
  const todayKST = dayjs().tz('Asia/Seoul');
  const todayDay = todayKST.day();   // 0(일) ~ 6(토)
  const todayDate = todayKST.date(); // 1 ~ 31

  // 휴무 조건
  if (todayDay === 1) return []; // 월요일은 휴관이므로 빈 배열 반환
  if (todayDay === 0 && type === 'earthquake') return []; // 일요일 지진 VR 미운영

  const resp = await fetchHtmlWithRetry(url, 3);
  console.log('[crawl]', type, 'status:', resp.status, 'length:',
    resp.headers['content-length'] || 'n/a',
    resp.headers.location ? 'redirect-> ' + resp.headers.location : '');
  const html = resp.data;

  // HTML 임시 저장 (디버깅용)
  try {
    fs.writeFileSync(`/tmp/${type}.html`, html);
  } catch (e) {
    console.warn('debug file write failed:', e.message);
  }

  const $ = cheerio.load(html);
  const result = [];

  // (이하 파싱 로직은 기존 코드와 100% 동일합니다)

  // Pre-parse list view to obtain numeric (used/total) per time for closed slots
  const listMap = {};
  $('a.btn-reserve, a.btn-closed, button.btn-reserve, button.btn-closed').each((k, el) => {
    // ... (기존과 동일)
    const rawList = $(el).text().trim();
    const timeList = (rawList.match(/\d{1,2}:\d{2}/) || [])[0] || '';
    const numsList = rawList.match(/\((\d+)\/(\d+)\)/);
    if (timeList && numsList) {
      listMap[timeList] = { used: Number(numsList[1]), total: Number(numsList[2]) };
    }
  });

  // 달력의 모든 <td> 순회
  // --- ✨ [수정] 메인 파싱 로직 ---
  $('table.calendar-table td').each((i, td) => {
    const dateText = $(td).find('span.day').text().trim();
    const cellDate = parseInt(dateText, 10);
    if (cellDate !== todayDate) return;

    $(td).find('a.word-wrap, button.word-wrap').each((j, el) => {
      const raw = $(el).text().trim();
      const time = (raw.match(/^\d{1,2}:\d{2}/) || [])[0] || '';
      if (!time) return; // 시간이 없으면 유효하지 않은 슬롯

      const statusRaw = (raw.match(/\((.*?)\)$/) || [])[1] || '';
      let status = '', available = null, total = null;
      const key = makeKey(type, time);
      const isNumericStatus = /^\d+\/\d+$/.test(statusRaw);

      if (isNumericStatus) {
        // 1. 숫자 데이터 (e.g., 5/6)가 있으면, 항상 이 정보를 신뢰하고 스냅샷을 덮어씀
        const [used, totalNum] = statusRaw.split('/').map(Number);
        total = totalNum;
        available = used;
        status = (used >= totalNum) ? '정원마감' : '예약가능';
        if (status === '정원마감') available = total; // 정원마감 시 available을 total과 일치

        // 스냅샷을 최신 정보로 무조건 업데이트
        prevSlots[key] = { available, total, status };

      } else {
        // 2. 숫자 데이터가 없으면 (e.g., '신청마감'), 스냅샷과 다른 정보를 활용해 추론
        const prev = prevSlots[key];
        const listInfo = listMap[time];

        if (listInfo && listInfo.total != null) {
          // 리스트뷰에 숫자 정보가 있으면 활용
          const { used, total: totalL } = listInfo;
          available = used;
          total = totalL;
          status = (used >= totalL) ? '정원마감' : '시간마감';
          if (status === '정원마감') available = total;

        } else if (prev && prev.total != null) {
          // 스냅샷 정보가 있으면 활용
          available = prev.available;
          total = prev.total;
          const wasFull = prev.status === '정원마감' || prev.available >= prev.total;

          const slotStart = dayjs.tz(`${todayKST.format('YYYY-MM-DD')} ${time}`, 'YYYY-MM-DD HH:mm', 'Asia/Seoul');
          const beforeStart = nowKST().isBefore(slotStart);

          if (beforeStart && wasFull) {
            status = '정원마감';
            available = total;
          } else {
            status = wasFull ? '정원마감' : '시간마감';
            if (status === '정원마감') available = total;
          }
        } else {
          // 정보가 전혀 없으면 시간으로만 추정
          const slotStart = dayjs.tz(`${todayKST.format('YYYY-MM-DD')} ${time}`, 'YYYY-MM-DD HH:mm', 'Asia/Seoul');
          status = nowKST().isBefore(slotStart) ? '정원마감' : '시간마감';
        }
      }
      result.push({ time, status, available, total });
    });
  });

  /* ---------- Fallback: 일(日)‑단위 목록 뷰 ---------- */
  if (result.length === 0) {
    $('a.btn-reserve, a.btn-closed, button.btn-reserve, button.btn-closed').each((k, el) => {
      const raw = $(el).text().trim();
      const time = (raw.match(/\d{1,2}:\d{2}/) || [])[0] || '';
      if (!time) return;

      let status = '', available = null, total = null;
      const key = makeKey(type, time);
      const nums = raw.match(/\((\d+)\/(\d+)\)/);

      if (nums) {
        // 1. 숫자 데이터가 있으면 항상 신뢰하고 스냅샷 덮어쓰기
        const used = Number(nums[1]);
        const totalNum = Number(nums[2]);
        available = used;
        total = totalNum;
        status = (used >= totalNum) ? '정원마감' : '예약가능';
        if (status === '정원마감') available = total;

        prevSlots[key] = { available, total, status };

      } else {
        // 2. 숫자 데이터가 없으면 스냅샷으로 추론
        const prev = prevSlots[key];
        if (prev && prev.total != null) {
          available = prev.available;
          total = prev.total;
          const wasFull = prev.status === '정원마감' || prev.available >= prev.total;
          status = wasFull ? '정원마감' : '시간마감';
          if (status === '정원마감') available = total;
        } else {
          const slotStart = dayjs.tz(`${todayKST.format('YYYY-MM-DD')} ${time}`, 'YYYY-MM-DD HH:mm', 'Asia/Seoul');
          status = nowKST().isBefore(slotStart) ? '정원마감' : '시간마감';
        }
      }
      result.push({ time, status, available, total });
    });
  }
  /* ---------- /fallback ---------- */

  return result;
}

// ================================================================
// API Endpoints
// ================================================================

/**
 * ✨ [수정] 기존 엔드포인트는 분리된 함수를 호출하도록 변경 (하위 호환성 유지)
 * GET /api/reservations?type=ai|earthquake|drone
 * 오늘 날짜의 예약 회차 · 신청 인원 파싱
 */
app.get('/api/reservations', async (req, res) => {
  const type = req.query.type;
  if (!reservationMap[type]) {
    return res.status(400).json({ error: 'invalid type' });
  }

  try {
    ensureSnapshotDate();
    const result = await fetchAndParseReservations(type);
    saveSnapshots(); // 개별 조회 후에도 스냅샷은 저장
    res.json({ message: '정상 조회', data: result });
  } catch (err) {
    console.error('[crawl error]', type, 'code:', err.code, 'status:', err.response?.status, 'detail:', err.message);
    res.status(500).json({ error: 'crawl fail', detail: err.message });
  }
});

/**
 * ✨ [신규] 모든 예약 정보를 그룹별로 한 번에 가져오는 엔드포인트
 * GET /api/reservations/all
 */
app.get('/api/reservations/all', async (req, res) => {
  const ippTypes = ['ai', 'earthquake', 'drone'];
  const commentatorTypes = ['science', 'toddler', 'robot'];

  try {
    ensureSnapshotDate();

    // Promise.all을 사용해 모든 크롤링 작업을 병렬로 실행하여 성능 최적화
    const allPromises = [...ippTypes, ...commentatorTypes].map(type => fetchAndParseReservations(type));
    const allResults = await Promise.all(allPromises);

    // 응답 데이터를 ipp와 commentator 그룹으로 구조화
    const responseData = {
      ipp: {
        ai: allResults[0],
        earthquake: allResults[1],
        drone: allResults[2],
      },
      commentator: {
        science: allResults[3],
        toddler: allResults[4],
        robot: allResults[5],
      },
    };

    // 모든 비동기 작업이 끝난 후 스냅샷을 한 번만 저장
    saveSnapshots();
    res.json(responseData);

  } catch (err) {
    console.error('[crawl-all error]', err.message);
    res.status(500).json({ error: 'failed to fetch all reservations', detail: err.message });
  }
});

// 헬스체크 및 루트 경로
app.get('/', (_, res) => {
  res.send('서버가 정상적으로 실행 중입니다.');
});

app.listen(PORT, () => {
  console.log(`✅ 예약 서버 실행 중: http://localhost:${PORT}`);
});