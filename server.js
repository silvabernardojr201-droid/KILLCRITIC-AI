const express = require("express");

const app = express();

app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API;

// Ativos configurados
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

// Timeframes suportados pela API
const ALLOWED_INTERVALS = [
  "1min", "5min", "15min",
  "30min", "1h", "4h", "1day"
];

// Precisão dos preços
function getDecimals(symbol) {
  if (symbol.includes("JPY")) return 3;
  if (symbol.startsWith("XAU") || symbol.startsWith("XAG")) return 2;
  if (symbol.includes("BTC") || symbol.includes("ETH")) return 2;
  return 5;
}

// EMA
function calculateEMA(data, period) {
  const multiplier = 2 / (period + 1);
  let ema = data[0];

  for (let i = 1; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }

  return ema;
}

// RSI
function calculateRSI(data, period = 14) {
  let gains = 0;
  let losses = 0;

  for (let i = data.length - period; i < data.length; i++) {
    const change = data[i] - data[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

// ATR
function calculateATR(candles, period = 14) {
  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const high = Number(current.high);
    const low = Number(current.low);
    const previousClose = Number(previous.close);

    const tr = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );

    ranges.push(tr);
  }

  const recent = ranges.slice(-period);

  if (!recent.length) return 0;

  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// Formatação numérica
function formatPrice(value, decimals) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

// Página inicial
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// Estado do bot
app.get("/api/status", (req, res) => {
  res.json({
    bot: "KILLCRITIC-AI",
    status: "ONLINE",
    market: "Forex, Metais e Criptomoedas",
    apiConfigured: Boolean(API_KEY)
  });
});

// Lista de ativos
app.get("/api/pairs", (req, res) => {
  res.json({
    total: PAIRS.length,
    pairs: PAIRS
  });
});

// Análise do mercado
app.get("/api/analyze", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "EUR/USD").toUpperCase();
    const interval = req.query.interval || "15min";

    if (!API_KEY) {
      return res.status(503).json({
        error: "API KEY não configurada.",
        instruction: "Configure TWELVE_DATA_API no Render."
      });
    }

    if (!PAIRS.includes(symbol)) {
      return res.status(400).json({
        error: "Ativo não suportado.",
        availablePairs: PAIRS
      });
    }

    if (!ALLOWED_INTERVALS.includes(interval)) {
      return res.status(400).json({
        error: "Timeframe inválido.",
        allowedIntervals: ALLOWED_INTERVALS
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
        error: "Não foi possível obter dados do mercado.",
        details: result.message || "Erro na Twelve Data."
      });
    }

    if (!result.values || result.values.length < 30) {
      return res.status(502).json({
        error: "Dados insuficientes para análise."
      });
    }

    const candles = result.values.slice().reverse();

    const closes = candles.map(c => Number(c.close));

    if (closes.some(value => !Number.isFinite(value))) {
      return res.status(502).json({
        error: "Dados de preços inválidos."
      });
    }

    const price = closes[closes.length - 1];

    const ema9 = calculateEMA(closes.slice(-30), 9);
    const ema21 = calculateEMA(closes.slice(-50), 21);
    const rsi = calculateRSI(closes);
    const atr = calculateATR(candles);

    // Sinal e níveis de operação
    let signal = "AGUARDAR";
    let entry = price;
    let stopLoss = null;
    let tp1 = null;
    let tp2 = null;
    let tp3 = null;

    if (ema9 > ema21 && rsi > 50 && rsi < 70) {
      signal = "BUY";

      stopLoss = price - (atr * 1.5);
      tp1 = price + (atr * 1.5);
      tp2 = price + (atr * 2);
      tp3 = price + (atr * 3);

    } else if (ema9 < ema21 && rsi < 50 && rsi > 30) {
      signal = "SELL";

      stopLoss = price + (atr * 1.5);
      tp1 = price - (atr * 1.5);
      tp2 = price - (atr * 2);
      tp3 = price - (atr * 3);
    }

    const decimals = getDecimals(symbol);

    // Resultado da análise
    return res.json({
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

        entry: formatPrice(entry, decimals),
        stopLoss: formatPrice(stopLoss, decimals),

        tp1: formatPrice(tp1, decimals),
        tp2: formatPrice(tp2, decimals),
        tp3: formatPrice(tp3, decimals),

        // Compatibilidade com versões antigas do painel
        takeProfit: formatPrice(tp3, decimals),

        riskReward: "1:2"
      },

      indicators: {
        EMA9: formatPrice(ema9, decimals),
        EMA21: formatPrice(ema21, decimals),
        RSI14: Number(rsi.toFixed(2)),
        ATR14: formatPrice(atr, decimals)
      },

      market: {
        currentPrice: formatPrice(price, decimals),
        lastCandle: candles[candles.length - 1].datetime
      },

      warning: "Sinal técnico, não é garantia de lucro."
    });

  } catch (error) {
    console.error("Erro na análise:", error);

    return res.status(500).json({
      error: "Erro interno na análise.",
      details: error.message
    });
  }
});

// Inicialização
app.listen(PORT, "0.0.0.0", () => {
  console.log(`KILLCRITIC-AI ONLINE na porta ${PORT}`);
});
