# Noa Court: session handoff (brainstorm 2026-11-01 → 2026-11-06)

> Tài liệu cho owner và các coding agent khác tiếp tục brainstorm. **Chưa build gì.** Owner sẽ nói "ok go" trước khi bắt đầu code. Tất cả nội dung dưới đây là quyết định của brainstorm, không phải lệnh implement.

## 0. Nguồn gốc session

| Thứ | Path |
|---|---|
| Transcript chính của session (Claude Code, JSONL) | `/root/.config/orca/claude-profiles/eb8c09d2-83f1-47c6-b19e-97e98aadc0bf/home/projects/-workspaces-devcontainer-projects-near-hackathon-2026/de043e30-8062-4d5f-bf79-8fb56b55b90d.jsonl` |
| Cùng file, qua đường dẫn `~/.claude` | `/root/.claude/projects/-workspaces-devcontainer-projects-near-hackathon-2026/de043e30-8062-4d5f-bf79-8fb56b55b90d.jsonl` |
| Transcript của 7 subagent research (sonnet) | `/root/.config/orca/claude-profiles/eb8c09d2-83f1-47c6-b19e-97e98aadc0bf/home/projects/-workspaces-devcontainer-projects-near-hackathon-2026/de043e30-8062-4d5f-bf79-8fb56b55b90d/subagents/agent-*.jsonl` |
| Nhật ký quyết định theo vòng (mới nhất ở trên) | `/workspaces/devcontainer-projects/near-hackathon-2026/SHORTLIST.md` (vòng 6, 7, 8) |
| Rules hackathon (bản live 2026-11-06 trùng với bản này) | `/workspaces/devcontainer-projects/near-hackathon-2026/research/HACKATHON-2026-11-04.md` |

Các file research do session này tạo (đọc trước khi bàn tiếp):

| File | Nội dung |
|---|---|
| `research/tee-evidence-agents.md` | Fetch evidence trong TEE: OutLayer, Phala dstack, NEAR AI Cloud, zkTLS. Mục "Off-chain execution (2026-11-01)" và "OutLayer primitives for Noa Court (2026-11-05)": TEE wallet, secrets, storage, VRF, connectors, pay-per-call, skills |
| `research/intents-deep-integration.md` | 1Click `customRecipientMsg`, ft_withdraw kèm msg, cash-out, verifier `intents.near`, agent vault, confidential intents |
| `research/noa-multi-asset-intents.md` | Phương án A/B/C/D cho bet bằng nhiều loại token trên Noa, kiểm tra trên mainnet, danh sách spike |
| `research/competition-nov1.md` | Prompt mẫu của từng track, repo đối thủ (PatchBond, Veridom…), bức tranh AI resolution |
| `research/pm-ai-integrations.md` | Các sàn prediction market tích hợp AI thế nào (Kalshi Harrison, Opinion Labs, Somnia…), các khoảng trống chưa ai làm, sự cố |

Research cũ hơn (trước session) vẫn đúng ngữ cảnh: `REPORT.md` (judges, luật, playbook README cho AI judge), `research/near-private-ai.md`, `research/near-usps.md`, `research/tracks-and-tech.md`.

## 1. Bối cảnh và ràng buộc

