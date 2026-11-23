const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const API_KEY = process.env.TWELVE_DATA_API;

const INTERVALS = {
  M1: "1min",
  M5: "5min",
  M15: "15min",
  M30: "30min",
  H1: "1h",
  H4: "4h"
};

const SYMBOLS = {
  EURUSD: "EUR/USD",
  "EUR/USD": "EUR/USD",
  XAUUSD: "XAU/USD",
  "XAU/USD": "XAU/USD"
};

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  const averageGain = gains / period;
  const averageLoss = losses / period;

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  const recent = ranges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function macd(values) {
  if (values.length < 35) return null;

  const fast = ema(values, 12);
  const slow = ema(values, 26);

  if (fast === null || slow === null) return null;

  return fast - slow;
}

function getPipSize(symbol) {
  if (symbol.includes("XAU")) return 0.01;
  if (symbol.includes("JPY")) return 0.01;
  return 0.0001;
}

function getIntervalMinutes(timeframe) {
  const map = {
    M1: 1,
    M5: 5,
    M15: 15,
    M30: 30,
    H1: 60,
    H4: 240
  };

  return map[timeframe];
}

async function getCandles(symbol, timeframe, outputsize = 250) {
  if (!API_KEY) {
    throw new Error("API_KEY_NOT_CONFIGURED");
  }

  const interval = INTERVALS[timeframe];

  if (!interval) {
    throw new Error("INVALID_TIMEFRAME");
  }

  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("format", "JSON");
  url.searchParams.set("timezone", "UTC");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("DATA_PROVIDER_HTTP_ERROR");
  }

  const data = await response.json();

  if (data.status === "error" || !Array.isArray(data.values)) {
    const error = new Error("DATA_PROVIDER_ERROR");
    error.providerMessage = data.message || "Dados indisponíveis";
    throw error;
  }

  const candles = data.values
    .map(item => ({
      datetime: item.datetime,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: item.volume ? Number(item.volume) : null
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low
    )
    .reverse();

  if (candles.length < 60) {
    throw new Error("INSUFFICIENT_CANDLES");
  }

  return candles;
}

function checkFreshness(candles, timeframe) {
  const latest = candles[candles.length - 1];

  const timestamp = Date.parse(
    latest.datetime.replace(" ", "T") + "Z"
  );

  if (!Number.isFinite(timestamp)) {
    return {
      fresh: false,
      ageMinutes: null
    };
  }

  const ageMinutes = (Date.now() - timestamp) / 60000;
  const allowedAge = getIntervalMinutes(timeframe) * 3 + 5;

  return {
    fresh: ageMinutes >= -2 && ageMinutes <= allowedAge,
    ageMinutes: Math.max(0, ageMinutes)
  };
}

function analyzeCandles(candles, symbol, timeframe) {
  const closes = candles.map(c => c.close);

  const last = closes[closes.length - 1];

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const rsiValue = rsi(closes);
  const macdValue = macd(closes);
  const atrValue = atr(candles);

  if (
    ema9 === null ||
    ema21 === null ||
    ema50 === null ||
    ema200 === null ||
    rsiValue === null ||
    macdValue === null ||
    atrValue === null
  ) {
    throw new Error("INDICATORS_NOT_READY");
  }

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

  if (last > ema200) {
    score++;
    reasons.push("Preço acima da EMA 200");
  } else {
    score--;
    reasons.push("Preço abaixo da EMA 200");
  }

  if (rsiValue >= 50 && rsiValue < 70) {
    score++;
    reasons.push("RSI favorece compradores");
  } else if (rsiValue < 50 && rsiValue > 30) {
    score--;
    reasons.push("RSI favorece vendedores");
  } else {
    reasons.push("RSI em zona extrema ou sem confirmação");
  }

  if (macdValue > 0) {
    score++;
    reasons.push("MACD positivo");
  } else {
    score--;
    reasons.push("MACD negativo");
  }

  let signal = "WAIT";

  if (score >= 4 && rsiValue < 70) {
    signal = "BUY";
  } else if (score <= -4 && rsiValue > 30) {
    signal = "SELL";
  }

  const direction = signal === "BUY" ? 1 : -1;
  const entry = last;

  let sl = null;
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  if (signal !== "WAIT") {
    sl = entry - direction * atrValue * 1.5;
    tp1 = entry + direction * atrValue * 1.5;
    tp2 = entry + direction * atrValue * 2.5;
    tp3 = entry + direction * atrValue * 3.5;
  }

  const pipSize = getPipSize(symbol);

  return {
    symbol,
    timeframe,
    signal,
    score,
    price: last,
    entry,
    stopLoss: sl,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp3,
    indicators: {
      ema9,
      ema21,
      ema50,
      ema200,
      rsi: rsiValue,
      macd: macdValue,
      atr: atrValue
    },
    pipSize,
    reasons,
    candleCount: candles.length,
    candleTime: candles[candles.length - 1].datetime,
    warning: "Análise técnica experimental. Não garante resultados."
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    application: "SBC-ULTIMATE",
    engine: "technical-analysis-v2",
    provider: "Twelve Data",
    apiConfigured: Boolean(API_KEY),
    marketData: API_KEY ? "configured" : "not_connected"
  });
});

