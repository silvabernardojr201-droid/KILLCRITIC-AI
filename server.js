const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let result = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
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

    avgGain = (avgGain * (period - 1) +
      Math.max(change, 0)) / period;

    avgLoss = (avgLoss * (period - 1) +
      Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
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

  return ranges.slice(-period)
    .reduce((a, b) => a + b, 0) / period;
}

function round(value, digits = 5) {
  return Number(value.toFixed(digits));
}

function analyze({ symbol, timeframe, candles, pipSize }) {

  if (!Array.isArray(candles) || candles.length < 60) {
    throw new Error("São necessárias pelo menos 60 velas.");
  }

  const data = candles.map(c => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }));

  for (const c of data) {
    if (
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      c.high < c.low
    ) {
      throw new Error("Dados das velas inválidos.");
    }
  }

  const closes = data.map(c => c.close);
  const price = closes[closes.length - 1];

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const rsi14 = rsi(closes);
  const atr14 = atr(data);

  const macdValues = [];

  for (let i = 25; i < closes.length; i++) {
    const sample = closes.slice(0, i + 1);

    macdValues.push(
      ema(sample, 12) - ema(sample, 26)
    );
  }

  const macd = macdValues[macdValues.length - 1];

  const macdSignal = macdValues.length >= 9
    ? ema(macdValues, 9)
    : null;

  const bullish = [];
  const bearish = [];

  if (ema9 > ema21) bullish.push("EMA 9 acima da EMA 21");
  else bearish.push("EMA 9 abaixo da EMA 21");

  if (ema21 > ema50) bullish.push("EMA 21 acima da EMA 50");
  else bearish.push("EMA 21 abaixo da EMA 50");

  if (price > ema50) bullish.push("Preço acima da EMA 50");
  else bearish.push("Preço abaixo da EMA 50");

  if (rsi14 >= 52 && rsi14 <= 70) {
    bullish.push("RSI favorece compradores");
  }

  if (rsi14 <= 48 && rsi14 >= 30) {
    bearish.push("RSI favorece vendedores");
  }

  if (macdSignal !== null && macd > macdSignal) {
    bullish.push("MACD positivo");
  }

  if (macdSignal !== null && macd < macdSignal) {
    bearish.push("MACD negativo");
  }

  let direction = "WAIT";
  let score = 45;
  let reasons = [
    "Confluência insuficiente. Aguardar confirmação."
  ];

  if (
    bullish.length >= 4 &&
    bullish.length > bearish.length &&
    rsi14 < 75
  ) {
    direction = "BUY";
    score = Math.min(
      95,
      55 + bullish.length * 8 - bearish.length * 4
    );

    reasons = bullish;

  } else if (
    bearish.length >= 4 &&
    bearish.length > bullish.length &&
    rsi14 > 25
  ) {
    direction = "SELL";
    score = Math.min(
      95,
      55 + bearish.length * 8 - bullish.length * 4
    );

    reasons = bearish;
  } else {
    reasons = reasons.concat(
      bullish.length >= bearish.length
        ? bullish
        : bearish
    );
  }

  const pip = Number(pipSize) > 0
    ? Number(pipSize)
    : (/JPY/i.test(symbol) ? 0.01 : 0.0001);

  const digits = pip >= 0.1 ? 2 : pip >= 0.001 ? 3 : 5;

  let entry = null;
  let stopLoss = null;
  let targets = [null, null, null];
  let riskPips = null;

  if (direction !== "WAIT" && atr14 > 0) {

    entry = price;

    const distance = Math.max(
      atr14 * 1.5,
      pip * 5
    );

    if (direction === "BUY") {
      stopLoss = entry - distance;

      targets = [
        entry + distance,
        entry + distance * 2,
        entry + distance * 3
      ];

    } else {
      stopLoss = entry + distance;

      targets = [
        entry - distance,
        entry - distance * 2,
        entry - distance * 3
      ];
    }

    riskPips = Math.abs(entry - stopLoss) / pip;
  }

  const recent = data.slice(-20);

  const recentHigh = Math.max(
    ...recent.map(c => c.high)
  );

  const recentLow = Math.min(
    ...recent.map(c => c.low)
  );

  return {

    symbol,
    timeframe,
    direction,

    quality: score >= 80
      ? "FORTE"
      : score >= 65
        ? "NORMAL"
        : "FRACA",

    score,

    price: round(price, digits),

    entry: entry === null
      ? null
      : round(entry, digits),

    stopLoss: stopLoss === null
      ? null
      : round(stopLoss, digits),

    takeProfits: {
      tp1: targets[0] === null ? null : round(targets[0], digits),
      tp2: targets[1] === null ? null : round(targets[1], digits),
      tp3: targets[2] === null ? null : round(targets[2], digits)
    },

    riskPips: riskPips === null
      ? null
      : round(riskPips, 1),

    rewardPips: riskPips === null
      ? null
      : {
          tp1: round(riskPips, 1),
          tp2: round(riskPips * 2, 1),
          tp3: round(riskPips * 3, 1)
        },

    indicators: {
      ema9: round(ema9, digits),
      ema21: round(ema21, digits),
      ema50: round(ema50, digits),

      ema200: ema200 === null
        ? null
        : round(ema200, digits),

      rsi14: round(rsi14, 2),
      macd: round(macd, digits),

      macdSignal: macdSignal === null
        ? null
        : round(macdSignal, digits),

      atr14: round(atr14, digits)
    },

    marketStructure: {
      recentHigh: round(recentHigh, digits),
      recentLow: round(recentLow, digits)
    },

    reasons,

    warning:
      "Análise técnica experimental. Não garante lucro. Confirmar spread, execução e risco antes de operar."
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    application: "SBC-ULTIMATE",
    engine: "technical-analysis-v1",
    marketData: "not_connected",
    message:
      "Motor online. Falta ligar uma fonte real de velas do MT5."
  });
});

app.post("/api/analyze", (req, res) => {

  try {
    const {
      symbol,
      timeframe,
      candles,
      pipSize
    } = req.body || {};

    if (!symbol || typeof symbol !== "string") {
      throw new Error(
        "Indica um símbolo, por exemplo EURUSDm ou XAUUSDm."
      );
    }

    if (!TIMEFRAMES.includes(timeframe)) {
      throw new Error(
        "Timeframe inválido."
      );
    }

    const result = analyze({
      symbol,
      timeframe,
      candles,
      pipSize
    });

    res.json(result);

  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, () => {
  console.log(
    `SBC-ULTIMATE online na porta ${PORT}`
  );
});
