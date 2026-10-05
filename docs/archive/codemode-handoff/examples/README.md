# Examples: only after the public contract is implemented

These are raw JavaScript bodies for native Pi codemode. They are not Node programs and are not compatible with Flow's existing text-only outer boundary. The `flow.*` store keys are local example conventions, not new Flow APIs.

`01_inspect_batch.js` demonstrates read-only, bounded batch inspection of 2–20 existing owned runs, preserving failed target outcomes and pagination.

`02_explicit_handoff.js` demonstrates collecting a canonical final result and passing it as explicit task evidence to another authorized worker. It uses existing `Agent` prompt/context/permission inputs. It is a dependent review, not an independent blind review. The caller must already be authorized to launch that worker. Stored inputs do not grant approval. No new context API, blackboard, or automatic history transfer is used.

The examples are syntax-checked and exercised with synthetic tool mocks by `node scripts/test_examples.mjs`. That is not a real Pi/Flow integration test. The implementation still needs the host tests in `04_TESTS_AND_ACCEPTANCE.md`.
