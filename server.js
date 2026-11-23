"use strict";

const express = require("express");
const https = require("https");

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API;

const VERSION = "4.0.0";
const PROVIDER = "Twelve Data";

const INTERVALS = {
  M1: "1min",
  M5: "5min",
  M15: "15min",
  M30: "30min",
  H1: "1h",
  H4: "4h",
  D1: "1day"
};

const TIMEFRAME_MINUTES = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440
};

const SYMBOLS = {
  EURUSD: { provider: "EUR/USD", pip: 0.0001, digits: 5, type: "forex" },
  GBPUSD: { provider: "GBP/USD", pip: 0.0001, digits: 5, type: "forex" },
  USDJPY: { provider: "USD/JPY", pip: 0.01, digits: 3, type: "forex" },
  USDCHF: { provider: "USD/CHF", pip: 0.0001, digits: 5, type: "forex" },
  AUDUSD: { provider: "AUD/USD", pip: 0.0001, digits: 5, type: "forex" },
  USDCAD: { provider: "USD/CAD", pip: 0.0001, digits: 5, type: "forex" },
  NZDUSD: { provider: "NZD/USD", pip: 0.0001, digits: 5, type: "forex" },
  EURJPY: { provider: "EUR/JPY", pip: 0.01, digits: 3, type: "forex" },
  GBPJPY: { provider: "GBP/JPY", pip: 0.01, digits: 3, type: "forex" },
  EURGBP: { provider: "EUR/GBP", pip: 0.0001, digits: 5, type: "forex" },

  XAUUSD: { provider: "XAU/USD", pip: 0.01, digits: 2, type: "metal" },
  XAGUSD: { provider: "XAG/USD", pip: 0.001, digits: 3, type: "metal" },

  BTCUSD: { provider: "BTC/USD", pip: 1, digits: 2, type: "crypto" },
  ETHUSD: { provider: "ETH/USD", pip: 0.1, digits: 2, type: "crypto" },

  NAS100: { provider: "NDX", pip: 1, digits: 2, type: "index" },
  SPX500: { provider: "SPX", pip: 0.1, digits: 2, type: "index" },
  US30: { provider: "DJI", pip: 1, digits: 2, type: "index" },

  USOIL: { provider: "WTI", pip: 0.01, digits: 2, type: "energy" },
  UKOIL: { provider: "BRENT", pip: 0.01, digits: 2, type: "energy" }
};

const cache = new Map();
const signalHistory = [];
const lastSignals = new Map();

const CACHE_DURATION = 20000;
const MAX_HISTORY = 500;

function round(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function parseDateUTC(value) {
  if (!value) return NaN;

  const text = String(value);

  if (/Z$|[+-]\d{2}:\d{2}$/.test(text)) {
    return new Date(text).getTime();
  }

  return new Date(text.replace(" ", "T") + "Z").getTime();
}

function validTimeframe(timeframe) {
  return Object.prototype.hasOwnProperty.call(INTERVALS, timeframe);
}

function validateSymbol(symbol) {
  return Object.prototype.hasOwnProperty.call(SYMBOLS, symbol);
}

function requestJSON(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      let body = "";

      response.on("data", chunk => {
        body += chunk;
      });

      response.on("end", () => {
        try {
          const data = JSON.parse(body);

          if (response.statusCode !== 200) {
            return reject(
              new Error(data.message || "Erro na fonte de dados.")
            );
          }

          if (
            data.status === "error" ||
            data.code ||
            data.message && !data.values
          ) {
            return reject(
              new Error(data.message || "Erro da Twelve Data.")
            );
          }

          resolve(data);

        } catch (error) {
          reject(new Error("Resposta inválida da fonte de dados."));
        }
      });
    });

    request.setTimeout(15000, () => {
      request.destroy(new Error("Tempo limite da API excedido."));
    });

    request.on("error", reject);
  });
}

