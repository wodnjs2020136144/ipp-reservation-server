// index.js — 예약 현황 크롤러 (axios + cheerio)
// 실행: fly.io · Render 등에서 `npm start` (node index.js)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors());

/** 예약 종류별 달력 URL */
const reservationMap = {
  ai: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=1f960d474357a0fac696373aa47231c9819814b7d50f96cb7e020bd713813353',
  earthquake:
    'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=836d40ad6724f3585ecc91c192de8f29d7b34b85db4c936465070bb8a1d25af5',
  drone:
    'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=33152e18b25f10571da6b0aa11ccf9f07e6211fe37567968e6c591f23fa5c429',
};

/**
 * GET /api/reservations?type=ai|earthquake|drone
 * 오늘 날짜(서울 기준) 예약 회차 & 잔여 인원 반환
 */
app.get('/api/reservations', async (req, res) => {
  const type = req.query.type;
  const url = reservationMap[type];
  if (!url) return res.status(400).json({ error: 'invalid type' });

  // 오늘 날짜 (KST)
  const today = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }),
  );
  const todayDay = today.getDay(); // 0(일)~6(토)
  const todayDate = today.getDate();

  // 휴관/불가 요일 처리
  if (todayDay === 1) return res.json({ message: '월요일 휴관', data: [] });
  if (todayDay === 0 && type === 'earthquake')
    return res.json({ message: '일요일 지진 VR 불가', data: [] });

  try {
    const resp = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      maxRedirects: 5,
    });

    const html = resp.data;
    const $ = cheerio.load(html);
    const result = [];

    // 달력 셀 순회
    $('td').each((_, td) => {
      const dateText = $(td).find('span.day').first().text().trim();
      const cellDate = parseInt(dateText, 10);
      if (cellDate !== todayDate) return; // 오늘이 아니면 skip

      // 오늘 셀에 있는 회차 링크 파싱
      $(td)
        .find('a.word-wrap')
        .each((_, el) => {
          const raw = $(el).text().trim(); // 예: "10:10 ~ 10:40/초등 (신청마감)"
          const time = (raw.match(/^\d{1,2}:\d{2}/) || [])[0] || '';

          const statusRaw = (raw.match(/\((.*?)\)$/) || [])[1] || '';
          let status = '';
          let available = null;

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

    return res.json({ message: '정상 조회', data: result });
  } catch (err) {
    console.error('crawl fail:', err.message);
    return res.status(500).json({ error: 'crawl fail', detail: err.message });
  }
});

// 헬스체크
app.get('/', (_, res) => {
  res.send('서버가 정상적으로 실행 중입니다.');
});

app.listen(PORT, () => {
  console.log(`✅ 예약 서버 실행 중: http://localhost:${PORT}`);
});