- **Hackathon:** NEAR HACKATHON, hạn nộp **2026-11-14T23:59Z**, judging 16–18/11. Code viết từ 2026-10-19 được tính (Q-001). Claude Code/Codex chấm sơ bộ (Q-017), nên README phải viết theo kiểu "do X → see Y".
- **Chọn hướng:** feature mới cho **Noa market** (noamarket.xyz, prediction market LMSR trên NEAR mainnet, contract `v3.noamarket.near`). P2P/Fulfil ban đầu bị bỏ; **cập nhật 2026-11-06: owner làm Fulfil thành project thứ 2, độc lập, ở `../mvp-fulfil/`** (rules Q-015: tối đa 2 project, README mỗi bên phải nêu tên project kia). Lý do: sustainability (Noa có user thật), khớp gu judge (AI dispute, verifiable inference, prediction market), và bằng chứng TEE cho P2P không giải được phía server.
- **Open-source:** chỉ phần feature mới, ở repo public riêng (`mvp-noacourt`). Code Noa giữ closed vì launch trước hackathon. README phải nói rõ điều này (Q-002/Q-004). Không copy code Noa (LMSR math…) vào repo public.
- **Mainnet:** toàn bộ chạy trên mainnet vì build cho Noa. Mỗi thao tác ghi mainnet (tx, deploy, ops) phải **dry-run rồi chờ owner đồng ý cho từng lần** (rule trong `noamarket-monorepo/CLAUDE.md`).
- **Owner Noa** hiện là contract owner do 1 người (owner) quản lý; sau này chuyển sang DAO thật. Không cần thiết kế quanh DAO.
- **Ưu tiên:** tích hợp sâu stack NEAR (OutLayer TEE, NEAR AI Cloud inference có attestation, NEAR Intents) để thắng. Owner muốn tập trung vào **OutLayer** (partner hackathon).
- **Rules có mục mới "4. Request changes"** (endpoint `/api/corrections`) để sửa bài đã nộp. Đọc lại bản live trước khi nộp.

## 2. Sản phẩm: Noa Court

**Một câu:** resolver AI cho Noa. Creator mô tả market bằng prompt → agent biên dịch thành ResolutionSpec có cấu trúc → preflight chạy thử nguồn thật → tới hạn, WASM trên OutLayer TEE fetch dữ liệu và quyết định (deterministic, hoặc panel juror NEAR AI TEE cho câu hỏi dạng text) → Court contract gọi `resolve_market`. Mỗi market có resolution receipt kèm attestation.

**Account resolver:** `ai-resolver.noamarket.near` (subaccount; chỉ `noamarket.near` tạo được nên không bị chiếm tên).
> ⚠ Resolver của một market Noa **không đổi được** sau khi tạo (contract không có `set_resolver`). Phải **tạo account trước**, rồi mới gán vào market. Giai đoạn chờ: account giữ full-access key của owner (trust giống `solver1` hiện tại). Sau đó deploy Court contract lên account này và khóa (xóa key). Thời điểm khóa: để sau.

**Định vị so với đối thủ:**
- PatchBond: bond + judge NEAR AI TEE + re-judge, nhưng "server chooses what the model sees".
- Opinion Labs: AI oracle, không TEE.
- Kalshi Harrison: closed, không dry-run nguồn.
- Somnia: không có appeal.

Chưa ai có đủ: **evidence fetch trong TEE + spec khóa hash + preflight chạy thử nguồn + resolution receipt có attestation**. Không pitch "dự đoán tranh chấp": arXiv 2604.15674 cho thấy LLM không đoán được market nào sẽ bị tranh chấp. Pitch "khóa spec + chạy thử nguồn".

## 3. Flow đã chốt

```
[Tạo market]
creator ⇄ agent của user (theo skill, hoặc LLM của ChatGPT/Claude/Grok qua MCP): hỏi lại cho rõ
  → ResolutionSpec JSON (chỉ dùng tool trong catalog)
  → Preflight 3 tầng:
      1. lint (code, tức thì, miễn phí)
      2. giả lập: chạy ĐÚNG file WASM đã pin hash bằng wasmtime (local hoặc MCP server chạy hộ), fetch thật, miễn phí
      3. chính thức (tùy chọn, khuyến khích): Court.request_preflight(spec) + deposit → OutLayer on-chain
         (lint + dry-run + NEAR AI review ngữ nghĩa) → yield/resume → attestation
         Skip tầng 3 → Court vẫn nhận nhưng gắn cờ `preflight: none`, hiện trong rules/receipt/UI
  → rules hiển thị SINH TỪ SPEC bằng template (creator không sửa tay phần ràng buộc, chỉ sửa description)
  → wallet link: Noa.create_market(resolver = ai-resolver.noamarket.near) → Court.register_market(id, spec)
     (chỉ creator của market gọi được register; spec lưu on-chain ~1–2 KB)

[Tới hạn]
keeper (worker indexer Noa) ─ ping ─▶ Court.trigger(id)      permissionless, keeper không có quyền quyết định
Court ─ request_execution(WASM pin hash) ─▶ OutLayer TEE: fetch → check → extract → decide (text_judge: 3 juror)
      ◀─ yield/resume: resolved(outcome) | retry_after(t) | unresolvable
Court ─▶ Noa.resolve_market(id, outcome) + 1 yocto   → dispute window (1 ngày cho market dạng ngày)
keeper ─▶ Noa.finalize_resolution(id)  (ai gọi cũng được)
Sai → owner Noa emergency_resolve (backstop). Khi đó phí solver trả cho owner, Court mất phí.
Market có resolver = Court nhưng chưa đăng ký spec / unresolvable tới hạn → Court void_market.
```

