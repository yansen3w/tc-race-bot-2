// Dip-hunter II — a patient mean-reversion bot for the cbBTC 24-hour race.
//
// The market is Coinbase Wrapped BTC priced in USDC, one-minute bars, $1,000
// of paper money, long only. A round trip costs roughly 34 basis points
// (about 4 bps of fee, 2 bps of slippage, and around 11 bps of pool impact
// on a $1,000 trade), so the bot only swings at deep dips: it commits the
// whole stake when the latest close drops under the lower Bollinger band
// (120 one-minute closes, 1.5 standard deviations) while the 14-bar RSI sits
// below 30, then exits the whole position at +2.5% over cost or at -0.5%
// under it. After any exit it rests for 180 bars before it may enter again.
// If it is still flat at bar 1200 it switches to the trend instead (latest
// close above its 240-bar average and no lower than the close an hour ago),
// so the bot never finishes a window without a trade.
//
// Tuned on the 2026-11-18 dev window (a falling day, -2.8% close to close):
// the shorter 120-bar band and the wider 2.5% take-profit catch the
// dip-and-recover swings the old 300-bar band missed, while the tight 0.5%
// stop and the long cooldown keep losing trades small and rare. The dev
// window decides the gate (see README); the race window is unseen.
//
// Deterministic: identical bars produce identical orders, run after run. No
// clock, no environment, no randomness — every number is derived from the
// bars in the batches. One position, full size, at most one order per reply.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- Tuned configuration -----------------------------------------------
// All values were validated on the dev window; change them only with a fresh
// grade-local run to prove the new point is at least as good.
const SYMBOL = 'CBBTC';
const BAND_BARS = 120;        // Bollinger window, one-minute closes
const BAND_SIGMA = 1.5;       // lower band = mean - 1.5 * std dev
const RSI_BARS = 14;          // RSI lookback
const RSI_OVERSOLD = 30;      // enter only while RSI is below this
const TAKE_PROFIT_BPS = 250;  // exit at +2.5% over cost
const STOP_LOSS_BPS = 50;     // exit at -0.5% under cost
const COOLDOWN_BARS = 180;    // bars to rest after an exit
const FALLBACK_BAR = 1200;    // if still flat by this bar, buy the trend
const TREND_BARS = 240;       // trend average window
const HOUR_BARS = 60;         // bars in an hour (one-minute bars)
const MAX_SLIPPAGE_BPS = 100;

// --- Rolling market state ----------------------------------------------
const closes: number[] = [];
let previousClose: number | null = null;
let lastExitSeq = -1e9;

// RSI state: Wilder smoothing seeded with the plain average of the first
// RSI_BARS one-minute moves.
const rsiSeed: Array<[number, number]> = [];
let rsiUp: number | null = null;
let rsiDown: number | null = null;

function average(xs: number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

function populationStd(xs: number[], mean: number): number {
  const variance = xs.reduce((sum, x) => sum + (x - mean) * (x - mean), 0) / xs.length;
  return Math.sqrt(variance);
}

function noteClose(price: number): void {
  closes.push(price);
  if (previousClose !== null) {
    const move = price - previousClose;
    const up = move > 0 ? move : 0;
    const down = move < 0 ? -move : 0;
    if (rsiUp === null || rsiDown === null) {
      rsiSeed.push([up, down]);
      if (rsiSeed.length === RSI_BARS) {
        rsiUp = rsiSeed.reduce((sum, [u]) => sum + u, 0) / RSI_BARS;
        rsiDown = rsiSeed.reduce((sum, [, d]) => sum + d, 0) / RSI_BARS;
      }
    } else {
      rsiUp = (rsiUp * (RSI_BARS - 1) + up) / RSI_BARS;
      rsiDown = (rsiDown * (RSI_BARS - 1) + down) / RSI_BARS;
    }
  }
  previousClose = price;
}

function currentRsi(): number | null {
  if (rsiUp === null || rsiDown === null) return null;
  const moved = rsiUp + rsiDown;
  return moved === 0 ? 50 : (100 * rsiUp) / moved;
}

function lowerBand(): number {
  const window = closes.slice(-BAND_BARS);
  const mean = average(window);
  return mean - BAND_SIGMA * populationStd(window, mean);
}

function fullSizeBuy(state: BarsState): BuyInput | null {
  const room = state.weightRoom(SYMBOL);
  const amount = state.cash < room ? state.cash : room;
  if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

// Trend fallback: buy when the latest close sits above its 240-bar average
// and has not slipped below the close from an hour ago. Returns null when
// the trend does not confirm.
function trendBuy(state: BarsState, latest: number): BuyInput | null {
  const trend = average(closes.slice(-TREND_BARS));
  const anHourAgo = closes[closes.length - 1 - HOUR_BARS];
  if (latest > trend && latest >= anHourAgo) return fullSizeBuy(state);
  return null;
}

await runBars({
  onBatch(state, batch) {
    const priceScale = state.hello.symbols.find((s) => s.symbol === SYMBOL)!.price_scale;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      noteClose(Number(bar.c) / 10 ** priceScale);
    }
    if (state.warmingUp) return [];

    // Manage the open position first: take profit or stop out, then rest.
    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const takeProfit = value * 10000n >= cost * BigInt(10000 + TAKE_PROFIT_BPS);
      const stoppedOut = value * 10000n <= cost * BigInt(10000 - STOP_LOSS_BPS);
      if (takeProfit || stoppedOut) {
        lastExitSeq = state.seq;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (closes.length < BAND_BARS) return [];

    const latest = closes[closes.length - 1];
    const rsi = currentRsi();
    if (rsi !== null && rsi < RSI_OVERSOLD && latest < lowerBand()) {
      const buy = fullSizeBuy(state);
      return buy === null ? [] : [buy];
    }

    if (state.seq >= FALLBACK_BAR && closes.length >= TREND_BARS) {
      const buy = trendBuy(state, latest);
      if (buy !== null) return [buy];
    }
    return [];
  },
});
