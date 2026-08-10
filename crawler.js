// crawler.js — 과학관 예약 사이트 크롤링 및 데이터 분석 파트
const axios = require('axios');
const cheerio = require('cheerio');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const db = require('./db');

dayjs.extend(utc);
dayjs.extend(timezone);

const axiosClient = axios.create({
  timeout: 60000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  },
});

const reservationMap = {
  ai: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=1f960d474357a0fac696373aa47231c9819814b7d50f96cb7e020bd713813353',
  earthquake: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=836d40ad6724f3585ecc91c192de8f29d7b34b85db4c936465070bb8a1d25af5',
  drone: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=33152e18b25f10571da6b0aa11ccf9f07e6211fe37567968e6c591f23fa5c429',
  science: 'https://www.cnse.or.kr/main/reserve/guide_calendar.action?q=399c727ae1585fb2c8ac05f7295f26d0b761f9927b66e8ae3cdfc42b8534895d',
  toddler: 'https://www.cnse.or.kr/main/reserve/experience_calendar.action?q=fc018295988dd7a5d5492bc11a0bd1b31d314419ee6dca65debf4a97ef02f8bb',
  robot: 'https://www.cnse.or.kr/main/reserve/guide_calendar.action?q=cbc435e029c9390985c5e31542b88464a21905bdc4584bb7549414974b78147a',
};

const nowKST = () => dayjs().tz('Asia/Seoul');

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

async function fetchHtmlWithRetry(url, maxRetry = 3) {
  let lastErr;
  for (let i = 0; i < maxRetry; i++) {
    try {
      return await axiosClient.get(url);
    } catch (err) {
      lastErr = err;
      console.warn('[retry]', i + 1, 'fail', err.code || err.message);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 특정 타입에 대한 크롤링 및 결과 파싱 수행 후 DB에 저장
 * @param {string} type 
 */
async function crawlAndSave(type) {
  const url = reservationMap[type];
  if (!url) return;

  const todayKST = nowKST();
  const todayDateStr = todayKST.format('YYYY-MM-DD');
  const todayDay = todayKST.day();
  const todayDate = todayKST.date();

  // 휴무일 조건 처리
  if (todayDay === 1) return; // 월요일 휴관
  if (todayDay === 0 && type === 'earthquake') return; // 일요일 지진 미운영

  const resp = await fetchHtmlWithRetry(url, 3);
  const html = resp.data;
  const $ = cheerio.load(html);
  const result = [];

  // 리스트 뷰 사전 파싱
  const listMap = {};
  $('a.btn-reserve, a.btn-closed, button.btn-reserve, button.btn-closed').each((k, el) => {
    const rawList = $(el).text().trim();
    const timeList = (rawList.match(/\d{1,2}:\d{2}/) || [])[0] || '';
    const numsList = rawList.match(/\((\d+)\/(\d+)\)/);
    if (timeList && numsList) {
      listMap[timeList] = { used: Number(numsList[1]), total: Number(numsList[2]) };
    }
  });

  // DB에 기존에 저장되어 있던 오늘 날짜의 슬롯 정보 로드 (마감 추론용 스냅샷 대체)
  const existingSlots = db.getReservations(type, todayDateStr);
  const prevSlotsMap = {};
  for (const slot of existingSlots) {
    prevSlotsMap[slot.time] = slot;
  }

  // 달력 테이블 파싱
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
      const isNumericStatus = /^\d+\/\d+$/.test(statusRaw);

      if (isNumericStatus) {
        const [used, totalNum] = statusRaw.split('/').map(Number);
        total = totalNum;
        available = used;
        status = (used >= totalNum) ? '정원마감' : getPreReservationStatus(time, todayKST);
        if (status === '정원마감') available = total;
      } else {
        const prev = prevSlotsMap[time];
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
            const slotStart = dayjs.tz(`${todayDateStr} ${time}`, 'YYYY-MM-DD HH:mm', 'Asia/Seoul');
            if (nowKST().isBefore(slotStart)) {
              status = '정원마감';
              available = total;
            } else {
              status = '시간마감';
            }
          }
        } else {
          const slotStart = dayjs.tz(`${todayDateStr} ${time}`, 'YYYY-MM-DD HH:mm', 'Asia/Seoul');
          status = nowKST().isBefore(slotStart) ? '정원마감' : '시간마감';
        }
      }
      result.push({ time, status, available, total });
    });
  });

  // Fallback 처리
  if (result.length === 0) {
    $('a.btn-reserve, a.btn-closed, button.btn-reserve, button.btn-closed').each((k, el) => {
      const raw = $(el).text().trim();
      const time = (raw.match(/\d{1,2}:\d{2}/) || [])[0] || '';
      if (!time) return;

      let status = '', available = null, total = null;
      const nums = raw.match(/\((\d+)\/(\d+)\)/);

      if (nums) {
        const used = Number(nums[1]);
        const totalNum = Number(nums[2]);
        available = used;
        total = totalNum;
        status = (used >= totalNum) ? '정원마감' : getPreReservationStatus(time, todayKST);
        if (status === '정원마감') available = total;
      } else {
        const prev = prevSlotsMap[time];
        if (prev && prev.total != null) {
          available = prev.available;
          total = prev.total;
          const wasFull = prev.status === '정원마감' || prev.available >= prev.total;

          if (wasFull) {
            status = '정원마감';
            available = total;
          } else {
            const slotStart = dayjs.tz(`${todayDateStr} ${time}`, 'YYYY-MM-DD HH:mm', 'Asia/Seoul');
            if (nowKST().isBefore(slotStart)) {
              status = '정원마감';
              available = total;
            } else {
              status = '시간마감';
            }
          }
        } else {
          const slotStart = dayjs.tz(`${todayDateStr} ${time}`, 'YYYY-MM-DD HH:mm', 'Asia/Seoul');
          status = nowKST().isBefore(slotStart) ? '정원마감' : '시간마감';
        }
      }
      result.push({ time, status, available, total });
    });
  }

  // DB에 저장
  if (result.length > 0) {
    db.saveReservations(type, todayDateStr, result);
    console.log(`[Crawl Success] Saved ${result.length} slots for ${type} on ${todayDateStr}`);
  }
}

