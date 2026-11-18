# tc-race-bot-2

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/yansen3w/tc-race-bot-2/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/yansen3w/tc-race-bot-2/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

Dip-hunter II: a slow mean-reversion bot trading Coinbase Wrapped BTC (cbBTC) against USDC on one-minute bars. It buys deep dips below the 120-bar Bollinger lower band (1.5 sigma) while the 14-bar RSI is under 30, and sells at +2.5% over its cost or −0.5% under it, then waits 180 bars before the next entry. Dev-window net PnL +$15.09 on $1,000 of paper money, 4 trades, max drawdown 1.60%.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=30afxf5j&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
