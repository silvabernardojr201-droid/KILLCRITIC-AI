const express = require("express");
const https = require("https");
const app = express();

app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API;

const INTERVALS = {
  M1: "1min",
  M5: "5min",
  M15: "15min",
  M30: "30min",
  H1: "1h",
  H4: "4h",
  D1: "1day"
};

const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDCHF: "USD/CHF",
  AUDUSD: "AUD/USD",
  USDCAD: "USD/CAD",
  NZDUSD: "NZD/USD",
  EURJPY: "EUR/JPY",
  GBPJPY: "GBP/JPY",
  EURGBP: "EUR/GBP",
  XAUUSD: "XAU/USD",
  XAGUSD: "XAG/USD",
  BTCUSD: "BTC/USD",
  ETHUSD: "ETH/USD"
};

const cache = new Map();
const CACHE_TIME = 15000;

function requestJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      let body = "";

      response.on("data", chunk => body += chunk);
      response.on("end", () => {
        try {
          const data = JSON.parse(body);

          if (response.statusCode !== 200 || data.status === "error" || data.code) {
            return reject(new Error(data.message || "Erro no fornecedor de dados."));
          }

          resolve(data);
        } catch {
          reject(new Error("Resposta inválida do fornecedor de dados."));
        }
      });
    }).on("error", reject);
  });
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  return ranges.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateMACD(values) {
  const fast = [];
  const slow = [];

  for (let i = 0; i < values.length; i++) {
    fast.push(ema(values.slice(0, i + 1), 12));
    slow.push(ema(values.slice(0, i + 1), 26));
  }

  const macdLine = fast.map((value, i) =>
    value !== null && slow[i] !== null ? value - slow[i] : null
  ).filter(value => value !== null);

  const signal = ema(macdLine, 9);
  const current = macdLine[macdLine.length - 1];

  return {
    line: current,
    signal,
    histogram: signal === null ? null : current - signal
  };
}

function candlePattern(candles) {
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  if (range <= 0) return "Sem padrão confirmado";

  if (
    last.close > last.open &&
    previous.close < previous.open &&
    last.close > previous.open &&
    last.open < previous.close
  ) return "Bullish Engulfing";

  if (
    last.close < last.open &&
    previous.close > previous.open &&
    last.close < previous.open &&
    last.open > previous.close
  ) return "Bearish Engulfing";

  if (lowerWick > body * 2 && upperWick < body && body / range < 0.4) {
    return "Hammer";
  }

  if (upperWick > body * 2 && lowerWick < body && body / range < 0.4) {
    return "Shooting Star";
  }

  if (body / range < 0.1) return "Doji";

  return "Sem padrão confirmado";
}

function marketStructure(candles) {
  const points = candles.slice(-80);
  const highs = [];
  const lows = [];

  for (let i = 2; i < points.length - 2; i++) {
    const c = points[i];

    if (
      c.high > points[i - 1].high &&
      c.high > points[i - 2].high &&
      c.high > points[i + 1].high &&
      c.high > points[i + 2].high
    ) highs.push({ index: i, price: c.high });

    if (
      c.low < points[i - 1].low &&
      c.low < points[i - 2].low &&
      c.low < points[i + 1].low &&
      c.low < points[i + 2].low
    ) lows.push({ index: i, price: c.low });
  }

  const last = points[points.length - 1];
  const previousHigh = highs.length ? highs[highs.length - 1].price : null;
  const previousLow = lows.length ? lows[lows.length - 1].price : null;

  let structure = "RANGE";
  let event = "Nenhum rompimento confirmado";

  if (previousHigh !== null && last.close > previousHigh) {
    structure = "BULLISH";
    event = "BOS de alta";
  } else if (previousLow !== null && last.close < previousLow) {
    structure = "BEARISH";
    event = "BOS de baixa";
  }

  return {
    trend: structure,
    event,
    lastSwingHigh: previousHigh,
    lastSwingLow: previousLow
  };
}

function supportResistance(candles) {
  const recent = candles.slice(-50);

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}

