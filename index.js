const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = 4000;

app.use(cors());

app.get('/api/reservations', async (req, res) => {
  try {
    const url = 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=836d40ad6724f3585ecc91c192de8f29d7b34b85db4c936465070bb8a1d25af5';
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    // 예시: 날짜 + 예약 상태 추출 (추후 정확히 수정 필요)
    const result = [];

    $('td').each((_, el) => {
      const day = $(el).find('.day').text().trim();
      const info = $(el).find('.state').text().trim();

      if (day && info) {
        result.push({ date: day, status: info });
      }
    });

    res.json(result);
  } catch (error) {
    console.error('크롤링 실패:', error.message);
    res.status(500).json({ error: '크롤링 실패' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});