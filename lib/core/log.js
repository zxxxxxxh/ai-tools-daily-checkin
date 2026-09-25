'use strict';

/** 统一日志：console + 追加项目根 checkin.log（run-checkin.bat 不再重定向，由本文件独家落盘） */

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'checkin.log');

function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

/** 与旧格式逐字节一致：[2026/9/25 10:10:00] msg */
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch { /* 日志落盘失败不影响签到 */ }
}

module.exports = { log, LOG_FILE };