function getAgeMinutes(timestamp) {
  const date = new Date(timestamp.replace(" ", "T") + "Z");
  return (Date.now() - date.getTime()) / 60000;
}

function getFreshness(timeframe, age) {
  const limits = {
    M1: 5,
    M5: 12,
    M15: 35,
    M30: 65,
    H1: 130,
    H4: 500,
    D1: 1800
  };

  return {
    ageMinutes: Number(age.toFixed(2)),
    fresh: Number.isFinite(age) && age >= -2 && age <= limits[timeframe]
  };
}

async function getCandles(symbol, timeframe) {
  if (!API_KEY) throw new Error("API KEY não configurada.");

  const providerSymbol = SYMBOLS[symbol];
  if (!providerSymbol) throw new Error("Ativo ainda não configurado.");

  const key = `${symbol}_${timeframe}`;
  const cached = cache.get(key);

  if (cached && Date.now() - cached.time < CACHE_TIME) {
    return cached.candles;
  }

  const interval = INTERVALS[timeframe];
  if (!interval) throw new Error("Timeframe inválido.");

  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", providerSymbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", "250");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const data = await requestJSON(url.toString());

  if (!data.values || !Array.isArray(data.values)) {
    throw new Error(data.message || "Não foram recebidas velas.");
  }

  const candles = data.values.map(item => ({
    time: item.datetime,
    open: Number(item.open),
    high: Number(item.high),
    low: Number(item.low),
    close: Number(item.close),
    volume: item.volume == null ? null : Number(item.volume)
  })).filter(c =>
    c.time &&
    [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= c.low &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close)
  ).reverse();

  if (candles.length < 205) {
    throw new Error("Dados insuficientes para análise de tendência longa.");
  }

  for (let i = 1; i < candles.length; i++) {
    if (new Date(candles[i].time) <= new Date(candles[i - 1].time)) {
      throw new Error("Sequência de velas inválida.");
    }
  }

  cache.set(key, { time: Date.now(), candles });

  return candles;
}

