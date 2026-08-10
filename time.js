// time.js — KST(Asia/Seoul) 시간 유틸 (index.js, crawler.js, agent.js 공용)
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const nowKST = () => dayjs().tz('Asia/Seoul');
const todayKSTStr = () => nowKST().format('YYYY-MM-DD');

module.exports = { nowKST, todayKSTStr };