app.get("/api/market", async (req, res) => {
  try {
    const symbolInput = String(req.query.symbol || "EURUSD").toUpperCase();
    const timeframe = String(req.query.timeframe || "M15").toUpperCase();

    const symbol = SYMBOLS[symbolInput];

    if (!symbol) {
      return res.status(400).json({
        error: "Símbolo não suportado nesta fase."
      });
    }

    if (!INTERVALS[timeframe]) {
      return res.status(400).json({
        error: "Timeframe inválido."
      });
    }

    const candles = await getCandles(symbol, timeframe);
    const freshness = checkFreshness(candles, timeframe);

    if (!freshness.fresh) {
      return res.status(503).json({
        status: "stale_data",
        symbol,
        timeframe,
        freshness,
        message: "Dados possivelmente desatualizados. Sinais bloqueados."
      });
    }

    res.json({
      status: "success",
      symbol,
      timeframe,
      freshness,
      candles
    });

  } catch (error) {
    res.status(502).json({
      status: "error",
      message: error.message,
      providerMessage: error.providerMessage || null
    });
  }
});

app.get("/api/analyze", async (req, res) => {
  try {
    const symbolInput = String(req.query.symbol || "EURUSD").toUpperCase();
    const timeframe = String(req.query.timeframe || "M15").toUpperCase();

    const symbol = SYMBOLS[symbolInput];

    if (!symbol) {
      return res.status(400).json({
        error: "Símbolo não suportado."
      });
    }

    if (!INTERVALS[timeframe]) {
      return res.status(400).json({
        error: "Timeframe inválido."
      });
    }

    const candles = await getCandles(symbol, timeframe);
    const freshness = checkFreshness(candles, timeframe);

    if (!freshness.fresh) {
      return res.status(503).json({
        status: "stale_data",
        message: "Dados desatualizados. Nenhum sinal emitido.",
        freshness
      });
    }

    const analysis = analyzeCandles(candles, symbol, timeframe);

    res.json({
      status: "success",
      dataSource: "Twelve Data",
      freshness,
      analysis
    });

  } catch (error) {
    res.status(502).json({
      status: "error",
      message: error.message,
      providerMessage: error.providerMessage || null
    });
  }
});

app.post("/api/analyze", (req, res) => {
  try {
    const { symbol, timeframe, candles } = req.body;

    if (
      !symbol ||
      !INTERVALS[timeframe] ||
      !Array.isArray(candles) ||
      candles.length < 200
    ) {
      return res.status(400).json({
        error: "São necessárias pelo menos 200 velas válidas."
      });
    }

    const validCandles = candles.map(c => ({
      datetime: c.datetime || null,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }));

    if (validCandles.some(c =>
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      c.high < c.low
    )) {
      return res.status(400).json({
        error: "Velas inválidas."
      });
    }

    const result = analyzeCandles(
      validCandles,
      String(symbol).toUpperCase(),
      timeframe
    );

    res.json({
      status: "success",
      analysis: result
    });

  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`SBC-ULTIMATE ativo na porta ${PORT}`);
});
