- [x] planned
- [x] in progress
- [ ] completed

In progress: the run-time tool, the gateway, the saved tools, the wizard's test
gate and the profile section are built and verified on real workerd and with
Sol and Terra over OpenRouter. The prompt evaluations ran
(`scripts/code-mode-evals.mjs`: three rounds, a final twenty-scenario wizard
suite, and twelve scenarios shaped after production Sidekicks whose runs were
routed to the scheduled-run model, Gemini Flash) and shaped the prompts;
acceptance items 8 and 12 are met on that model. Outstanding before
completion: acceptance item 3 (kill-mid-program replay test), item 6
(byte-for-byte shape snapshots), and the profile's disabled and unavailable
tool states. The decision log in [`prd.md`](prd.md#decision-log) records every
divergence from the design.