**Market unsupported** (không biểu diễn được bằng catalog): vẫn tạo được, nhưng creator **tự chọn resolver khác** (ví riêng hoặc `solver1.noamarket.near`). Skill ghi rõ lý do; nếu creator tự resolve thì phải cảnh báo "market do chính creator resolve", frontend của Noa market  handle việc hiển thị này sẵn. 

## 4. ResolutionSpec

```jsonc
{
  "version": 1,
  "outcomes": ["Yes", "No"],
  "observation": { "at": "2026-11-30T00:00:00Z", "mode": "historical | first_fetch_after", "max_delay": "6h" },
  "sources": [ { "id": "...", "tool": "...", "params": {}, "expect": {}, "extract": {}, "label": "verified | self_declared" } ],
  "aggregate": { "method": "primary_then_fallback | median | all_agree", "tolerance": "0.5%" },
  "decide": { "kind": "threshold | buckets | equals | bool | text_judge", "...": "..." },
  "outcome_map": { "...": "..." },              // phải phủ mọi giá trị, kể cả thiếu/null
  "on_unavailable": "void | <outcome>",
  "rules_text_hash": "sha256:..."
}
```

- `decide` là **code deterministic** cho mọi kind trừ `text_judge`. Tính bằng decimal, không dùng float. Biên của threshold/bucket phải ghi rõ (`>=` hay `>`).
- Lint tĩnh (code):
  - thời điểm quan sát phải sau lúc đóng trade;
  - bucket phủ kín, không chồng nhau;
  - tool snapshot phải có `max_delay`;
  - market giá cần ≥2 nguồn;
  - deadline ≥ quan sát + delay + thời gian retry.

## 5. Tool catalog

Cùng một catalog dùng cho 3 chỗ: schema để agent soạn spec, adapter trong WASM, preflight. Thêm tool = 1 PR gồm adapter + test.

| Tool | Trạng thái | Ghi chú |
|---|---|---|
| `binance_kline` | v1 | historical. ⚠ Có 1 node OutLayer ở Dallas, Binance có thể trả 451 → dùng `data-api.binance.vision` + fallback, có mã lỗi `geo_blocked` riêng |
| `coingecko_price` | v1 | historical |
| `near_view` | v1 | view call theo block height, đối chiếu 2 RPC |
| `github_repo` | v1 | snapshot (chỉ có số hiện tại); GitHub token niêm phong (giới hạn không token là 60 request/giờ/IP, mà IP OutLayer dùng chung) |
| `http_json` | v1, **lõi** | xem §6 |
| `web_text` | v1 | trang HTML tĩnh; Firecrawl là fallback (key niêm phong). TEE chỉ chứng minh response của Firecrawl, không chứng minh trực tiếp trang gốc |
| `rss_feed` | v1 | RSS 2.0 / Atom / JSON Feed qua crate `feed-rs` (spike: có build được cho `wasm32-wasip2` không); feed chỉ có tóm tắt thì fetch link bài gốc |
| `web_search` | **bỏ (tạm thời)** | đã bàn: dùng NEAR AI `web_context_search`, query khóa trong spec, kết quả chỉ để tìm URL, search lại +6h/+24h trước khi kết luận theo mặc định |
| `x` (Twitter) | **không làm** | dùng `http_json` + key niêm phong |
| `near_token` | **để đợt brainstorm tool sau** | price (Intear/Rhea median), supply on-chain, market_cap = price × supply (khai rõ total hay circulating, ví burn), holders (NearBlocks, ngưỡng bụi), liquidity (Rhea), launch_status (meme.cooking). Endpoint chưa verify |

