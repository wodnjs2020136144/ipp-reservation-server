// index.js — 예약 현황 크롤러 (axios + cheerio)
// 지원: 인공지능로봇배움터(ai), 지진 VR(earthquake), 드론 VR(drone)
// 사용: nodemon index.js 또는 node index.js
// 의존성: npm i express cors axios cheerio

// 사용: nodemon index.js 또는 node index.js
// 의존성: npm i express cors axios cheerio

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

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

  // 오늘 날짜 정보 (KST 그대로)
  const today = new Date();
  const todayDay = today.getDay();   // 0 일 ~ 6 토
  const todayDate = today.getDate(); // 1 ~ 31

  // 휴무 조건
  if (todayDay === 1) return res.json({ message: '월요일 휴관', data: [] });
  if (todayDay === 0 && type === 'earthquake')
    return res.json({ message: '일요일 지진 VR 불가', data: [] });

  try {
    const { data: html } = await axios.get(url, { timeout: 15000 });
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
    console.error('crawl fail:', err.message);
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
