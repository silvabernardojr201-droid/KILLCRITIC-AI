const express = require("express");

const app = express();

app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API;

const PAIRS = [
  // Forex
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF",
  "USD/CAD", "AUD/USD", "NZD/USD", "EUR/GBP",
  "EUR/JPY", "GBP/JPY", "EUR/CHF", "EUR/CAD",
  "AUD/JPY", "GBP/CHF", "AUD/CAD", "AUD/NZD",
  "CAD/JPY", "CHF/JPY", "EUR/AUD", "EUR/NZD",
  "GBP/AUD", "GBP/CAD", "NZD/JPY",

  // Metais
  "XAU/USD", "XAG/USD",

  // Criptomoedas
  "BTC/USD", "ETH/USD", "BNB/USD",
  "SOL/USD", "XRP/USD"
];

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.get("/api/status", (req, res) => {
  res.json({
    bot: "KILLCRITIC-AI",
    status: "ONLINE",
    market: "Forex",
    apiConfigured: !!API_KEY
  });
});

app.get("/api/pairs", (req, res) => {
  res.json({
    total: PAIRS.length,
    pairs: PAIRS
  });
});

// Cálculo EMA
function calculateEMA(data, period) {
  const multiplier = 2 / (period + 1);
  let ema = data[0];

  for (let i = 1; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }

  return ema;
}

// Cálculo RSI
function calculateRSI(data, period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = data.length - period; i < data.length; i++) {
    const change = data[i] - data[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

// Cálculo ATR
function calculateATR(candles, period = 14) {
  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      Number(current.high) - Number(current.low),
      Math.abs(Number(current.high) - Number(previous.close)),
      Math.abs(Number(current.low) - Number(previous.close))
    );

    ranges.push(tr);
  }

  const recent = ranges.slice(-period);

  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// Análise de mercado
app.get("/api/analyze", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "EUR/USD").toUpperCase();
    const interval = req.query.interval || "15min";

    if (!API_KEY) {
      return res.status(503).json({
        error: "API KEY não configurada.",
        instruction: "Configure TWELVE_DATA_API_KEY no Render."
      });
    }

    if (!PAIRS.includes(symbol)) {
      return res.status(400).json({
        error: "Par não suportado.",
        availablePairs: PAIRS
      });
    }

    const allowedIntervals = [
      "1min", "5min", "15min",
      "30min", "1h", "4h", "1day"
    ];

    if (!allowedIntervals.includes(interval)) {
      return res.status(400).json({
        error: "Timeframe inválido."
      });
    }

    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("apikey", API_KEY);

    const response = await fetch(url);
    const result = await response.json();

    if (!response.ok || result.status === "error") {
      return res.status(502).json({
        error: "Erro ao obter dados do mercado.",
        details: result.message || "Verifique a API."
      });
    }

    if (!result.values || result.values.length < 30) {
      return res.status(502).json({
        error: "Dados insuficientes para análise."
      });
    }

    const candles = result.values.reverse();

    const closes = candles.map(c => Number(c.close));

    const price = closes[closes.length - 1];

    const ema9 = calculateEMA(closes.slice(-30), 9);
    const ema21 = calculateEMA(closes.slice(-50), 21);

    const rsi = calculateRSI(closes);
    const atr = calculateATR(candles);

    let signal = "NEUTRAL";
    let entry = price;
    let stopLoss = null;
    let takeProfit = null;

    if (ema9 > ema21 && rsi > 50 && rsi < 70) {
      signal = "BUY";

      stopLoss = price - (atr * 1.5);
      takeProfit = price + (atr * 3);
    }

    if (ema9 < ema21 && rsi < 50 && rsi > 30) {
      signal = "SELL";

      stopLoss = price + (atr * 1.5);
      takeProfit = price - (atr * 3);
    }

    const decimals = symbol.includes("JPY") ? 3 : 5;

    res.json({
      bot: "KILLCRITIC-AI",
      pair: symbol,
      timeframe: interval,

      analysis: {
        signal,
        direction: signal === "BUY"
          ? "COMPRA"
          : signal === "SELL"
          ? "VENDA"
          : "AGUARDAR",

        entry: Number(entry.toFixed(decimals)),

        stopLoss: stopLoss === null
          ? null
          : Number(stopLoss.toFixed(decimals)),

        takeProfit: takeProfit === null
          ? null
          : Number(takeProfit.toFixed(decimals)),

        riskReward: "1:2"
      },

      indicators: {
        EMA9: Number(ema9.toFixed(decimals)),
        EMA21: Number(ema21.toFixed(decimals)),
        RSI14: Number(rsi.toFixed(2)),
        ATR14: Number(atr.toFixed(decimals))
      },

      market: {
        currentPrice: price,
        lastCandle: candles[candles.length - 1].datetime
      },

      warning: "Sinal técnico, não é garantia de lucro."
    });

  } catch (error) {
    res.status(500).json({
      error: "Erro interno na análise.",
      details: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KILLCRITIC-AI ONLINE na porta ${PORT}`);
});