async function getRawCandles(symbol, timeframe) {
  if (!API_KEY) {
    throw new Error("TWELVE_DATA_API não configurada no Render.");
  }

  if (!validateSymbol(symbol)) {
    throw new Error("Ativo não configurado.");
  }

  if (!validTimeframe(timeframe)) {
    throw new Error("Timeframe inválido.");
  }

  const cacheKey = `${symbol}_${timeframe}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.time < CACHE_DURATION) {
    return cached.candles;
  }

  const config = SYMBOLS[symbol];

  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", config.provider);
  url.searchParams.set("interval", INTERVALS[timeframe]);
  url.searchParams.set("outputsize", "300");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const data = await requestJSON(url.toString());

  if (!Array.isArray(data.values)) {
    throw new Error(data.message || "Sem dados disponíveis.");
  }

  const candles = data.values.map(item => ({
    time: item.datetime,
    open: Number(item.open),
    high: Number(item.high),
    low: Number(item.low),
    close: Number(item.close),
    volume: item.volume == null ? null : Number(item.volume)
  })).filter(candle => {
    return (
      candle.time &&
      [
        candle.open,
        candle.high,
        candle.low,
        candle.close
      ].every(Number.isFinite) &&
      candle.high >= candle.low &&
      candle.high >= Math.max(candle.open, candle.close) &&
      candle.low <= Math.min(candle.open, candle.close)
    );
  }).sort((a, b) => {
    return parseDateUTC(a.time) - parseDateUTC(b.time);
  });

  if (candles.length < 205) {
    throw new Error(
      `Dados insuficientes: recebidas ${candles.length} velas.`
    );
  }

  for (let i = 1; i < candles.length; i++) {
    if (
      parseDateUTC(candles[i].time) <=
      parseDateUTC(candles[i - 1].time)
    ) {
      throw new Error("Existem timestamps repetidos ou inválidos.");
    }
  }

  cache.set(cacheKey, {
    time: Date.now(),
    candles
  });

  return candles;
}

/*
 * Indicadores técnicos
 */

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (
      values[i] - result
    ) * multiplier + result;
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain = (
      averageGain * (period - 1) +
      Math.max(change, 0)
    ) / period;

    averageLoss = (
      averageLoss * (period - 1) +
      Math.max(-change, 0)
    ) / period;
  }

  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));
}

function calculateATR(candles, period = 14) {
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

  return ranges.slice(-period)
    .reduce((a, b) => a + b, 0) / period;
}

function calculateMACD(values) {
  const line = [];

  for (let i = 0; i < values.length; i++) {
    const current = values.slice(0, i + 1);

    const fast = calculateEMA(current, 12);
    const slow = calculateEMA(current, 26);

    if (fast !== null && slow !== null) {
      line.push(fast - slow);
    }
  }

  if (line.length < 35) {
    return {
      line: null,
      signal: null,
      histogram: null
    };
  }

  const signal = calculateEMA(line, 9);
  const current = line[line.length - 1];

  return {
    line: current,
    signal,
    histogram: signal === null ? null : current - signal
  };
}

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;

  const plusDM = [];
  const minusDM = [];
  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;

    plusDM.push(
      upMove > downMove && upMove > 0 ? upMove : 0
    );

    minusDM.push(
      downMove > upMove && downMove > 0 ? downMove : 0
    );

    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  const dx = [];

  for (let i = period - 1; i < trueRanges.length; i++) {
    const tr = trueRanges.slice(i - period + 1, i + 1)
      .reduce((a, b) => a + b, 0);

    const positive = plusDM.slice(i - period + 1, i + 1)
      .reduce((a, b) => a + b, 0);

    const negative = minusDM.slice(i - period + 1, i + 1)
      .reduce((a, b) => a + b, 0);

    if (tr === 0) continue;

    const plusDI = 100 * positive / tr;
    const minusDI = 100 * negative / tr;

    const total = plusDI + minusDI;

    dx.push(
      total === 0
        ? 0
        : 100 * Math.abs(plusDI - minusDI) / total
    );
  }

  if (dx.length < period) return null;

  return dx.slice(-period)
    .reduce((a, b) => a + b, 0) / period;
}

/*
 * Estrutura do mercado
 */

function findSwings(candles) {
  const highs = [];
  const lows = [];

  const start = Math.max(2, candles.length - 100);
  const end = candles.length - 2;

  for (let i = start; i < end; i++) {
    const c = candles[i];

    if (
      c.high > candles[i - 1].high &&
      c.high > candles[i - 2].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high
    ) {
      highs.push({
        price: c.high,
        index: i
      });
    }

    if (
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low
    ) {
      lows.push({
        price: c.low,
        index: i
      });
    }
  }

  return { highs, lows };
}

function analyzeStructure(candles) {
  const swings = findSwings(candles);
  const last = candles[candles.length - 1];

  const previousHigh = swings.highs.length
    ? swings.highs[swings.highs.length - 1]
    : null;

  const previousLow = swings.lows.length
    ? swings.lows[swings.lows.length - 1]
    : null;

  let trend = "RANGE";
  let event = "NONE";

  if (
    previousHigh &&
    last.close > previousHigh.price
  ) {
    trend = "BULLISH";
    event = "BOS_UP";
  } else if (
    previousLow &&
    last.close < previousLow.price
  ) {
    trend = "BEARISH";
    event = "BOS_DOWN";
  }

  const recentHighs = swings.highs.slice(-2);
  const recentLows = swings.lows.slice(-2);

  if (recentHighs.length === 2 && recentLows.length === 2) {
    const higherHigh =
      recentHighs[1].price > recentHighs[0].price;

    const higherLow =
      recentLows[1].price > recentLows[0].price;

    const lowerHigh =
      recentHighs[1].price < recentHighs[0].price;

    const lowerLow =
      recentLows[1].price < recentLows[0].price;

    if (higherHigh && higherLow) trend = "BULLISH";
    if (lowerHigh && lowerLow) trend = "BEARISH";
  }

  return {
    trend,
    event,
    lastSwingHigh: previousHigh
      ? previousHigh.price
      : null,
    lastSwingLow: previousLow
      ? previousLow.price
      : null
  };
}

/*
 * Suporte e resistência
 */

function calculateLevels(candles) {
  const recent = candles.slice(-50);

  return {
    support: Math.min(...recent.map(c => c.low)),
    resistance: Math.max(...recent.map(c => c.high))
  };
}

/*
 * Padrões de velas
 */

function detectCandlePattern(candles) {
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;

  if (range <= 0) return "NONE";

  const upperWick =
    last.high - Math.max(last.open, last.close);

  const lowerWick =
    Math.min(last.open, last.close) - last.low;

  if (
    last.close > last.open &&
    previous.close < previous.open &&
    last.close > previous.open &&
    last.open < previous.close
  ) {
    return "BULLISH_ENGULFING";
  }

  if (
    last.close < last.open &&
    previous.close > previous.open &&
    last.close < previous.open &&
    last.open > previous.close
  ) {
    return "BEARISH_ENGULFING";
  }

  if (
    lowerWick > body * 2 &&
    upperWick < body &&
    body / range < 0.4
  ) {
    return "HAMMER";
  }

  if (
    upperWick > body * 2 &&
    lowerWick < body &&
    body / range < 0.4
  ) {
    return "SHOOTING_STAR";
  }

  if (body / range < 0.1) return "DOJI";

  return "NONE";
}

/*
 * Qualidade dos dados e velas fechadas
 */

function getClosedCandles(candles, timeframe) {
  const duration = TIMEFRAME_MINUTES[timeframe] * 60000;
  const now = Date.now();

  return candles.filter(candle => {
    const start = parseDateUTC(candle.time);

    return (
      Number.isFinite(start) &&
      start + duration <= now
    );
  });
}

function assessDataQuality(candles, timeframe) {
  if (!candles.length) {
    return {
      valid: false,
      reason: "Sem velas disponíveis."
    };
  }

  const last = candles[candles.length - 1];

  const ageMinutes = (
    Date.now() - (
      parseDateUTC(last.time) +
      TIMEFRAME_MINUTES[timeframe] * 60000
    )
  ) / 60000;

  const repeated = candles.slice(-30).filter((c, i, arr) => {
    if (i === 0) return false;

    const previous = arr[i - 1];

    return (
      c.open === previous.open &&
      c.high === previous.high &&
      c.low === previous.low &&
      c.close === previous.close
    );
  }).length;

  const maxAge = Math.max(
    5,
    TIMEFRAME_MINUTES[timeframe] * 3
  );

  const fresh =
    Number.isFinite(ageMinutes) &&
    ageMinutes >= 0 &&
    ageMinutes <= maxAge;

  const valid = (
    candles.length >= 205 &&
    fresh &&
    repeated < 8
  );

  return {
    valid,
    candleCount: candles.length,
    repeatedCandles: repeated,
    ageMinutes: round(ageMinutes, 2),
    fresh,
    lastClosedCandle: last.time,
    reason: valid
      ? "Dados aprovados nas verificações básicas."
      : "Dados antigos, repetidos ou insuficientes."
  };
}

/*
 * Análise de um timeframe
 */

function analyzeTimeframe(candles, timeframe) {
  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);

  const rsi = calculateRSI(closes);
  const atr = calculateATR(candles);
  const macd = calculateMACD(closes);
  const adx = calculateADX(candles);

  const structure = analyzeStructure(candles);
  const levels = calculateLevels(candles);
  const pattern = detectCandlePattern(candles);

  let score = 0;
  const reasons = [];

  if (ema9 > ema21) {
    score++;
    reasons.push("EMA9 acima da EMA21");
  } else {
    score--;
    reasons.push("EMA9 abaixo da EMA21");
  }

  if (ema21 > ema50) {
    score++;
    reasons.push("EMA21 acima da EMA50");
  } else {
    score--;
    reasons.push("EMA21 abaixo da EMA50");
  }

  if (last.close > ema200) {
    score++;
    reasons.push("Preço acima da EMA200");
  } else {
    score--;
    reasons.push("Preço abaixo da EMA200");
  }

  if (rsi >= 50 && rsi < 70) {
    score++;
    reasons.push("RSI comprador");
  } else if (rsi > 30 && rsi < 50) {
    score--;
    reasons.push("RSI vendedor");
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
    reasons.push("Estrutura bullish");
  } else if (structure.trend === "BEARISH") {
    score--;
    reasons.push("Estrutura bearish");
  }

  if (
    pattern === "BULLISH_ENGULFING" ||
    pattern === "HAMMER"
  ) {
    score++;
    reasons.push("Padrão de vela comprador");
  }

  if (
    pattern === "BEARISH_ENGULFING" ||
    pattern === "SHOOTING_STAR"
  ) {
    score--;
    reasons.push("Padrão de vela vendedor");
  }

  let trend = "NEUTRAL";

  if (score >= 3) trend = "BULLISH";
  if (score <= -3) trend = "BEARISH";

  return {
    timeframe,
    price: last.close,
    score,
    trend,
    indicators: {
      ema9,
      ema21,
      ema50,
      ema200,
      rsi,
      macd,
      atr,
      adx
    },
    structure,
    levels,
    candlePattern: pattern,
    reasons
  };
}

/*
 * Gestão de risco
 */

function calculateRiskPlan(
  signal,
  entry,
  atr,
  symbol
) {
  if (signal === "WAIT" || !atr || atr <= 0) {
    return null;
  }

  const config = SYMBOLS[symbol];

  const stopDistance = Math.max(
    atr * 1.5,
    config.pip * 5
  );

  let sl;
  let tp1;
  let tp2;
  let tp3;

  if (signal === "BUY") {
    sl = entry - stopDistance;
    tp1 = entry + stopDistance;
    tp2 = entry + stopDistance * 2;
    tp3 = entry + stopDistance * 3;
  } else {
    sl = entry + stopDistance;
    tp1 = entry - stopDistance;
    tp2 = entry - stopDistance * 2;
    tp3 = entry - stopDistance * 3;
  }

  const pip = config.pip;

  return {
    entry: round(entry, config.digits),
    stopLoss: round(sl, config.digits),

    takeProfit: {
      tp1: round(tp1, config.digits),
      tp2: round(tp2, config.digits),
      tp3: round(tp3, config.digits)
    },

    distances: {
      stopLossPips: round(stopDistance / pip, 1),
      tp1Pips: round(stopDistance / pip, 1),
      tp2Pips: round(stopDistance * 2 / pip, 1),
      tp3Pips: round(stopDistance * 3 / pip, 1),

      unit: config.type === "forex"
        ? "pips"
        : "points"
    },

    riskReward: {
      tp1: "1:1",
      tp2: "1:2",
      tp3: "1:3"
    },

    riskWarning:
      "Os valores são estimativas técnicas. Spread, comissão, slippage e especificações da corretora podem alterar o resultado."
  };
}

/*
 * Análise principal multi-timeframe
 */

async function performAnalysis(symbol, timeframe, mode) {
  if (!validateSymbol(symbol)) {
    throw new Error("Ativo não suportado.");
  }

  if (!validTimeframe(timeframe)) {
    throw new Error("Timeframe inválido.");
  }

  const candles = await getRawCandles(symbol, timeframe);

  const closedCandles = getClosedCandles(
    candles,
    timeframe
  );

  if (closedCandles.length < 205) {
    throw new Error(
      "Não existem velas fechadas suficientes."
    );
  }

  const quality = assessDataQuality(
    closedCandles,
    timeframe
  );

  const main = analyzeTimeframe(
    closedCandles,
    timeframe
  );

  /*
   * Timeframes de confirmação.
   * Para M1/M5/M15 usamos M15, H1 e H4.
   */

  const confirmationFrames = ["M15", "H1", "H4"];

  const confirmations = {};

  for (const tf of confirmationFrames) {
    if (tf === timeframe) {
      confirmations[tf] = main;
      continue;
    }

    try {
      const otherCandles = await getRawCandles(symbol, tf);

      const otherClosed = getClosedCandles(
        otherCandles,
        tf
      );

      if (otherClosed.length >= 205) {
        confirmations[tf] = analyzeTimeframe(
          otherClosed,
          tf
        );
      } else {
        confirmations[tf] = {
          trend: "UNAVAILABLE",
          score: 0
        };
      }
    } catch (error) {
      confirmations[tf] = {
        trend: "UNAVAILABLE",
        score: 0
      };
    }
  }

  const trends = Object.values(confirmations);

  const bullishCount = trends.filter(
    item => item.trend === "BULLISH"
  ).length;

  const bearishCount = trends.filter(
    item => item.trend === "BEARISH"
  ).length;

  let signal = "WAIT";

  const patternBullish = [
    "BULLISH_ENGULFING",
    "HAMMER"
  ].includes(main.candlePattern);

  const patternBearish = [
    "BEARISH_ENGULFING",
    "SHOOTING_STAR"
  ].includes(main.candlePattern);

  const rsi = main.indicators.rsi;
  const adx = main.indicators.adx;

  const buyConditions = (
    main.score >= 4 &&
    main.structure.trend !== "BEARISH" &&
    rsi >= 40 &&
    rsi < 70 &&
    main.indicators.macd.histogram > 0 &&
    (bullishCount >= 2 || patternBullish) &&
    (adx === null || adx >= 15)
  );

  const sellConditions = (
    main.score <= -4 &&
    main.structure.trend !== "BULLISH" &&
    rsi > 30 &&
    rsi <= 60 &&
    main.indicators.macd.histogram < 0 &&
    (bearishCount >= 2 || patternBearish) &&
    (adx === null || adx >= 15)
  );

  if (quality.valid) {
    if (buyConditions) signal = "BUY";
    if (sellConditions) signal = "SELL";
  }

  const riskPlan = calculateRiskPlan(
    signal,
    main.price,
    main.indicators.atr,
    symbol
  );

  const confidence = Math.min(
    95,
    Math.max(
      0,
      Math.round(
        Math.abs(main.score) / 7 * 60 +
        Math.max(bullishCount, bearishCount) * 10
      )
    )
  );

  const result = {
    status: "success",
    application: "SBC-ULTIMATE",
    version: VERSION,

    mode: mode === "REAL" ? "REAL_ANALYSIS" : "DEMO_ANALYSIS",

    provider: PROVIDER,

    warning:
      "Análise externa. Não é uma ligação direta à Exness MT5 e não executa ordens.",

    symbol,
    providerSymbol: SYMBOLS[symbol].provider,
    assetType: SYMBOLS[symbol].type,
    timeframe,

    signal,
    score: main.score,
    confidence,

    price: round(main.price, SYMBOLS[symbol].digits),

    entry: riskPlan ? riskPlan.entry : null,
    stopLoss: riskPlan ? riskPlan.stopLoss : null,

    takeProfit: riskPlan
      ? riskPlan.takeProfit
      : {
          tp1: null,
          tp2: null,
          tp3: null
        },

    distances: riskPlan
      ? riskPlan.distances
      : null,

    riskReward: riskPlan
      ? riskPlan.riskReward
      : null,

    indicators: main.indicators,

    marketStructure: main.structure,

    supportResistance: main.levels,

    candlePattern: main.candlePattern,

    confirmations,

    dataQuality: quality,

    candleTime: closedCandles[
      closedCandles.length - 1
    ].time,

    reasons: main.reasons,

    generatedAt: new Date().toISOString()
  };

  /*
   * Histórico de sinais.
   */

  const historyKey = [
    symbol,
    timeframe,
    signal,
    result.candleTime
  ].join("_");

  if (
    signal !== "WAIT" &&
    !lastSignals.has(historyKey)
  ) {
    lastSignals.set(historyKey, true);

    signalHistory.unshift({
      id: historyKey,
      symbol,
      timeframe,
      signal,
      entry: result.entry,
      stopLoss: result.stopLoss,
      takeProfit: result.takeProfit,
      time: result.generatedAt,
      mode: result.mode
    });

    if (signalHistory.length > MAX_HISTORY) {
      signalHistory.pop();
    }
  }

  return result;
}

/*
 * API
 */

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    application: "SBC-ULTIMATE",
    version: VERSION,
    engine: "advanced-multitimeframe-v4",
    provider: PROVIDER,
    apiConfigured: Boolean(API_KEY),
    marketData: API_KEY ? "configured" : "not configured",
    timeframes: Object.keys(INTERVALS),
    execution: "NOT_CONNECTED",
    realTradingEnabled: false
  });
});

app.get("/api/market", async (req, res) => {
  try {
    const symbol = String(
      req.query.symbol || "EURUSD"
    ).toUpperCase();

    const timeframe = String(
      req.query.timeframe || "M15"
    ).toUpperCase();

    const candles = await getRawCandles(
      symbol,
      timeframe
    );

    const closed = getClosedCandles(
      candles,
      timeframe
    );

    res.json({
      status: "success",
      symbol,
      providerSymbol: SYMBOLS[symbol].provider,
      timeframe,
      candlesReceived: candles.length,
      closedCandles: closed.length,
      latestClosedCandle: closed.length
        ? closed[closed.length - 1]
        : null,
      dataQuality: assessDataQuality(
        closed,
        timeframe
      ),
      candles: closed
    });

  } catch (error) {
    res.status(400).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/api/analyze", async (req, res) => {
  try {
    const symbol = String(
      req.query.symbol || "EURUSD"
    ).toUpperCase();

    const timeframe = String(
      req.query.timeframe || "M15"
    ).toUpperCase();

    const mode = String(
      req.query.mode || "DEMO"
    ).toUpperCase();

    if (!["DEMO", "REAL"].includes(mode)) {
      throw new Error("Modo inválido. Usa DEMO ou REAL.");
    }

    const result = await performAnalysis(
      symbol,
      timeframe,
      mode
    );

    res.json(result);

  } catch (error) {
    res.status(400).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const symbol = String(
      req.body.symbol || "EURUSD"
    ).toUpperCase();

    const timeframe = String(
      req.body.timeframe || "M15"
    ).toUpperCase();

    const mode = String(
      req.body.mode || "DEMO"
    ).toUpperCase();

    if (!["DEMO", "REAL"].includes(mode)) {
      throw new Error("Modo inválido.");
    }

    const result = await performAnalysis(
      symbol,
      timeframe,
      mode
    );

    res.json(result);

  } catch (error) {
    res.status(400).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/api/history", (req, res) => {
  res.json({
    status: "success",
    count: signalHistory.length,
    history: signalHistory
  });
});

app.get("/api/symbols", (req, res) => {
  res.json({
    status: "success",
    symbols: Object.keys(SYMBOLS).map(symbol => ({
      symbol,
      providerSymbol: SYMBOLS[symbol].provider,
      type: SYMBOLS[symbol].type,
      pipSize: SYMBOLS[symbol].pip,
      digits: SYMBOLS[symbol].digits
    }))
  });
});

app.get("/", (req, res) => {
  res.sendFile(
    require("path").join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, () => {
  console.log("--------------------------------");
  console.log("SBC-ULTIMATE V4");
  console.log("Advanced Trading Intelligence");
  console.log("Porta: " + PORT);
  console.log("Dados: " + PROVIDER);
  console.log("API configurada: " + Boolean(API_KEY));
  console.log("Execução MT5: NÃO LIGADA");
  console.log("--------------------------------");
});
