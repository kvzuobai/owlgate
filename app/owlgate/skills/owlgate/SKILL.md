---
name: owlgate
description: "Trade TapeOut Rig vouchers on X Layer through OwlGate with an OKX Agentic Wallet (onchainos). Use when the user wants to see the TapeOut rig voucher market, buy a voucher, sell into an offer, list, make an offer or collection offer, or cancel orders on X Layer (chain 196)."
license: MIT
metadata:
  author: OwlGate
  version: "0.1.0"
  homepage: "https://owlgate.xyz"
---

# OwlGate: TapeOut Rig vouchers on X Layer

OwlGate (https://owlgate.xyz) runs the market for TapeOut Rig Bridge vouchers on X Layer (chain 196), settled on Seaport 1.6. OwlGate never signs and never holds funds: its API returns unsigned steps, and the user's Agentic Wallet signs them through `onchainos`.

A voucher (`0x9cfc959cd42b2e1d39a0d850c528210e818ae520`, ERC-721, upgradeable by TapeOut) stands for one rig locked in the TapeOut Rig Bridge on BNB Chain. The rig keeps mining BEM; rewards go to the voucher holder.

Facts, not advice. Prices and `paybackDays` are estimates that change every block. Never present them as a promise of returns.

## Before any trade

1. Get the wallet address: `onchainos wallet addresses` (use the EVM address; X Layer is chain `196`).
2. `GET https://api.owlgate.xyz/config.json`. If `bidsEnabled` is false or `pauseSigning` is true, stop and tell the user trading is paused.

## Read the market (GET, JSON, no key)

- Market: `https://api.owlgate.xyz/xl/market` — every voucher with rig power, `bemPerDay`, `unclaimedBem`, cheapest `ask` (OKB), `bestOffer` (WOKB), `paybackDays`, collection offers, OKB/BEM USD prices with sources, fee terms.
- Open orders: `https://api.owlgate.xyz/bids?chain=196`
- The user's orders: `https://api.owlgate.xyz/bids?offerer=<ADDRESS>`
- Fee-free slots left: `https://api.owlgate.xyz/free?wallet=<ADDRESS>` (always 0 since 2026-10-29)

Show prices in OKB with the USD value from the market response, and say where the price came from.

## Build the action (GET, returns steps, never signs)

| User wants | Endpoint |
|---|---|
| Buy a listing | `https://api.owlgate.xyz/xl/tx/buy?hash=<ORDER_HASH>&from=<ADDRESS>` |
| Sell a voucher into the best offer | `https://api.owlgate.xyz/xl/tx/sell?v=<VOUCHER_ID>&from=<ADDRESS>` (optional `&hash=`) |
| List / offer on one voucher | `https://api.owlgate.xyz/xl/order/build?kind=list\|offer&from=<ADDRESS>&v=<VOUCHER_ID>&price=<OKB>&days=1\|3\|7` |
| Collection offer (any voucher) | `https://api.owlgate.xyz/xl/order/build?kind=coll&from=<ADDRESS>&price=<OKB>&days=1\|3\|7` |
| Cancel | `https://api.owlgate.xyz/xl/tx/cancel?hash=<ORDER_HASH>&from=<ADDRESS>` or `&all=1` |

The answer is `{chainId: 196, from, steps: [...], summary}`. Show `summary` and each step's `label` to the user first. HTTP 409 means the fill would revert: do not send anything, report the `error` field. For `/xl/order/build`, if `ready` is false, show `blockers` and send nothing until a new build returns `ready: true`.

## Run the steps in order with onchainos

Follow the onchainos confirmation flow for every state-changing command: run once without `--force`; if it answers `"confirming": true`, show its `message`, ask the user, and only on a yes re-run with `--force`. Never add `--force` on the first run. Stop if any step fails.

**`{kind: "tx", to, data, value}`** — `value` is hex wei. Convert it to a decimal string (e.g. `0x6f05b59d3b20000` → `500000000000000000`; `0x0` → `0`), then:

```bash
onchainos wallet contract-call --chain 196 --from <ADDRESS> --to <to> --input-data <data> --amt <value_decimal>
```

Before each contract call, run `onchainos security tx-scan` on it as the onchainos wallet skill instructs, and halt on action `block`.

If a sell answer has an approval step, run the approval, then call the same sell endpoint again before sending the accept (the accept was simulated before the approval existed). A collection-offer accept must be sent within 1 hour of building it.

**`{kind: "sign", typedData}`** — EIP-712 (Seaport 1.6, chainId 196). Signing is free:

```bash
onchainos wallet sign-message --chain 196 --from <ADDRESS> --type eip712 --message '<typedData as compact JSON>'
```

**`{kind: "post", url, body}`** — set `body.signature` to the signature from the sign step, then `POST url` with `Content-Type: application/json`. A 2xx answer means the order is live; show it via `bids?offerer=<ADDRESS>`.

## Terms

- Listings are paid in native OKB. Offers use WOKB `0xe538905cf8410324e03a5a23c1c177a474d59b2b`, which stays in the bidder's wallet until a holder accepts.
- Fee 0.75%, paid by the seller out of the price, on every order (no free orders). Price range 0.01–500 OKB. Expiry 1, 3 or 7 days.
- Approvals are exact: one voucher at a time; WOKB only up to the sum of open offers.
- Read endpoints are cached 15–60 s and rate-limited per IP.

## Troubleshooting

- After a cancel (or any fill) is mined, `POST https://api.owlgate.xyz/bids/refresh` with `{"hash": "<ORDER_HASH>"}` so the order book shows the new status at once.
- Windows PowerShell 5.1 strips `"` from arguments to native programs: pass the EIP-712 JSON with every `"` escaped as `\"`, or the CLI answers `--message must be valid JSON`.
- `session expired` right after a successful login on Windows: the CLI keeps reading an empty OS keyring. Run onchainos with the environment variable `ONCHAINOS_FORCE_FILE_KEYRING=1`.

Full reference for agents: https://owlgate.xyz/llms.txt
