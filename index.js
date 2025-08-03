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
// axios 인스턴스 – 60 초 타임아웃 + 모바일 UA
const axiosClient = axios.create({
  timeout: 60000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  },
});

const cheerio = require('cheerio');

// ---- snapshot store: 마지막 예약(잔여/정원) 보존용 -----------------
let prevSlots = {};
try {
  prevSlots = JSON.parse(fs.readFileSync('./snapshots.json', 'utf8'));
} catch (_) {}

const saveSnapshots = () => {
  try {
    fs.writeFileSync('./snapshots.json', JSON.stringify(prevSlots));
  } catch (_) {}
};
const makeKey = (type, time) => `${type}-${time}`;
// KST now (re‑usable)
const nowKST = () => dayjs().tz('Asia/Seoul');
// -----------------------------------------------------------------

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
    // -----------------------------------------------------

    const $ = cheerio.load(html);
    const result = [];

    // 달력의 모든 <td> 순회
    $('table.calendar-table td').each((i, td) => {
      const dateText = $(td).find('span.day').text().trim(); // 날짜 숫자
      const cellDate = parseInt(dateText, 10);

      // 디버깅 로그: 각 셀의 날짜 출력
      console.log('[td]', i, 'dateText=', dateText || '—');

      if (cellDate !== todayDate) return; // 오늘이 아니면 skip

      // ― 오늘 날짜 셀 발견 → HTML 스니펫 저장
      try {
        fs.writeFileSync(`/tmp/${type}-today.html`, $(td).html());
      } catch (e) {
        console.warn('debug today-cell write failed:', e.message);
      }

      // 오늘 셀 안의 각 회차 링크 파싱
      $(td)
        .find('a.word-wrap, button.word-wrap') // 버튼 태그도 대응
        .each((j, el) => {
          const raw = $(el).text().trim(); // 예: "10:10 ~ 10:40/초등 (신청마감)"

          // 디버깅 로그: 회차 raw 출력
          console.log('[slot]', j, raw);

          // 시간 추출 (시작 시간만)
          const time = (raw.match(/^\d{1,2}:\d{2}/) || [])[0] || '';

          // 괄호 안의 상태·인원
          const statusRaw = (raw.match(/\((.*?)\)$/) || [])[1] || '';
          let status = '', available = null;
          let total = null;

          const key = makeKey(type, time);

          if (/^\d+\/\d+$/.test(statusRaw)) {
            // 형태: 3/6  (사용/전체)
            const [usedStr, totalStr] = statusRaw.split('/').map(Number);
            const used = usedStr;
            total = totalStr;
            if (used === total) {
              status = '정원마감';
              available = 0;
            } else {
              status = '예약가능';
              available = total - used;
            }
            // 숫자 정보가 있으면 스냅샷 갱신
            prevSlots[key] = { available, total };
          } else {
            // '신청마감' = 시간마감 or 정원마감
            const prev = prevSlots[key];

            // 슬롯 시작 시각 및 beforeStart 삭제
            if (prev && prev.total != null) {
              // 숫자 스냅샷이 있으면 그대로 사용
              available = prev.available;
              total = prev.total;
              status = prev.available === 0 ? '정원마감' : '시간마감';
            } else {
              // 정보가 없으면 시간마감으로만 표시
              status = '시간마감';
              available = 0;
              total = null;
            }
          }

          result.push({ time, status, available, total });
        });
    });

    /* ---------- Fallback: 일(日)‑단위 목록 뷰 ---------- */
    if (result.length === 0) {
      $('a.btn-reserve, a.btn-closed, button.btn-reserve, button.btn-closed').each((k, el) => {
        const raw = $(el).text().trim();            // 예: '1회차 (15:10 ~ 15:40/유아) (0/6)'
        console.log('[slot‑list]', k, raw);

        // 시작 시각
        const time = (raw.match(/\d{1,2}:\d{2}/) || [])[0] || '';

        // (사용/전체) 또는 '신청마감' 추출
        let status = '', available = null;
        let total = null;
        const nums = raw.match(/\((\d+)\/(\d+)\)/);
        if (nums) {
          const used = Number(nums[1]);
          const totalNum = Number(nums[2]);
          total = totalNum;
          if (used === totalNum) {
            status = '정원마감';
            available = 0;
          } else {
            status = '예약가능';
            available = totalNum - used;
          }
          // 스냅샷 갱신
          const key = makeKey(type, time);
          prevSlots[key] = { available, total };
        } else {
          // 괄호 없는 '신청마감'
          const key = makeKey(type, time);
          const prev = prevSlots[key];

          // slotStart 및 beforeStart 삭제
          if (prev && prev.total != null) {
            available = prev.available;
            total = prev.total;
            status = prev.available === 0 ? '정원마감' : '시간마감';
          } else {
            status = '시간마감';
            available = 0;
            total = null;
          }
        }

        result.push({ time, status, available, total });
      });
    }
    /* ---------- /fallback ---------- */

    saveSnapshots();
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
