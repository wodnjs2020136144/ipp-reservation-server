// index.js — 예약 현황 크롤러 (axios + cheerio)
// 지원: 인공지능로봇배움터(ai), 지진 VR(earthquake), 드론 VR(drone)
// 사용: nodemon index.js 또는 node index.js
// 의존성: npm i express cors axios cheerio

// 사용: nodemon index.js 또는 node index.js
// 의존성: npm i express cors axios cheerio

const fs = require('fs'); //임시 저장용 매개변수

const express = require('express');
const cors = require('cors');
const axios = require('axios');
// axios 인스턴스 – 30 초 타임아웃 + 모바일 UA
const axiosClient = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  },
});
const cheerio = require('cheerio');
// --- timezone (KST) setup ------------------------------
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
// -------------------------------------------------------

const app = express();
const PORT = 4000;
app.use(cors());

/** 예약 종류별 달력 URL */
const reservationMap = {
  ai: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=1f960d474357a0fac696373aa47231c9819814b7d50f96cb7e020bd713813353',
  earthquake: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=836d40ad6724f3585ecc91c192de8f29d7b34b85db4c936465070bb8a1d25af5',
  drone: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=33152e18b25f10571da6b0aa11ccf9f07e6211fe37567968e6c591f23fa5c429',
};

/**
 * GET /api/reservations?type=ai|earthquake|drone
 * 오늘 날짜의 예약 회차 · 잔여 인원 파싱
 */
app.get('/api/reservations', async (req, res) => {
  const type = req.query.type;
  const url = reservationMap[type];
  if (!url) return res.status(400).json({ error: 'invalid type' });

  // 오늘 날짜 정보 (KST 기준)
  const todayKST = dayjs().tz('Asia/Seoul');
  const todayDay = todayKST.day();   // 0(일) ~ 6(토)
  const todayDate = todayKST.date(); // 1 ~ 31

  // 휴무 조건
  if (todayDay === 1) return res.json({ message: '월요일 휴관', data: [] });
  if (todayDay === 0 && type === 'earthquake')
    return res.json({ message: '일요일 지진 VR 불가', data: [] });

  try {
    // --- axios 요청 & 디버깅 로그 ------------------------
    const resp = await axiosClient.get(url);
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
    // -----------------------------------------------------

    const $ = cheerio.load(html);
    const result = [];

    // 달력의 모든 <td> 순회
    $('td').each((_, td) => {
      const dateText = $(td).find('span.day').first().text().trim(); // 날짜 숫자
      const cellDate = parseInt(dateText, 10);
      if (cellDate !== todayDate) return; // 오늘이 아니면 skip

      // 오늘 셀 안의 각 회차 링크 파싱
      $(td)
        .find('a.word-wrap')
        .each((_, el) => {
          const raw = $(el).text().trim(); // 예: "10:10 ~ 10:40/초등 (신청마감)"

          // 시간 추출 (시작 시간만)
          const time = (raw.match(/^\d{1,2}:\d{2}/) || [])[0] || '';

          // 괄호 안의 상태·인원
          const statusRaw = (raw.match(/\((.*?)\)$/) || [])[1] || '';
          let status = '', available = null;

          if (statusRaw === '신청마감') {
            status = '신청마감';
            available = 0;
          } else if (/^\d+\/\d+$/.test(statusRaw)) {
            const [used, total] = statusRaw.split('/').map(Number);
            status = '예약가능';
            available = total - used;
          }

          result.push({ time, status, available });
        });
    });

    res.json({ message: '정상 조회', data: result });
  } catch (err) {
    console.error('[crawl error]', type,
      'code:', err.code,
      'status:', err.response?.status,
      'detail:', err.message);
    res.status(500).json({ error: 'crawl fail', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ 예약 서버 실행 중: http://localhost:${PORT}`);
});

// 헬스체크 및 루트 경로
app.get('/', (_, res) => {
  res.send('서버가 정상적으로 실행 중입니다.');
});
