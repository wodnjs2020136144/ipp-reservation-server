// index.js — 예약 현황 크롤러 (axios + cheerio)
// 지원: 인공지능로봇배움터(ai), 지진 VR(earthquake), 드론 VR(drone)
// 의존성: npm i express cors axios cheerio dayjs

const fs = require('fs');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https'); // SSL 무시를 위해 추가

// --- timezone (KST) setup ---
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

// axios 인스턴스 – SSL 인증서 만료 무시 설정 추가
const axiosClient = axios.create({
  timeout: 60000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  },
  // ✨ 대상 사이트의 SSL 인증서가 만료되었으므로 검증을 무시함 (CERT_HAS_EXPIRED 해결)
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  }),
});

// ---- snapshot store ----
let prevSlots = {};
try {
  if (fs.existsSync('./snapshots.json')) {
    prevSlots = JSON.parse(fs.readFileSync('./snapshots.json', 'utf8'));
  }
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

/**
 * 예약 가능 상태 판단 헬퍼
 */
function getPreReservationStatus(slotTimeStr, now) {
  const slotHour = parseInt(slotTimeStr.split(':')[0], 10);
  const todayDateStr = now.format('YYYY-MM-DD');

  const morningOpen = dayjs.tz(`${todayDateStr} 09:00`, 'Asia/Seoul');
  const afternoonOpen = dayjs.tz(`${todayDateStr} 12:00`, 'Asia/Seoul');

  if (slotHour < 12) {
    return now.isBefore(morningOpen) ? '예약대기' : '예약가능';
  } else {
    return now.isBefore(afternoonOpen) ? '예약대기' : '예약가능';
  }
}

// retry wrapper
async function fetchHtmlWithRetry(url, maxRetry = 3) {
  let lastErr;
  for (let i = 0; i < maxRetry; i++) {
    try {
      return await axiosClient.get(url);
    } catch (err) {
      lastErr = err;
      console.warn(`[retry] ${i + 1} fail: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

function ensureSnapshotDate() {
  try {
    const today = dayjs().tz('Asia/Seoul').format('YYYY-MM-DD');
    if (prevSlots && prevSlots._date !== today) {
      prevSlots = { _date: today };
      saveSnapshots();
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
// Fly.io에서는 process.env.PORT를 사용해야 함
const PORT = process.env.PORT || 4000;
app.use(cors());

const reservationMap = {
  ai: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=1f960d474357a0fac696373aa47231c9819814b7d50f96cb7e020bd713813353',
  earthquake: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=836d40ad6724f3585ecc91c192de8f29d7b34b85db4c936465070bb8a1d25af5',
  drone: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=33152e18b25f10571da6b0aa11ccf9f07e6211fe37567968e6c591f23fa5c429',
  science: 'https://www.cnse.or.kr/main/reserve/guide_calendar.action?q=399c727ae1585fb2c8ac05f7295f26d0b761f9927b66e8ae3cdfc42b8534895d',
  toddler: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=fc018295988dd7a5d5492bc11a0bd1b31d314419ee6dca65debf4a97ef02f8bb',
  robot: 'https://www.cnse.or.kr/main/reserve/guide_calendar.action?q=cbc435e029c9390985c5e31542b88464a21905bdc4584bb7549414974b78147a',
};

async function fetchAndParseReservations(type) {
  const url = reservationMap[type];
  if (!url) return [];

  const todayKST = nowKST();
  const todayDate = todayKST.date();
  const todayDay = todayKST.day();

  // 휴무 조건
  if (todayDay === 1) return [];
  if (todayDay === 0 && type === 'earthquake') return [];

  const resp = await fetchHtmlWithRetry(url, 3);
  const html = resp.data;
  const $ = cheerio.load(html);
  const result = [];

  const listMap = {};
  $('a.btn-reserve, a.btn-closed, button.btn-reserve, button.btn-closed').each((k, el) => {
    const rawList = $(el).text().trim();
    const timeList = (rawList.match(/\d{1,2}:\d{2}/) || [])[0] || '';
    const numsList = rawList.match(/\((\d+)\/(\d+)\)/);
    if (timeList && numsList) {
      listMap[timeList] = { used: Number(numsList[1]), total: Number(numsList[2]) };
    }
  });

  $('table.calendar-table td').each((i, td) => {
    const dateText = $(td).find('span.day').text().trim();
    const cellDate = parseInt(dateText, 10);
    if (cellDate !== todayDate) return;

    $(td).find('a.word-wrap, button.word-wrap').each((j, el) => {
      const raw = $(el).text().trim();
      const time = (raw.match(/^\d{1,2}:\d{2}/) || [])[0] || '';
      if (!time) return;

      const statusRaw = (raw.match(/\((.*?)\)$/) || [])[1] || '';
      let status = '', available = null, total = null;
      const key = makeKey(type, time);
      const isNumericStatus = /^\d+\/\d+$/.test(statusRaw);

      if (isNumericStatus) {
        const [used, totalNum] = statusRaw.split('/').map(Number);
        total = totalNum;
        available = used;
        status = (used >= totalNum) ? '정원마감' : getPreReservationStatus(time, todayKST);
        if (status === '정원마감') available = total;
        prevSlots[key] = { available, total, status };
      } else {
        const prev = prevSlots[key];
        const listInfo = listMap[time];

        if (listInfo && listInfo.total != null) {
          const { used, total: totalL } = listInfo;
          available = used;
          total = totalL;
          status = (used >= totalL) ? '정원마감' : '시간마감';
          if (status === '정원마감') available = total;
        } else if (prev && prev.total != null) {
          available = prev.available;
          total = prev.total;
          const wasFull = prev.status === '정원마감' || prev.available >= prev.total;

          if (wasFull) {
            status = '정원마감';
            available = total;
          } else {
            const slotStart = dayjs.tz(`${todayKST.format('YYYY-MM-DD')} ${time}`, 'YYYY-MM-DD HH:mm', 'Asia/Seoul');
            if (nowKST().isBefore(slotStart)) {
              status = '정원마감';
              available = total;
              prevSlots[key] = { available, total, status };
            } else {
              status = '시간마감';
            }
          }
        } else {
          const slotStart = dayjs.tz(`${todayKST.format('YYYY-MM-DD')} ${time}`, 'YYYY-MM-DD HH:mm', 'Asia/Seoul');
          status = nowKST().isBefore(slotStart) ? '정원마감' : '시간마감';
        }
      }
      result.push({ time, status, available, total });
    });
  });

  return result;
}

app.get('/api/reservations/all', async (req, res) => {
  const ippTypes = ['ai', 'earthquake', 'drone'];
  const commentatorTypes = ['science', 'toddler', 'robot'];
  try {
    ensureSnapshotDate();
    const allPromises = [...ippTypes, ...commentatorTypes].map(type => fetchAndParseReservations(type));
    const allResults = await Promise.all(allPromises);

    const responseData = {
      ipp: { ai: allResults[0], earthquake: allResults[1], drone: allResults[2] },
      commentator: { science: allResults[3], toddler: allResults[4], robot: allResults[5] },
    };
    saveSnapshots();
    res.json(responseData);
  } catch (err) {
    console.error('[crawl-all error]', err.message);
    res.status(500).json({ error: 'failed to fetch', detail: err.message });
  }
});

app.get('/', (_, res) => res.send('Server is running.'));

// ✨ 0.0.0.0으로 리슨하여 Fly.io 프록시 도달 가능하게 수정
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 예약 서버 실행 중: http://0.0.0.0:${PORT}`);
});