**Nhãn nguồn:** cho phép mọi domain, có 2 nhãn:
- "đã xác minh": domain trong danh sách duyệt sẵn;
- "tự khai, có thể do creator kiểm soát": mọi domain khác.

Nhãn hiện trong rules, UI và receipt.

## 6. Hợp đồng `http_json` (đã duyệt)

```jsonc
{
  "tool": "http_json",
  "request": { "method": "GET|POST", "url": "https://…?date={T:YYYY-MM-DD}", "headers": {},
               "auth": { "secret": "NAME", "header": "x-api-key" } },   // chỉ ghi tên sealed secret
  "expect": { "status": 200, "assert": ["$.symbol == 'NEARUSDT'"], "as_of": "$.updated_at" },
  "identity": "asserted | url_only",
  "extract": { "path": "$.data.total", "agg": null, "type": "int|decimal|bool|string|timestamp", "decimals": 0 },
  "sanity": { "min": 0, "max_change_vs_preflight": "10x" }
}
```

- **Lúc resolve không có AI:** status → JSON → `assert` → `as_of` → extract (đúng 1 giá trị, đúng kiểu) → sanity → decide. Fail bước nào thì `retry_after`; hết hạn thì `on_unavailable`. Không bao giờ đoán.
- **JSONPath RFC 9535**, có filter `[?…]`; **cấm index theo vị trí** (`[0]`) trừ khi tài liệu API nói rõ thứ tự. ✔ owner duyệt.
- **Assert danh tính bắt buộc** (✔ owner duyệt): ít nhất 1 assert, ưu tiên ID bất biến (ID repo, địa chỉ contract token, địa chỉ pair). Response không có trường nào để nhận diện (vd. `nearhackathon.com/api/projects` → `{"total":175,...}`) thì dùng assert theo cấu trúc, hoặc khai `identity: "url_only"`; rules ghi "danh tính chỉ dựa vào URL". Assert fail → retry → void, **không bao giờ resolve sai**.
  - Các trường hợp assert chặn được: repo bị xóa rồi tạo lại trùng tên; token giả trùng ticker; API lặng lẽ trả object mặc định hoặc 0; sai đơn vị tiền.
  - Trải nghiệm creator: agent tự đề xuất assert từ response mẫu, creator chỉ bấm ok (xem ví dụ trong transcript).
- **Phân trang: v1 bỏ** (✔ owner duyệt). v1 cũng không hỗ trợ OAuth, request ký động, CSV/XML/HTML (RSS và HTML có tool riêng).
- **Quy tắc trong skill:**
  1. Tìm nguồn chính chủ trước.
  2. Gọi thật endpoint và cho creator xem response mẫu kèm giải nghĩa trường đã chọn.
  3. Chọn path theo key.
  4. Có assert danh tính.
  5. Khai độ mới dữ liệu (`as_of`, biến `{T}`, hoặc "lần fetch đầu tiên sau T").
  6. Khai type và decimals.
  7. `decide` có biên rõ, `outcome_map` phủ cả trường hợp thiếu/null.
  8. Có fallback (bắt buộc với market giá).
  9. Chạy giả lập, hiện "nếu resolve bây giờ thì ra X".
- **NEAR AI review lúc preflight chính thức:** kiểm path đã chọn có đo đúng điều câu hỏi muốn hỏi không (vd. chọn nhầm `market_cap_rank` thay cho `market_cap`, giá theo BTC thay vì USD).
- Owner ghi chú: preflight/giả lập vốn đã cho creator thấy output và outcome. Các quy tắc trên là để chặn những thay đổi xảy ra **sau** preflight (thứ tự mảng đổi, dữ liệu phình ra).

## 7. `text_judge` (USP, bắt buộc có)

