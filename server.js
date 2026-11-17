const express = require("express");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));
const PORT=process.env.PORT||3000;
const TD=process.env.TWELVE_DATA_API;
const ALLOWED=["1min","5min","15min","30min","1h","4h","1day"];
const ASSETS={
 forex:["EUR/USD","GBP/USD","USD/JPY","USD/CHF","USD/CAD","AUD/USD","NZD/USD","EUR/GBP","EUR/JPY","GBP/JPY","EUR/CHF","EUR/CAD","AUD/JPY","GBP/CHF","AUD/CAD","AUD/NZD","CAD/JPY","CHF/JPY","EUR/AUD","EUR/NZD","GBP/AUD","GBP/CAD","NZD/JPY"],
 metals:["XAU/USD","XAG/USD"],
 crypto:["BTC/USD","ETH/USD","BNB/USD","SOL/USD","XRP/USD"]
};
const cache=new Map();
const decimals=s=>s.includes("JPY")?3:(s.startsWith("XAU")||s.startsWith("XAG"))?2:(s.startsWith("BTC")||s.startsWith("ETH"))?2:5;
function ema(a,p){let k=2/(p+1),v=a[0];for(let i=1;i<a.length;i++)v=a[i]*k+v*(1-k);return v;}
function rsi(a,p=14){let g=0,l=0;for(let i=a.length-p;i<a.length;i++){let d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}if(l===0)return 100;return 100-100/(1+(g/p)/(l/p));}
function atr(c,p=14){let t=[];for(let i=1;i<c.length;i++){let h=+c[i].high,l=+c[i].low,pc=+c[i-1].close;t.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}return t.slice(-p).reduce((x,y)=>x+y,0)/Math.min(p,t.length);}
function macd(a){return ema(a.slice(-40),12)-ema(a.slice(-40),26);}
function round(x,d){return Number.isFinite(x)?+x.toFixed(d):null;}
async function candles(symbol,interval){
 if(!TD)throw Error("TWELVE_DATA_API não configurada no servidor.");
 const key=symbol+"|"+interval,old=cache.get(key);
 if(old&&Date.now()-old.time<30000)return old.data;
 const u=new URL("https://api.twelvedata.com/time_series");
 Object.entries({symbol,interval,outputsize:"120",apikey:TD}).forEach(([k,v])=>u.searchParams.set(k,v));
 const r=await fetch(u);const j=await r.json();
 if(!r.ok||j.status==="error"||!j.values)throw Error(j.message||"Fornecedor não devolveu candles.");
 const c=j.values.slice().reverse();
 if(c.length<40)throw Error("Dados insuficientes: são necessárias pelo menos 40 velas.");
 cache.set(key,{time:Date.now(),data:c});return c;
}
app.get("/api/status",(q,s)=>s.json({name:"KILLCRITIC-SBC",status:"online",provider:TD?"Twelve Data configurada":"API em falta",execution:"MT5 requer EA e terminal/VPS"}));
app.get("/api/assets",(q,s)=>s.json({assets:ASSETS,indices:{status:"not_configured",message:"Índices exigem fornecedor que cubra os símbolos e a corretora escolhida."}}));
app.get("/api/analyze",async(q,s)=>{
 try{
  const symbol=String(q.query.symbol||"EUR/USD").toUpperCase(),interval=String(q.query.interval||"15min");
  if(!ALLOWED.includes(interval))return s.status(400).json({error:"Timeframe inválido."});
  const supported=Object.values(ASSETS).flat();
  if(!supported.includes(symbol))return s.status(400).json({error:"Ativo ainda não configurado para esta fonte.",symbol});
  const c=await candles(symbol,interval),cl=c.map(x=>+x.close),d=decimals(symbol);
  const e9=ema(cl.slice(-60),9),e21=ema(cl.slice(-80),21),rv=rsi(cl),av=atr(c),m=macd(cl),price=cl.at(-1);
  if(!(av>0))throw Error("ATR inválido; sem níveis de risco fiáveis.");
  const bullish=e9>e21&&rv>=52&&rv<70&&m>0;
  const bearish=e9<e21&&rv<=48&&rv>30&&m<0;
  const signal=bullish?"BUY":bearish?"SELL":"AGUARDAR";
  const entry=price, sl=signal==="BUY"?price-1.5*av:signal==="SELL"?price+1.5*av:null;
  const tps=signal==="BUY"?[price+1.5*av,price+2.25*av,price+3*av]:signal==="SELL"?[price-1.5*av,price-2.25*av,price-3*av]:[null,null,null];
  const risk=signal==="AGUARDAR"?null:Math.abs(entry-sl);
  s.json({provider:"Twelve Data",symbol,interval,asOf:c.at(-1).datetime,analysis:{signal,direction:signal==="BUY"?"COMPRA":signal==="SELL"?"VENDA":"AGUARDAR",entry:round(entry,d),stopLoss:round(sl,d),tp1:round(tps[0],d),tp2:round(tps[1],d),tp3:round(tps[2],d),riskReward:signal==="AGUARDAR"?null:"1:1 / 1:1.5 / 1:2"},indicators:{ema9:round(e9,d),ema21:round(e21,d),rsi14:round(rv,2),macd:round(m,d),atr14:round(av,d)},market:{lastPrice:round(price,d),lastCandle:c.at(-1).datetime},warning:"Análise técnica probabilística; não garante lucro. Verifique spread, slippage e regras do instrumento."});
 }catch(e){s.status(502).json({error:e.message});}
});
app.listen(PORT,"0.0.0.0",()=>console.log("KILLCRITIC-SBC online na porta "+PORT));
