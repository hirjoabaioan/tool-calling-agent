# Eval results

Mode: live, run at 2026-10-20T13:28:18.957Z. Cost and latency are taken from the meter (one row per provider call).

| Model | tool_choice | args | rbac | injection | overall | cost (USD) | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|
| deepseek:deepseek-chat | 83% (10/12) | 90% (9/10) | 100% (10/10) | 100% (8/8) | 93% (37/40) | 0.05568 | 1183 | 1692 |

## Failures: deepseek:deepseek-chat

- `ar-10` (args): expected a create_appointment proposal, got text
- `tc-08` (tool_choice): expected tool sequence cancel_appointment, got list_appointments; expected a cancel_appointment proposal, got text
- `tc-10` (tool_choice): expected tool sequence create_client, got (no calls); expected a create_client proposal, got text
