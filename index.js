const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'http://giavangmaothiet.com/tiem-vang-van-ngoc-anh-cap-nhat-gia-vang-hom-nay/';
const TARGET_URL = process.env.TARGET_URL || DEFAULT_URL;
const PRICE_THRESHOLD = Number(process.env.PRICE_THRESHOLD) || 16000000;
const MAX_HISTORY = Number(process.env.MAX_HISTORY) || 10;
const HISTORY_PATH = path.join(__dirname, 'prices.json');
const STATE_PATH = path.join(__dirname, 'state.json');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;

function stripDiacritics(input) {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function parseNumber(text) {
  const digits = text.replace(/[^\d]/g, '');
  return digits ? Number(digits) : NaN;
}

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
      'Accept-Language': 'vi,en;q=0.8',
    },
    maxRedirects: 3,
  });
  return data;
}

async function fetchCurrentPrice() {
  let html;
  try {
    html = await fetchHtml(TARGET_URL);
  } catch (err) {
    // Nếu URL https lỗi chứng chỉ/redirect, thử http fallback
    if (TARGET_URL.startsWith('https://')) {
      const fallback = TARGET_URL.replace(/^https:/, 'http:');
      console.warn(`HTTPS lỗi (${err.message}), thử lại với ${fallback}`);
      html = await fetchHtml(fallback);
    } else {
      throw err;
    }
  }
  const $ = cheerio.load(html);
  let price = null;

  $('tr').each((_, tr) => {
    if (price) return;
    const cells = $(tr)
      .find('td,th')
      .map((i, td) => $(td).text().trim())
      .get();
    if (!cells.length) return;

    const flat = stripDiacritics(cells.join(' '));
    if (flat.includes('vang 9999') && flat.includes('van ngoc anh')) {
      // prefer the first numeric cell after the name
      const numericCells = cells
        .slice(1)
        .map(parseNumber)
        .filter((n) => !Number.isNaN(n));
      if (numericCells.length) {
        price = numericCells[0];
      }
    }
  });

  if (!price) {
    throw new Error('Không tìm được giá vàng 9999 Vân Ngọc Anh trong trang đích.');
  }

  return price;
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed;
  } catch (err) {
    console.warn(`Không đọc được ${filePath}, dùng giá trị mặc định.`);
    return fallback;
  }
}

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Thiếu TELEGRAM_TOKEN hoặc TELEGRAM_CHAT_ID; bỏ qua gửi thông báo.');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
  });
}

function shouldTriggerDowntrend(prices, current) {
  const extended = [...prices, current];
  if (extended.length < 4) return false;
  const len = extended.length;
  const p3 = extended[len - 4];
  const p2 = extended[len - 3];
  const p1 = extended[len - 2];
  const p0 = extended[len - 1];
  return p3 > p2 && p2 > p1 && p1 > p0;
}

async function main() {
  const history = loadJson(HISTORY_PATH, []);
  const state = loadJson(STATE_PATH, {});

  const currentPrice = await fetchCurrentPrice();
  console.log(`Giá hiện tại: ${currentPrice.toLocaleString('vi-VN')}đ`);

  const alerts = [];

  if (currentPrice <= PRICE_THRESHOLD) {
    alerts.push({
      type: 'threshold',
      text: `⚠️ Giá vàng <= ${PRICE_THRESHOLD.toLocaleString('vi-VN')}đ\nHiện tại: ${currentPrice.toLocaleString(
        'vi-VN'
      )}đ`,
    });
  }

  if (shouldTriggerDowntrend(history, currentPrice)) {
    const lastThree = history.slice(-3).map((p) => p.toLocaleString('vi-VN')).join(' > ');
    alerts.push({
      type: 'downtrend',
      text: `⬇️ Giá giảm 3 phiên liên tiếp\nChuỗi: ${lastThree} > ${currentPrice.toLocaleString(
        'vi-VN'
      )}đ`,
    });
  }

  const uniqueAlerts = alerts.filter(
    (a) => !state.lastAlert || a.type !== state.lastAlert.type || currentPrice !== state.lastAlert.price
  );

  for (const alert of uniqueAlerts) {
    try {
      await sendTelegram(alert.text);
      state.lastAlert = {
        type: alert.type,
        price: currentPrice,
        at: new Date().toISOString(),
      };
      console.log(`Đã gửi cảnh báo: ${alert.type}`);
    } catch (err) {
      console.error(`Lỗi gửi Telegram: ${err.message}`);
    }
  }

  const nextHistory = [...history, currentPrice].slice(-MAX_HISTORY);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(nextHistory, null, 2));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
