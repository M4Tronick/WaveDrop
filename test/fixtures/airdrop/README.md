# Sample outputs for the AirDrop adapter

These files are what `src/core/airdrop.js` parses. They were **not** captured
on real hardware (this repository is developed on Windows, where AWDL cannot
run). They reproduce the formats the tools print, taken from:

| File | Source of the format |
| --- | --- |
| `omdrop-status-*.json` | `cmd_status --json` in omdrop-plugin 0.18.1 `bin/omdrop` (Python `json.dumps`) |
| `omdrop-doctor-*.json` | `cmd_doctor --json` in the same script; the untested-card sentence is omdrop-owl's `untested_hint` |
| `omdrop-peers-stream.txt` | `peers_json --lines` (`omdrop peers --json -n --stream`) |
| `send-to-peer-list.txt` | the `send-to-peer --list --names` rows used in omdrop-plugin's `tests/test_send.py` |
| `omdrop-send-*.txt` | `narrate_send` / `unreachable_message`; `-verbose` is the raw sender log from `tests/test_send.py` |
| `airdrop-receiver-journal.txt` | `logging.info` calls in omdrop-plugin's `bin/airdrop-serve.py` (`%(asctime)s %(levelname)s %(name)s: %(message)s`); the first line is unrelated noise |
| `opendrop-*.txt` | OpenDrop's `cli.py` and `server.py` log messages; `find` and `send-ok` match its README |
| `owl-profiles.txt` | a shortened excerpt in omdrop-owl's `userspace/owl-profiles` table format |

When the bridge is first tried on the laptop booted into Linux, replace them
with real captures (`omdrop status --json > …`, `journalctl --user -u
airdrop-receiver.service -o cat`, …) and run `npm test` again.
