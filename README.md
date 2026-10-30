# OwlGate

The market layer for TapeOut on X Layer and BNB Chain. Live at **[owlgate.xyz](https://owlgate.xyz)** · X Layer market: [owlgate.xyz/xl](https://owlgate.xyz/xl)

Built for the OKX Xccelerate: TapeOut hackathon (X Layer, 2026-10-16 to 2026-12-07).

## What it does

**X Layer (chain 196)**
- **TapeOut Rig Bridge vouchers**: every voucher with the BNB rig behind it, its power, BEM/day and unclaimed BEM, plus a real order book.
- **TapeCode-Test1**: OKX floor, best offer and 7-day stats, and the same OwlGate order book.
- **Orders on Seaport 1.6**: offer on one NFT, offer on any NFT of a collection, list for OKB, sell into the best offer in one transaction, cancel one or all. OKB / WOKB. Fee 0.75% at match, inside the signed order.
- **Telegram**: snipe alerts for new voucher listings, a public "New on OwlGate" channel, tips to holders when a buyer bids.
- **AI agents**: `GET /xl/market` plus unsigned-transaction steps (list, buy, offer, accept, cancel) that the agent's own wallet signs; `llms.txt` and an agent skill.

**BNB Chain (chain 56)**: rigs from curated TapeOut CPUs ranked by BEM per BNB, one-transaction buy through a capped-fee router, floor sweep, offers, portfolio with live mining and claim.

## X Layer contracts used

| Contract | Address |
|---|---|
| TapeOut RigVoucher (UUPS proxy) | `0x9cfc959cd42b2e1d39a0d850c528210e818ae520` |
| TapeCode-Test1 (ERC-721) | `0x0e91460d6823c711643e650a9a4c0cc21de41614` |
| Seaport 1.6 | `0x0000000000000068f116a894984e2db1123eb395` |
| WOKB | `0xe538905cf8410324e03a5a23c1c177a474d59b2b` |
| TapeOut factory (X Layer) | `0x1f09daefa827f02cbb40967cc91b259763760761` |

BNB Chain: OwlGate router `0x8cf613755e9b39fa1c668a1d94aa72edf512814f`, sweep `0xa1fc1bba8c75baef5aaf7ee37a816938d810607d`.

## Layout

| Path | What |
|---|---|
| `app/owlgate/` | The site: one static `index.html` (no build step), docs, `llms.txt`, agent skill |
| `tools/tsd-api.js` | Indexer + HTTP API (market, listings, trades, `/xl`, `/xc`, referral) |
| `tools/tsd-bids.js` | Seaport order book: template checks, on-chain status, fills (BNB + X Layer) |
| `tools/og-agent.js` | Agent gate: `/xl/market` and unsigned tx steps |
| `tools/tsd-agg.js` | Pre-computed site tabs |
| `bot/tsd-bot.js` | Telegram bot: checks, alerts, channel posts |
| `contracts/` | Foundry: router, sweep, fork tests (incl. X Layer Seaport) |

## Run the tests

```bash
cd tools && npm install
node verify-xl-bids.js     # X Layer order templates vs live chain (read-only)
node verify-og-xl.js       # site encoders on an anvil fork of X Layer: list/buy, offer/accept, collection offer, TapeCode-Test1
node verify-agent.js       # agent gate end to end on an anvil fork
node test-watch.js         # bot (mocked network)
```

```bash
cd contracts && forge install foundry-rs/forge-std --no-git && forge test
```

Fork tests need [Foundry](https://getfoundry.sh) (`anvil` in PATH). No mainnet transactions; anvil test keys only.

## Notes
- Configuration comes from a local `.env` (not in the repo): RPCs, bot token, fee wallet, channel.
- The third-party listing feed module (`tools/tsd-ext.js`) is replaced by a stub; it is off in production.
