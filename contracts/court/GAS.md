# Gas measurements

Measured with `NEAR_SANDBOX_BIN_PATH=/tmp/claude-0/w1/sandbox-bin/near-sandbox-wrapper cargo test --test sandbox -- --ignored --nocapture --test-threads=1` using `near-workspaces` 0.22.1 and the local mock Noa and OutLayer contracts. Figures below are `total_gas_burnt`, including the callback chain. They are mock measurements; real OutLayer execution may burn substantially more gas up to its configured allocation.

| Method and path | Measured total gas burnt | Recommended attached gas |
| --- | ---: | ---: |
| `register_spec` (first registration / repeat registration) | 2–3 TGas | 100 TGas |
| `link_market` (Noa view and Court callback) | 6 TGas | 100 TGas; contract minimum 60 TGas |
| `void_unlinked` (Noa view, void and callbacks) | 9 TGas | 80 TGas; contract minimum 80 TGas |
| `trigger` → resolved → Noa forward and callbacks | 11 TGas | 220 TGas with default OutLayer gas 100 TGas |
| `trigger` → retry or unresolvable | 7 TGas | 220 TGas with default settings |
| `trigger` → OutLayer promise failure → retry scheduled | 6 TGas | 220 TGas with default settings |
| `trigger` → invalid spec hash | 7 TGas | 220 TGas with default settings |
| `submit_keeper_verdict` (generic request) | 2 TGas | 100 TGas; allow more when forwarding to Noa |
| `submit_keeper_verdict` (Noa-linked market → forward and callback) | 6 TGas | 100 TGas |

The default `trigger` gas guard requires at least 165 TGas (`100` OutLayer + `50` verdict callback + `15` scheduling overhead). At high configured OutLayer gas the verdict callback shrinks to keep a feasible 300 TGas transaction; configure 20–250 TGas only after measuring actual work. `void` and `retry_forward` schedule a 15 TGas Noa call and 10 TGas Court callback; attach 80 TGas. `void_unlinked` adds a 10 TGas Noa view and 35 TGas validation callback before those void receipts. All measurements are rounded down to whole TGas by the `as_tgas` display method.
