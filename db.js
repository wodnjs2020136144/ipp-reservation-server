// db.js — SQLite 데이터베이스 초기화 및 데이터 액세스 오브젝트 (DAO)
const Database = require('better-sqlite3');
const path = require('path');

// 프로젝트 루트의 data.db 파일을 사용
const dbPath = path.resolve(__dirname, 'data.db');
const db = new Database(dbPath);

// WAL 모드 활성화 (동시 읽기/쓰기 성능 향상)
db.pragma('journal_mode = WAL');

// 테이블 초기화
db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    type TEXT NOT NULL,
    target_date TEXT NOT NULL,
    time TEXT NOT NULL,
    status TEXT NOT NULL,
    available INTEGER,
    total INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (type, target_date, time)
  )
`);

/**
 * 특정 날짜의 예약 리스트를 DB에 일괄 저장 (UPSERT)
 * @param {string} type - 예약 종류 (ai, drone 등)
 * @param {string} targetDate - 대상 날짜 (YYYY-MM-DD)
 * @param {Array<{time: string, status: string, available: number|null, total: number|null}>} slots - 슬롯 목록
 */
function saveReservations(type, targetDate, slots) {
  const insert = db.prepare(`
    INSERT INTO reservations (type, target_date, time, status, available, total, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(type, target_date, time) DO UPDATE SET
      status = excluded.status,
      available = excluded.available,
      total = excluded.total,
      updated_at = datetime('now', 'localtime')
  `);

  // 트랜잭션으로 안전하고 빠르게 일괄 처리
  const transaction = db.transaction((rows) => {
    for (const row of rows) {
      insert.run(type, targetDate, row.time, row.status, row.available, row.total);
    }
  });

  transaction(slots);
}

/**
 * 특정 종류와 날짜의 예약 현황 조회
 * @param {string} type 
 * @param {string} targetDate (YYYY-MM-DD)
 * @returns {Array}
 */
function getReservations(type, targetDate) {
  const stmt = db.prepare(`
    SELECT time, status, available, total, updated_at
    FROM reservations
    WHERE type = ? AND target_date = ?
    ORDER BY time ASC
  `);
  return stmt.all(type, targetDate);
}

/**
 * 특정 날짜의 모든 예약 현황 조회
 * @param {string} targetDate (YYYY-MM-DD)
 * @returns {Object} 그룹화된 결과
 */
function getReservationsAll(targetDate) {
  const stmt = db.prepare(`
    SELECT type, time, status, available, total, updated_at
    FROM reservations
    WHERE target_date = ?
    ORDER BY type, time ASC
  `);
  const rows = stmt.all(targetDate);

  // 그룹별 구조화 (ai, drone, science 등)
  const result = {
    ipp: { ai: [], earthquake: [], drone: [] },
    commentator: { science: [], toddler: [], robot: [] }
  };

  for (const row of rows) {
    const item = { time: row.time, status: row.status, available: row.available, total: row.total };
    if (result.ipp[row.type]) {
      result.ipp[row.type].push(item);
    } else if (result.commentator[row.type]) {
      result.commentator[row.type].push(item);
    }
  }

  return result;
}

module.exports = {
  saveReservations,
  getReservations,
  getReservationsAll
};
