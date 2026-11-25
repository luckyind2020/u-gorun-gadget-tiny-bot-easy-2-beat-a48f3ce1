// Snapback Trend Rider — a tiny paper-trading bot for the make.fun
// bars-replay/v1 harness (hourly Solana bars, long-only, no leverage).
//
// Protocol: newline-delimited JSON on stdin, one reply per batch on stdout.
// The harness sends a hello, then one batch per bar (bars, fills, account),
// then done. Orders decided on a batch fill at the next bar's open.
//
// Strategy (own design, no borrowed code): a dip catcher with a clock.
//   Crypto mean-reverts on the hourly scale: sharp dips bounce. Per symbol:
//   - BUY when the close sits at least 2.5% below the slow EMA(18) and
//     ticks up from the previous bar (the dip is turning, not falling).
//   - SELL the whole position when it gains 5% from the fill price,
//     loses 2%, falls 5% under its peak since entry, the fast EMA(8)
//     drops below the slow EMA, or 24 bars pass without a take-profit.
//   - One position per symbol, sized at 20% of current equity (under the
//     25% max-weight cap), never pyramiding, never shorting.
//   - No randomness, no clock, no network: the same bars always give the
//     same orders, so the two grader runs agree byte for byte.

import * as readline from "node:readline";

type Bar = {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
};

type Position = { symbol: string; qty: string; cost_quote_units: string };

type Account = {
  cash_quote_units: string;
  positions: Position[];
  equity_quote_units: string;
};

type Batch = {
  type: "batch";
  seq: number;
  t: number;
  bars: Bar[];
  fills: unknown[];
  account: Account;
};

type Hello = {
  type: "hello";
  protocol: string;
  seed: string;
  symbols: { symbol: string; mint: string; price_scale: number; qty_scale: number }[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: { max_open_positions: number; max_orders_per_bar: number; max_weight_bps: number; shorts: boolean; leverage: boolean };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  latency_bars: number;
  warmup_bars?: number;
};

type Order =
  | { side: "buy"; client_id: string; symbol: string; notional_quote_units: string; max_slippage_bps: number }
  | { side: "sell"; client_id: string; symbol: string; qty: string; max_slippage_bps: number };

function emaOf(values: number[], period: number): number {
  const alpha = 2 / (period + 1);
  let out = values[0];
  for (let i = 1; i < values.length; i++) {
    out = alpha * values[i] + (1 - alpha) * out;
  }
  return out;
}

class TrendRider {
  private priceScale = new Map<string, number>();
  private closes = new Map<string, number[]>();
  private peaks = new Map<string, number>();
  private entryPx = new Map<string, number>();
  private holdBars = new Map<string, number>();
  private capitalUnits: number;
  private maxWeightBps: number;
  private maxOrders: number;
  private minNotional: number;
  private warmup: number;
  private counter = 0;

  constructor(hello: Hello) {
    for (const entry of hello.symbols) {
      this.priceScale.set(entry.symbol, entry.price_scale);
    }
    this.capitalUnits = Number(hello.capital.quote_units);
    this.maxWeightBps = hello.caps.max_weight_bps;
    this.maxOrders = hello.caps.max_orders_per_bar;
    this.minNotional = Number(hello.fees.min_notional_quote_units);
    this.warmup = hello.warmup_bars ?? 0;
  }

  private price(symbol: string, raw: string): number {
    return Number(raw) / 10 ** (this.priceScale.get(symbol) ?? 0);
  }

  decide(batch: Batch): Order[] {
    const orders: Order[] = [];
    const account = batch.account ?? { cash_quote_units: "0", positions: [], equity_quote_units: String(this.capitalUnits) };
    const cash = Number(account.cash_quote_units);
    const equity = Number(account.equity_quote_units || this.capitalUnits);
    const held = new Map<string, string>();
    for (const pos of account.positions ?? []) {
      held.set(pos.symbol, pos.qty);
    }
    // Record exact fill prices from the harness so take-profit and stop
    // levels are measured from what we really paid, not from a guess.
    for (const fill of (batch.fills ?? []) as { client_id: string; symbol: string; side: string; status: string; price: string }[]) {
      if (fill.status !== "filled") continue;
      if (fill.side === "buy" && fill.client_id.startsWith("b-")) {
        this.entryPx.set(fill.symbol, this.price(fill.symbol, fill.price));
        this.holdBars.set(fill.symbol, 0);
        this.peaks.set(fill.symbol, this.price(fill.symbol, fill.price));
      }
      if (fill.side === "sell" && fill.client_id.startsWith("s-")) {
        this.entryPx.delete(fill.symbol);
        this.holdBars.delete(fill.symbol);
        this.peaks.delete(fill.symbol);
      }
    }

    for (const bar of batch.bars ?? []) {
      const symbol = bar.symbol;
      const close = this.price(symbol, bar.c);
      let series = this.closes.get(symbol);
      if (!series) {
        series = [];
        this.closes.set(symbol, series);
      }
      series.push(close);
      if (series.length < 24) continue;
      if (series.length < Math.max(24, this.warmup)) continue;
      const fast = emaOf(series, 8);
      const slow = emaOf(series, 18);
      const prevClose = series[series.length - 2];
      const qty = held.get(symbol);
      if (qty === undefined) {
        // Dip turning up: at least 2.5% under the slow EMA, ticking higher.
        const dipped = close < slow * 0.975;
        const turning = close > prevClose;
        if (dipped && turning) {
          const target = Math.floor((equity * 20) / 100);
          const room = Math.floor((equity * this.maxWeightBps) / 10000);
          const notional = Math.min(target, room, Math.floor((cash * 95) / 100));
          if (notional >= this.minNotional * 2) {
            this.counter += 1;
            orders.push({
              side: "buy",
              client_id: `b-${symbol}-${String(this.counter).padStart(6, "0")}`,
              symbol,
              notional_quote_units: String(notional),
              max_slippage_bps: 50,
            });
          }
        }
      } else {
        let peak = this.peaks.get(symbol) ?? close;
        if (close > peak) peak = close;
        this.peaks.set(symbol, peak);
        const heldBars = (this.holdBars.get(symbol) ?? 0) + 1;
        this.holdBars.set(symbol, heldBars);
        const entry = this.entryPx.get(symbol) ?? close;
        const ret = close / entry - 1;
        const takeProfit = ret >= 0.05;
        const stoppedOut = ret <= -0.02 || close < peak * 0.95;
        const trendBroken = fast < slow;
        const timedOut = heldBars >= 24;
        if (takeProfit || stoppedOut || trendBroken || timedOut) {
          this.counter += 1;
          orders.push({
            side: "sell",
            client_id: `s-${symbol}-${String(this.counter).padStart(6, "0")}`,
            symbol,
            qty,
            max_slippage_bps: 50,
          });
          this.entryPx.delete(symbol);
          this.holdBars.delete(symbol);
          this.peaks.delete(symbol);
        }
      }
      if (orders.length >= this.maxOrders) break;
    }
    return orders;
  }
}

async function main(): Promise<void> {
  let bot: TrendRider | null = null;
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const message = JSON.parse(trimmed) as Hello | Batch | { type: string };
    if (message.type === "hello") {
      bot = new TrendRider(message as Hello);
    } else if (message.type === "batch") {
      const batch = message as Batch;
      const reply = {
        type: "reply",
        seq: batch.seq,
        orders: bot ? bot.decide(batch) : [],
      };
      process.stdout.write(JSON.stringify(reply) + "\n");
    } else if (message.type === "done") {
      break;
    }
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