| Điểm | Thiết kế |
|---|---|
| Nguồn evidence | Chỉ URL đã khai trong spec: trang tĩnh (Firecrawl fallback), RSS feed, API JSON có trường text. Không search lúc resolve (`web_search` đang bỏ) |
| Câu hỏi | Yes/No (có thể multi-choice), kèm danh sách tiêu chí: tính YES khi nào, KHÔNG tính khi nào |
| Mặc định khi không có evidence | Bắt buộc khai, thường là "tới T không có bằng chứng hợp lệ → NO" |
| Khung thời gian | Item/bài phải có ngày nằm trong [mở market, T]. Trang không có ngày thì lấy nội dung ở lần fetch đầu tiên sau T. `pubDate` do bên đăng tự ghi nên có thể ghi lùi ngày; rules phải ghi rõ |
| Juror | 3 model NEAR AI Cloud TEE (GLM/Qwen/…) chạy độc lập, output `{answer: yes/no/unclear, quotes[], item_ref, confidence}` |
| Check bằng code | Quote phải **trùng nguyên văn** với bytes evidence. `item_ref` phải nằm trong khung thời gian. Sai thì vote bị loại |
| Quyết định | Cả 3 đồng ý và đủ tự tin → resolve. Không thì retry/fetch lại tối đa N lần → flag owner (`emergency_resolve`) hoặc void theo spec. Thiết kế panel theo arXiv 2605.30802: juror độc lập, vote theo confidence, không cho debate |
| Chống inject | Evidence bọc thành dữ liệu, không bao giờ vào system prompt; bỏ script/HTML; giới hạn độ dài; heuristic gắn cờ inject |
| Chất lượng | Bộ eval 20–30 market thật đã resolve → `EVALS.md` |

## 8. Phân phối: skill + CLI + MCP

| Kênh | Quyết định |
|---|---|
| **Skill + CLI** (`noa-court draft/simulate/preflight/create/receipt`) | Kênh chính. Không cần server, user đọc được mọi thứ sẽ chạy, judge (Claude Code/Codex) cài là chạy được |
| **Remote MCP server của Noa** | **Ưu tiên** cho ChatGPT / Claude.ai / Grok. Server **không cầm key hay secret nào của user**: chỉ có tool đọc + soạn + giả lập; mọi thao tác ghi trả về **wallet link**. LLM của nền tảng tự hỏi lại creator, Noa không tốn credit AI. Grok trên web hỗ trợ remote MCP: **chưa verify** |
| Web UI | Để sau. Hướng xử lý credit AI chưa chốt (có thể Noa trả) |

- Agent của user hỏi lại creator. Bản review có thẩm quyền là NEAR AI trong preflight chính thức.
- **Không bao giờ để agent cầm key:** `create_market` cần deposit, mà function-call key không gửi kèm deposit được → dùng wallet link.
- Client nào cũng không được tin. Cổng thật nằm on-chain: cờ preflight trong Court.

## 9. Bet và tạo market bằng nhiều loại token (Intents)

- **USP của Noa: "any token qua NEAR Intents"**, kể cả chain không có smart contract (BTC, ZEC, PRL). Owner sẽ whitelist.
- Token NEP-141 có sẵn trên 1Click (kiểm 2026-11-06, 215 token):
  - `btc.omft.near` / `nbtc.bridge.near`, `zec.omft.near`, `prl.omft.near`, `ltc/doge/tron/sol/eth.omft.near`, `wrap.near`;
  - USDC native `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`.
- **Chỉ hỗ trợ NEP-141.** BNB và token do HOT omni phát hành là NEP-245 (36/215) → bỏ, chỉ nhắc trong pitch.
- **Phương án A (không sửa contract Noa):** 1Click/PoA gửi token về account NEAR của user → 1 batch `ft_transfer_call` + `buy_shares`. Cash-out: batch `sell/claim` + `withdraw_tokens` + `ft_transfer` tới địa chỉ deposit 1Click. Bỏ phương án C/D. Phương án B (Noa đọc `msg` trong `ft_on_transfer`) là code private, để sau.
- Ops (việc của owner):
  - `v3.noamarket.near` cần `storage_deposit` trên từng contract token;
  - tham số liquidity LMSR đặt theo từng token (BTC 8 decimals);
  - token `omft` có bắt user đăng ký storage không: chưa check (spike).
