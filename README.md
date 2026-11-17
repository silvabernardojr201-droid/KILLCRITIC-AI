# KILLCRITIC-SBC — pacote inicial de reconstrução

## O que já funciona neste pacote
- Interface web responsiva e instalável como PWA.
- Backend Node/Express.
- Análise de candles reais via Twelve Data, se `TWELVE_DATA_API` estiver configurada.
- EMA 9/21, RSI 14, MACD simplificado e ATR 14.
- SL/TP calculados por ATR para BUY/SELL; em AGUARDAR os níveis ficam vazios.
- Atualização automática do painel a cada 60 segundos.
- Índices explicitamente marcados como não configurados, sem inventar cotações.

## Deploy no Render
1. Substitua os ficheiros do repositório pelos deste pacote.
2. Build command: `npm install`
3. Start command: `npm start`
4. Configure Environment Variable `TWELVE_DATA_API` com a sua chave Twelve Data.
5. Não coloque a chave no HTML, GitHub ou APK.
6. Teste `https://SEU-SERVICO/api/status` e `.../api/analyze?symbol=EUR%2FUSD&interval=15min`.

## APK
Este pacote ainda não contém um APK compilado. A página é PWA; pode ser instalada pelo Chrome em Android (menu ⋮ > Instalar aplicação/Adicionar ao ecrã inicial). Para gerar APK nativo, é necessário empacotar com Capacitor/Android Studio ou um pipeline Android e assinar o APK.

## Limites reais e integrações pendentes
- A chave Twelve Data, limites do plano e disponibilidade de cada símbolo/timeframe condicionam os dados.
- TradingView embed é um gráfico externo; não é garantia de que o feed do gráfico seja idêntico ao feed Twelve Data.
- Índices: é necessário contratar/configurar uma fonte que cubra NAS100, US30, SPX500 etc. e mapear os símbolos da corretora. O backend não os simula.
- Execução MT5: exige MetaTrader 5 desktop num PC/VPS Windows com EA, autorização WebRequest, endpoint autenticado, mapeamento de símbolos da JustMarkets e testes DEMO. Um APK Android sozinho não consegue executar um EA MT5.
- `mt5/KILLCRITIC_Bridge.mq5` é apenas um esqueleto bloqueado por defeito; não envia ordens. Não ative negociação real com este ficheiro.

## Segurança
- Não publique API keys, Firebase service-account JSON ou passwords.
- A autenticação Firebase do código antigo não foi incluída nesta versão inicial da interface. Reintegrar Firebase Auth antes de abrir o serviço ao público.
- Estratégias técnicas podem perder dinheiro. Use demo, limites de risco e supervisão humana.