// 크론 스케줄과 서버 기동 warm-up이 겹칠 경우 동시 실행을 막기 위한 락
let isCrawlAllRunning = false;

// 크롤링 실패 알림용 webhook (Slack Incoming Webhook 등). 미설정 시 알림 없이 로그만 남김
const CRAWL_ALERT_WEBHOOK_URL = process.env.CRAWL_ALERT_WEBHOOK_URL;

async function notifyCrawlFailures(failedTypes) {
  if (!CRAWL_ALERT_WEBHOOK_URL || failedTypes.length === 0) return;
  try {
    await axiosClient.post(CRAWL_ALERT_WEBHOOK_URL, {
      text: `[ipp-reservation-server] 크롤링 실패: ${failedTypes.join(', ')} (${nowKST().format('YYYY-MM-DD HH:mm:ss')})`
    });
  } catch (err) {
    console.error('[Crawl Alert] webhook 전송 실패:', err.message);
  }
}

/**
 * 모든 타입에 대해 순차적으로 크롤링 수행.
 * 이미 실행 중이면(크론과 warm-up 겹침 등) 건너뜀.
 */
async function crawlAll() {
  if (isCrawlAllRunning) {
    console.log('[Scheduler] 이전 크롤링이 아직 실행 중이라 이번 실행은 건너뜁니다.');
    return;
  }

  isCrawlAllRunning = true;
  const types = Object.keys(reservationMap);
  const failedTypes = [];
  console.log(`[Scheduler] Starting batch crawl at ${nowKST().format('YYYY-MM-DD HH:mm:ss')}`);

  try {
    for (const type of types) {
      try {
        await crawlAndSave(type);
      } catch (err) {
        console.error(`[Crawl Error] Failed to crawl ${type}:`, err.message);
        failedTypes.push(type);
      }
    }
  } finally {
    isCrawlAllRunning = false;
  }

  console.log(
    failedTypes.length === 0
      ? `[Scheduler] Batch crawl 완료: ${types.length}개 전체 성공`
      : `[Scheduler] Batch crawl 완료: ${types.length - failedTypes.length}/${types.length}개 성공, 실패: ${failedTypes.join(', ')}`
  );

  await notifyCrawlFailures(failedTypes);
}

module.exports = {
  crawlAll,
  crawlAndSave,
  reservationMap
};