- Owner sẽ thêm USDC (không bắt buộc cho Court; ý ban đầu là để market tính bằng đô la cho UX).
- Phí solver mà Court nhận là token của market → treasury Court giữ nhiều loại token.

## 10. Phí và sustainability

- **Creator trả deposit cho preflight chính thức** (ước tính, spike sẽ đo): ~0.05 NEAR (deterministic) / ~0.1 NEAR (text_judge), phần thừa hoàn lại. Gồm:
  - OutLayer ~0.002 NEAR;
  - gas cho request + callback;
  - call NEAR AI review (Court trả bằng key niêm phong, deposit bù lại);
  - storage spec ~0.01–0.02 NEAR;
  - **phí resolve trả trước** (OutLayer + gas + quỹ retry + juror nếu là text_judge).
- **Doanh thu:** Court là resolver nên tự nhận `solver_fee_share_bps` từ phí trade lúc finalize. Bị owner override thì phí trả cho owner, tức Court có skin in the game. Market NPOINT = phí NPOINT (token chơi, không có giá trị).
- **Court cho sàn khác:** interface chung `request_resolution(spec, callback)` + view `get_verdict(id)`; phí trả bằng token qua Intents. Hackathon chỉ làm adapter Noa + view chung. OutLayer cho publish WASM thu phí theo lượt gọi, nhưng không nêu cách chia doanh thu → chỉ nhắc trong README.
- Quỹ phí rút về account DAO cố định set lúc `init`.

## 11. Sự thật về OutLayer (đã verify từ docs/source, chưa chạy thật)

- Off-chain: `POST https://api.outlayer.ai/call/{owner}/{project}` kèm `X-Payment-Key` (USDC trả trước, tối thiểu $1). ~$0.002 mỗi lần chạy, có TDX attestation, không có `block_height`. On-chain: yield/resume, ~0.002 NEAR + gas. Cùng WASM chạy cả 2 kiểu: truyền `mode` trong input và đối chiếu `OUTLAYER_EXECUTION_TYPE`.
- Giới hạn: wasip2, có HTTPS outbound (TLS kết thúc trong TDX), mỗi request 30s, mỗi lần chạy 180s, không có browser, HTTP/1.1, output ~10 MiB.
- Sealed secrets gắn với project hoặc hash WASM.
- **TEE wallet** không giới hạn được theo method → **không dùng làm resolver**. Resolver là Court contract đã khóa.
- VRF verify được bằng `env::ed25519_verify` (~1 TGas).
- Connectors chỉ có GitHub/Gmail/Mercury/Hyperliquid/Polymarket và đều chạy với quyền owner → không dùng.
- Skills cho coding agent: `https://skills.outlayer.ai/outlayer/SKILL.md` (`building-outlayer-apps`, `outlayer-cli`).
- Chưa verify: gọi NEAR AI Cloud (`cloud-api.near.ai`) từ trong job; testnet executor ổn định không (testnet chỉ có 1 executor, tỷ lệ thành công 85.5%).

## 12. Sự thật về contract Noa (đọc code, read-only)

| Sự thật | Vị trí |
|---|---|
| `create_market(..., resolver: AccountId, ...)`; resolver là account bất kỳ, **không đổi được** | `noamarket-monorepo/contracts/src/lib.rs:1019` |
| `resolve_market`: chỉ resolver gọi được, 1 yocto, sau `expiration_time`, trước `resolution_deadline`, **propose 1 lần** → dispute window | `lib.rs:1671` |
| `finalize_resolution`: ai gọi cũng được, sau dispute window; phí solver trả cho resolver | `lib.rs:1715` |
| `void_market`: owner hoặc resolver, sau deadline, không được có proposal đang chờ | `lib.rs:1747` |
| `emergency_resolve` / `emergency_void`: owner, chạy được kể cả khi chưa có proposal; phí trả owner | `lib.rs:1779`, `:1802` |
| `ft_on_transfer` **bỏ qua `msg`**, ghi có cho `sender_id`, sender phải đã đăng ký storage | `lib.rs:879` |
| `buy_shares` tiêu balance nội bộ của **người gọi**; vị thế đầu tiên cần đính 0.01 NEAR | `lib.rs:1370`, `:1459` |
| Dispute window do owner set (mặc định 60 phút cho market phút / 24h cho market ngày), snapshot theo market | `lib.rs:654`… |
| Whitelist mainnet hiện có: NPOINT, wNEAR, BLACKDRAGON, SHITZU, MPOO, INTEAR | view `get_whitelisted_tokens` |
| Spec market của ops (`title/description/rules/closeAt/resolutionWindowDays/...`) | `noamarket-monorepo/ops/markets/*.json` |

