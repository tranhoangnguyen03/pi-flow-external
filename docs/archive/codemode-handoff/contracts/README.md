# Draft contract and fixtures

These are **proposed feature contracts**, not captured production responses and not a compiled Flow implementation. All example run IDs and output values are synthetic.

- `flow-result.schema.json`: Draft 2020-12 schema for the public version-1 envelope and tool-specific data.
- `fixtures.json`: accepted and rejected examples, with the expected host error flag where relevant.
- `../scripts/validate_contracts.py`: schema and semantic-fixture validator.

Run `python scripts/validate_contracts.py`. It requires Python 3 and `jsonschema` 4.x (install in a separate environment if absent). It makes no network calls, invokes no providers, and does not touch a repository.

The schema checks structure; the validator adds cross-field conditions such as final-value presence, run kind/ID consistency, inline-size cap, page continuation, and agreement between `ok` and the supplied host error flag. These tests demonstrate that the handoff's own examples are coherent. Production serializers must generate equivalent valid shapes and pass the real host/regression gates.

Machine clients must check `contractVersion` and `ok`, then tool/action-specific state. Errors before Flow's executor runs may be ordinary host errors without this envelope. `ok:true` for inspection/wait does not make the observed run successful.

The outer receipt validates operations. It does not validate the truth or business meaning of a child's answer. Use a separate task-specific child schema where needed, without merging it into run lifecycle fields.

The inline result default proposed here is 16 KiB of UTF-8 JSON; larger canonical values use existing inspection refs. Single-page inspection retains text chunks and explicit encoding; JSON must be parsed only after collecting all pages. The schema intentionally permits an incomplete page's text to be invalid standalone JSON.

`contracts` and `capabilities` help examples are synthetic shape examples. A completed implementation must return the actual registered schemas and adapter facts, not these miniature sample definitions.
