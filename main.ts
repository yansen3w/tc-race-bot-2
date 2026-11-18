// Dip-hunter II: a slow mean-reversion bot for the cbBTC 24h race.
//
// The market is Coinbase Wrapped BTC against USDC, one-minute bars, $1,000 of
// paper money, long only. A full round trip costs about 34 bps (4 bps fee,
// 2 bps slippage, roughly 11 bps of pool impact on a $1,000 trade), so this
// bot trades rarely and only on deep dips: it buys the whole stake when the
// close falls below the lower Bollinger band (120 one-minute closes, 1.5 sigma)
// while the 14-bar RSI is under 30, and it sells the whole position at 2.5%
// over its cost or at 0.5% under it. After any exit it waits 180 bars before
// it may enter again. If it is still flat at bar 1200 it buys the trend
// instead (close above its 240-bar average), so the entry never ends a window
// without a trade.
//
// Retuned for the 2026-11-18 dev window (a falling day, -2.8% close to close):
// the shorter 120-bar band and wider 2.5% take-profit catch the dip-and-
// recover swings that the 300-bar band missed, while the tight 0.5% stop and
// long cooldown keep losing trades small and rare. Local grade on the dev
// window (see README) decides the gate; the race window is unseen.
//
// Deterministic: the same bars give the same orders, run after run. No clock,
// no environment, no randomness; every number comes from the bars in the
// batches. One position, full size, at most one order per reply.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BB_N = 120;
const BB_SIGMA = 1.5;
const RSI_N = 14;
const RSI_IN = 30;
const ROI_NUM = 10250n; // exit when the position is worth 102.5% of its cost
const ROI_DEN = 10000n;
const STOP_NUM = 9950n; // exit when the position is worth 99.5% of its cost
const STOP_DEN = 10000n;
const COOLDOWN = 180; // bars to wait after an exit before the next entry
const FALLBACK_BAR = 1200; // if still flat this late, buy the trend instead
const SMA_N = 240;
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
let rsiGain: number | null = null;
let rsiLoss: number | null = null;
const rsiFirst: Array<[number, number]> = [];
let lastClose: number | null = null;
let lastExit = -1e9;

function buyOrder(state: BarsState): BuyInput | null {
  const room = state.weightRoom(SYMBOL);
  const amount = state.cash < room ? state.cash : room;
  if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state, batch) {
    const priceScale = state.hello.symbols.find((s) => s.symbol === SYMBOL)!.price_scale;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const price = Number(bar.c) / 10 ** priceScale;
      closes.push(price);
      if (lastClose !== null) {
        const change = price - lastClose;
        const up = change > 0 ? change : 0;
        const down = change < 0 ? -change : 0;
        if (rsiGain === null || rsiLoss === null) {
          rsiFirst.push([up, down]);
          if (rsiFirst.length === RSI_N) {
            rsiGain = rsiFirst.reduce((a, [u]) => a + u, 0) / RSI_N;
            rsiLoss = rsiFirst.reduce((a, [, d]) => a + d, 0) / RSI_N;
          }
        } else {
          rsiGain = (rsiGain * (RSI_N - 1) + up) / RSI_N;
          rsiLoss = (rsiLoss * (RSI_N - 1) + down) / RSI_N;
        }
      }
      lastClose = price;
    }
    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      if (value * ROI_DEN >= held.cost * ROI_NUM || value * STOP_DEN <= held.cost * STOP_NUM) {
        lastExit = state.seq;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }
    if (state.seq - lastExit < COOLDOWN) return [];
    if (closes.length < BB_N) return [];
    const window = closes.slice(-BB_N);
    const mean = window.reduce((a, x) => a + x, 0) / BB_N;
    const variance = window.reduce((a, x) => a + (x - mean) * (x - mean), 0) / BB_N;
    const lower = mean - BB_SIGMA * Math.sqrt(variance);
    let rsi: number | null = null;
    if (rsiGain !== null && rsiLoss !== null) {
      const moved = rsiGain + rsiLoss;
      rsi = moved === 0 ? 50 : (100 * rsiGain) / moved;
    }
    if (rsi !== null && rsi < RSI_IN && closes[closes.length - 1] < lower) {
      const buy = buyOrder(state);
      return buy === null ? [] : [buy];
    }
    if (state.seq >= FALLBACK_BAR && closes.length >= SMA_N) {
      const sma = closes.slice(-SMA_N).reduce((a, x) => a + x, 0) / SMA_N;
      const hourAgo = closes[closes.length - 61];
      if (closes[closes.length - 1] > sma && closes[closes.length - 1] >= hourAgo) {
        const buy = buyOrder(state);
        return buy === null ? [] : [buy];
      }
    }
    return [];
  },
});