## 13. Các ý đã cân nhắc rồi để sau hoặc bỏ

- Để sau:
  - VRF chọn juror (ít giá trị vì phần lớn market là deterministic);
  - appeal có bond (thay bằng: dispute window 1 ngày + owner override);
  - commit–reveal vote;
  - publish pay-per-call;
  - web UI;
  - tool `near_token`;
  - `web_search`;
  - phương án B nâng cấp `ft_on_transfer`.
- Bỏ:
  - Phala CVM (OutLayer đủ dùng; ghi trong README là "tier 2 cho trang JS/screenshot");
  - TEE wallet làm resolver;
  - tool `x`;
  - NEP-245;
  - các ý trong bài OutLayer không khớp với Court (thesis, NFT giữ API key, EVM state proof, EAS, Gmail).
- Market về số bài nộp hackathon (`GET https://nearhackathon.com/api/projects` → `$.total`, 175 lúc 2026-11-06): ví dụ owner tự lo, **không nằm trong scope**. Nếu làm thì đừng mở market về "ai thắng" (owner đang dự thi).

## 14. Spike cần chạy khi "ok go" (thứ tự ưu tiên)

1. Job OutLayer (wasip2): GET Binance/CoinGecko/GitHub + POST tới NEAR AI Cloud; chạy `outlayer-verify`; xem IP egress.
2. Đường yield/resume: contract testnet → OutLayer → callback; đo gas.
3. `feed-rs` build được cho `wasm32-wasip2` không.
4. Contract verify chữ ký NEAR AI (`ecrecover`) on-chain hay chỉ neo hash: đo gas.
5. Token `omft` có bắt đăng ký storage không; batch `ft_transfer_call` + `buy_shares` trên 1 market SHITZU (mainnet, số tiền nhỏ, **cần owner đồng ý**).
6. Swap thật qua 1Click giao tới account NEAR (BTC/ZEC → `*.omft.near`) (mainnet, **cần owner đồng ý**).

**Owner cần chuẩn bị:**
- tạo `ai-resolver.noamarket.near`;
- account OutLayer + payment key (~$5);
- credit NEAR AI Cloud;
- ~1–2 NEAR cho spike;
- key niêm phong: GitHub token, Firecrawl (tùy chọn).

## 15. Câu hỏi còn mở

- Các bước và kết quả cần đạt (owner sẽ brainstorm). Owner **không muốn lịch theo ngày**; muốn goal rõ, kiểm chứng được, để giao cho subagent.
- Đợt brainstorm về tool (`near_token`, có thể thêm tool khác).
- Web UI và ai trả credit AI cho người không dùng agent.
- Thời điểm khóa Court contract.
- Danh sách domain "đã xác minh" ban đầu.
- Ngưỡng tự tin của juror và số lần retry N.

## 16. Hướng dẫn cho agent đọc file này

- Đọc §1 và §12 trước khi đề xuất bất cứ thứ gì đụng tới Noa.
- Không ghi gì lên mainnet hay vào repo Noa khi chưa có owner đồng ý cho từng thao tác cụ thể.
- Không bao giờ in hay commit secret (`.env`, `~/.near-credentials`, key Firecrawl/NEAR AI/OutLayer).
- Khi gọi HTTP trực tiếp (1Click, OutLayer…), dùng User-Agent bình thường: Cloudflare của 1Click chặn UA mặc định của Python (lỗi 1010).
- Ghi quyết định mới thành một vòng mới ở đầu `SHORTLIST.md` và cập nhật file này.