function analyzeCandles(candles, symbol, timeframe) {
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsiValue = rsi(closes);
  const atrValue = atr(candles);
  const macd = calculateMACD(closes);
  const structure = marketStructure(candles);
  const levels = supportResistance(candles);
  const pattern = candlePattern(candles);

  const age = getAgeMinutes(last.time);
  const freshness = getFreshness(timeframe, age);

  const repeated = candles.slice(-20).filter((c, i, arr) =>
    i > 0 && c.open === arr[i - 1].open &&
    c.high === arr[i - 1].high &&
    c.low === arr[i - 1].low &&
    c.close === arr[i - 1].close
  ).length;

  const quality = {
    candleCount: candles.length,
    repeatedCandles: repeated,
    freshness,
    valid: freshness.fresh && repeated < 8
  };

  let score = 0;
  const reasons = [];

  if (ema9 > ema21) {
    score++;
    reasons.push("EMA 9 acima da EMA 21");
  } else {
    score--;
    reasons.push("EMA 9 abaixo da EMA 21");
  }

  if (ema21 > ema50) {
    score++;
    reasons.push("Tendência intermédia positiva");
  } else {
    score--;
    reasons.push("Tendência intermédia negativa");
  }

  if (last.close > ema200) {
    score++;
    reasons.push("Preço acima da EMA 200");
  } else {
    score--;
    reasons.push("Preço abaixo da EMA 200");
  }

  if (rsiValue >= 50 && rsiValue < 70) {
    score++;
    reasons.push("RSI favorece compradores");
  } else if (rsiValue <= 50 && rsiValue > 30) {
    score--;
    reasons.push("RSI favorece vendedores");
  } else {
    reasons.push("RSI em zona extrema ou neutra");
  }

  if (macd.histogram > 0) {
    score++;
    reasons.push("Histograma MACD positivo");
  } else if (macd.histogram < 0) {
    score--;
    reasons.push("Histograma MACD negativo");
  }

  if (structure.trend === "BULLISH") {
    score++;
    reasons.push("Estrutura de mercado bullish");
  } else if (structure.trend === "BEARISH") {
    score--;
    reasons.push("Estrutura de mercado bearish");
  }

  if (pattern === "Bullish Engulfing" || pattern === "Hammer") {
    score++;
    reasons.push("Padrão de vela comprador: " + pattern);
  }

  if (pattern === "Bearish Engulfing" || pattern === "Shooting Star") {
    score--;
    reasons.push("Padrão de vela vendedor: " + pattern);
  }

  let signal = "WAIT";

  if (
    quality.valid &&
    score >= 4 &&
    rsiValue < 70 &&
    structure.trend !== "BEARISH"
  ) {
    signal = "BUY";
  } else if (
    quality.valid &&
    score <= -4 &&
    rsiValue > 30 &&
    structure.trend !== "BULLISH"
  ) {
    signal = "SELL";
  }

  let entry = null;
  let stopLoss = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (signal !== "WAIT" && atrValue > 0) {
    entry = last.close;

    if (signal === "BUY") {
      stopLoss = entry - atrValue * 1.5;
      tp1 = entry + atrValue * 1.5;
      tp2 = entry + atrValue * 2.5;
      tp3 = entry + atrValue * 3.5;
    } else {
      stopLoss = entry + atrValue * 1.5;
      tp1 = entry - atrValue * 1.5;
      tp2 = entry - atrValue * 2.5;
      tp3 = entry - atrValue * 3.5;
    }
  }

  if (!quality.valid) {
    signal = "WAIT";
    reasons.push("Dados insuficientes, repetidos ou desatualizados.");
  }

  return {
    status: "success",
    application: "SBC-ULTIMATE",
    provider: "Twelve Data",
    symbol,
    providerSymbol: SYMBOLS[symbol],
    timeframe,
    signal,
    score,
    price: last.close,
    entry,
    stopLoss,
    takeProfit: { tp1, tp2, tp3 },
    indicators: {
      ema9,
      ema21,
      ema50,
      ema200,
      rsi: rsiValue,
      macd,
      atr: atrValue
    },
    marketStructure: structure,
    supportResistance: levels,
    candlePattern: pattern,
    dataQuality: quality,
    candleTime: last.time,
    reasons,
    warning: "Dados externos. Não representam uma ligação direta ao gráfico MT5 da Exness."
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    application: "SBC-ULTIMATE",
    engine: "technical-analysis-v3",
    provider: "Twelve Data",
    apiConfigured: Boolean(API_KEY),
    marketData: API_KEY ? "configured" : "not configured"
  });
});

app.get("/api/market", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "EURUSD").toUpperCase();
    const timeframe = String(req.query.timeframe || "M15").toUpperCase();

    const candles = await getCandles(symbol, timeframe);
    const last = candles[candles.length - 1];
    const age = getAgeMinutes(last.time);

    res.json({
      status: "success",
      symbol: SYMBOLS[symbol],
      timeframe,
      price: last.close,
      candleTime: last.time,
      freshness: getFreshness(timeframe, age),
      candles
    });
  } catch (error) {
    res.status(400).json({ status: "error", message: error.message });
  }
});

app.get("/api/analyze", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "EURUSD").toUpperCase();
    const timeframe = String(req.query.timeframe || "M15").toUpperCase();

    const candles = await getCandles(symbol, timeframe);
    res.json(analyzeCandles(candles, symbol, timeframe));
  } catch (error) {
    res.status(400).json({ status: "error", message: error.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const symbol = String(req.body.symbol || "EURUSD").toUpperCase();
    const timeframe = String(req.body.timeframe || "M15").toUpperCase();

    const candles = await getCandles(symbol, timeframe);
    res.json(analyzeCandles(candles, symbol, timeframe));
  } catch (error) {
    res.status(400).json({ status: "error", message: error.message });
  }
});

app.listen(PORT, () => {
  console.log("SBC-ULTIMATE online na porta " + PORT);
});
