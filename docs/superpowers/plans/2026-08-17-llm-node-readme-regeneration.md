# LLM Node README Regeneration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 18 remaining LLM-family READMEs to the node README schema and add portable progressive disclosure for large LLM profile tables, while preserving all service metadata and generated README regions.

**Architecture:** Extend the existing deterministic Python validator with a structured parser for the `## Profiles` section, exercised through temporary node fixtures. Then update the schema contract and migrate the node READMEs in three reviewable batches. Large text-LLM nodes get one visible table plus one native `<details>` table; small text-LLM and image-model nodes keep one table.

**Tech Stack:** Python 3.10+, pytest, CommonMark Markdown with native HTML `<details>`, RocketRide node `services*.json`, Docusaurus docs build.

## Global Constraints

- Branch from `fix/docs`; ship one LLM-family pull request targeting `fix/docs`.
- Do not edit any `services*.json`, runtime source, default, or generator.
- Do not edit content inside `ROCKETRIDE:GENERATED:PARAMS` regions by hand.
- Keep `## Profiles` after `## As a tool` when present and before `## Configuration`.
- Keep the existing Profiles trigger: at least two entries other than `custom`.
- Only nodes with `"llm"` in merged `classType` and more than six declared profiles use progressive disclosure.
- A large table shows the declared default first, followed by selected profiles from the two newest recognizable release groups, with no more than six visible rows.
- `custom` and profiles marked `deprecated` stay collapsed; every declared profile appears exactly once.
- Use exactly `<summary><strong>View N more models</strong></summary>` and retain blank lines after `</summary>` and before `</details>`.
- The validator checks structure and metadata parity but never infers release recency.
- Preserve current prose where accurate; move non-schema `##` sections under `## Notes` instead of discarding useful material.

## File Structure

- `scripts/validate-node-readme.py`: parse and validate ordinary and progressive profile-table layouts.
- `tests/test_validate_node_readme.py`: fixture-driven regression coverage for the profile contract.
- `docs/development/nodes/readme-schema.md`: author-facing profile layout and validation rules.
- `nodes/src/nodes/llm_*/README.md`: hand-authored schema migrations; generated suffixes remain byte-identical.

---

### Task 1: Profile parser, validator rules, and schema contract

**Files:**
- Create: `tests/test_validate_node_readme.py`
- Modify: `scripts/validate-node-readme.py`
- Modify: `docs/development/nodes/readme-schema.md`

**Interfaces:**
- Consumes: merged service dictionaries returned by `load_services(node_dir)`.
- Produces: `declared_profiles(svc) -> dict`, `section_body(text, section) -> str`, `parse_profile_tables(section) -> list[dict]`, `resolve_profile_row(row, profiles) -> str | None`, and `profile_results(svc, hand) -> list[tuple[str, str, str]]`.
- `validate(node_dir)` appends `profile_results()` without changing the CLI result format.

- [ ] **Step 1: Add the fixture helper and first failing large-layout test**

Create a temporary protocol-bearing node with the existing core sections and literal profile metadata. Import the hyphenated validator script with `importlib.util` and assert on its public `validate()` result:

```python
import importlib.util
import json
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / 'scripts' / 'validate-node-readme.py'
SPEC = importlib.util.spec_from_file_location('validate_node_readme', SCRIPT)
VALIDATOR = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(VALIDATOR)


def write_node(tmp_path, *, class_type=('llm',), profiles, default, profile_section):
    node = tmp_path / 'fixture_node'
    node.mkdir()
    service = {
        'protocol': 'fixture',
        'classType': list(class_type),
        'capabilities': [],
        'lanes': {},
        'fields': {},
        'preconfig': {'default': default, 'profiles': profiles},
    }
    (node / 'services.json').write_text(json.dumps(service))
    (node / 'README.md').write_text(
        '# fixture_node\n\nA fixture node used to test documentation validation.\n\n'
        '## What it does\n\nRuns fixture prompts.\n\n'
        f'{profile_section}\n\n'
        '## Configuration\n\nChoose a profile.\n'
    )
    return node


def failures(node):
    _, results = VALIDATOR.validate(node)
    return [(check, detail) for status, check, detail in results if status == 'FAIL']
```

The first test creates seven declared profiles and an ordinary one-table section, then asserts a failure containing `Profiles details layout`. The current validator must fail this test because it accepts the missing expander.

- [ ] **Step 2: Run the first test and verify RED**

Run: `python3 -m pytest tests/test_validate_node_readme.py::test_large_llm_requires_details -v`

Expected: FAIL because no `Profiles details layout` failure is emitted.

- [ ] **Step 3: Implement structured table and details parsing**

Add these minimal structures to `scripts/validate-node-readme.py`:

```python
def declared_profiles(svc) -> dict:
    return ((svc.get('preconfig') or {}).get('profiles') or {})


def section_body(text: str, section: str) -> str:
    match = re.search(rf'^## {re.escape(section)}.*?$(.*?)(?=^## |\Z)', text, re.M | re.S)
    return match.group(1) if match else ''
```

Implement `parse_profile_tables(section: str) -> list[dict]` to identify
header/separator/row blocks, preserve raw cells for `(default)`, normalize
header aliases, and classify a table as collapsed only when its byte offset is
between the single `<details>` and `</details>` pair. Implement
`resolve_profile_row(row: dict, profiles: dict) -> str | None` using an exact
key, exact title, or exact backticked key from the Profile cell. Implement
`profile_results(svc: dict, hand: str) -> list[tuple[str, str, str]]` as the
single entry point used by `validate()`. A large layout requires exactly one
table before `<details>` and one inside it.

- [ ] **Step 4: Run the first test and verify GREEN**

Run: `python3 -m pytest tests/test_validate_node_readme.py::test_large_llm_requires_details -v`

Expected: PASS.

- [ ] **Step 5: Add failing parity, default, placement, and count tests**

Add literal tests named:

```python
LAYOUT_TESTS = (
    'test_large_llm_accepts_default_plus_five_and_collapses_remainder',
    'test_large_llm_rejects_more_than_six_visible_rows',
    'test_large_llm_requires_default_in_visible_table_and_intro',
    'test_large_llm_requires_custom_and_deprecated_rows_collapsed',
    'test_profiles_reject_missing_duplicate_and_unknown_rows',
    'test_large_llm_rejects_wrong_hidden_count',
    'test_large_llm_rejects_broken_details_blank_lines',
)
```

Use hand-derived fixtures with seven or eight profiles. Each invalid test asserts the relevant named failure; the valid test asserts `failures(node) == []`. Run the new tests before implementation and confirm each new behavior fails for the intended missing check.

- [ ] **Step 6: Implement exact parity and large-layout invariants**

In `profile_results()`:

```python
profiles = declared_profiles(svc)
default = (svc.get('preconfig') or {}).get('default')
large = 'llm' in (svc.get('classType') or []) and len(profiles) > 6
```

Resolve every row exactly once. Report missing, duplicate, and unknown rows separately. For large layouts, enforce one details block, at most six visible rows, the default first and marked `(default)`, the default key in the prose before the first table, all `custom`/deprecated rows collapsed, and the literal hidden-row count. Reject `<details>` for non-large sections. If a large node declares a custom or deprecated default, emit `Profiles default metadata is compatible with large layout` as a targeted failure.

- [ ] **Step 7: Run the layout/parity tests and verify GREEN**

Run: `python3 -m pytest tests/test_validate_node_readme.py -v`

Expected: all layout/parity tests PASS.

- [ ] **Step 8: Add failing model and token parity tests**

Add tests that mutate only one rendered value at a time, with these exact
names:

```python
VALUE_TESTS = (
    'test_profiles_reject_mismatched_model_identifier',
    'test_profiles_reject_mismatched_context_tokens',
    'test_profiles_reject_mismatched_output_tokens',
    'test_profiles_accept_header_aliases_and_thousands_separators',
    'test_non_llm_and_six_profile_sections_remain_single_table',
)
```

The fixtures use headers `Model ID`, `Context tokens`, and `Output tokens`, then the canonical shorter aliases. Fixed numeric expectations are literals; do not compute expected values with validator helpers.

- [ ] **Step 9: Implement semantic column validation and remove the old profile set check**

Map case-insensitive headers `Model`/`Model ID`, `Context`/`Context tokens`, and `Output`/`Output tokens` to `model`, `modelTotalTokens`, and `modelOutputTokens`. Normalize Markdown decoration and thousands separators only. Skip a field comparison when the metadata omits that field; do not treat user-facing custom placeholders as fixed values. Replace the old `real_profiles()`/`table_col()` parity block with `profile_results()`.

- [ ] **Step 10: Run tests, the existing Anthropic baseline, and lint**

Run:

```bash
python3 -m pytest tests/test_validate_node_readme.py -v
python3 scripts/validate-node-readme.py nodes/src/nodes/llm_anthropic
python3 -m ruff check scripts/validate-node-readme.py tests/test_validate_node_readme.py
```

Expected: pytest and ruff pass. Anthropic may now fail only the newly required progressive layout, proving the validator is ready for Task 2; no unrelated schema check may regress.

- [ ] **Step 11: Update the author-facing schema**

Replace the short `## Profiles` rule with the ordinary-versus-large behavior, the exact `<details>` template, default/newest selection policy, custom/deprecated placement, blank-line requirement, multi-service merged behavior, and the statement that recency remains review judgment. Expand `## Validation` with exact parity, default, hidden-count, details, and model/token checks.

- [ ] **Step 12: Commit Task 1**

```bash
git add scripts/validate-node-readme.py tests/test_validate_node_readme.py docs/development/nodes/readme-schema.md
git commit -m "feat(docs): validate progressive LLM profile tables"
```

---

### Task 2: Large LLM README migration, providers A–K

**Files:**
- Modify: `nodes/src/nodes/llm_anthropic/README.md`
- Modify: `nodes/src/nodes/llm_bedrock/README.md`
- Modify: `nodes/src/nodes/llm_deepseek/README.md`
- Modify: `nodes/src/nodes/llm_gemini/README.md`
- Modify: `nodes/src/nodes/llm_gmi_cloud/README.md`
- Modify: `nodes/src/nodes/llm_kimi/README.md`

**Interfaces:**
- Consumes: Task 1 validator and schema; profile values from each adjacent `services.json` without modifying it.
- Produces: six schema-valid READMEs with progressive profile tables.

- [ ] **Step 1: Record the RED validator baseline for this batch**

Run the validator with all six node directories. Expected: Anthropic fails the new details rule; the other five also retain their pre-migration schema failures.

- [ ] **Step 2: Migrate hand-written regions and preserve generated suffixes**

Keep accurate provider/configuration/authentication material, add the exact declared lanes, move unknown top-level sections under `## Notes`, and put all hand-written sections in schema order. Do not alter anything from `<!-- ROCKETRIDE:GENERATED:PARAMS START -->` onward.

Use friendly service titles in the first column, exact model IDs in the second, and comma-formatted integer context/output values. Visible profile keys, in order, are:

- `llm_anthropic` (6 visible, 16 hidden): `claude-sonnet-4-6`, `claude-fable-5`, `claude-sonnet-5`, `claude-opus-5`, `claude-opus-5-fast`, `claude-opus-4-8`.
- `llm_bedrock` (5 visible, 17 hidden): `meta_llama3_3-70b`, `amazon_nova-2-lite`, `anthropic_claude-sonnet-4-5`, `anthropic_claude-haiku-4-5`, `anthropic_claude-opus-4-5`.
- `llm_deepseek` (5 visible, 19 hidden): `cloud-reasoner`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v3-2`, `deepseek-v3-2-exp`.
- `llm_gemini` (4 visible, 22 hidden): `gemini-3_1-pro-preview`, `models-gemini-3-6-flash`, `models-gemini-3-5-flash`, `models-gemini-3-5-flash-lite`.
- `llm_gmi_cloud` (4 visible, 18 hidden): `deepseek-v3`, `gemini-3-pro`, `gemini-3-1-flash-lite`, `gpt-5-2`.
- `llm_kimi` (3 visible, 8 hidden): `kimi-k2-6`, `kimi-k3`, `kimi-k2-7-code`.

After the visible rows, preserve remaining profiles in service declaration order inside the details table. Custom and deprecated rows always remain hidden.

- [ ] **Step 3: Validate the batch and generated-region integrity**

Run the validator on the six directories. Then compare each generated suffix against commit `faf9599c` using `git show`; all six suffixes must be byte-identical.

- [ ] **Step 4: Commit Task 2**

```bash
git add nodes/src/nodes/llm_anthropic/README.md nodes/src/nodes/llm_bedrock/README.md nodes/src/nodes/llm_deepseek/README.md nodes/src/nodes/llm_gemini/README.md nodes/src/nodes/llm_gmi_cloud/README.md nodes/src/nodes/llm_kimi/README.md
git commit -m "docs(nodes): migrate large LLM profiles batch one"
```

---

### Task 3: Large LLM README migration, providers M–X

**Files:**
- Modify: `nodes/src/nodes/llm_minimax/README.md`
- Modify: `nodes/src/nodes/llm_mistral/README.md`
- Modify: `nodes/src/nodes/llm_ollama/README.md`
- Modify: `nodes/src/nodes/llm_openai/README.md`
- Modify: `nodes/src/nodes/llm_qwen/README.md`
- Modify: `nodes/src/nodes/llm_xai/README.md`

**Interfaces:**
- Consumes: Task 1 validator and schema; profile values from each adjacent `services.json` without modifying it.
- Produces: six schema-valid READMEs with progressive profile tables.

- [ ] **Step 1: Record the RED validator baseline for this batch**

Run the validator with all six node directories. Expected: each fails its existing schema and/or new progressive-layout requirements.

- [ ] **Step 2: Migrate hand-written regions and preserve generated suffixes**

Keep accurate configuration/authentication material, add `questions` →
`answers`, move unknown `##` headings beneath `## Notes`, order hand-written
sections exactly as the schema requires, render exact model/context/output
values from service metadata, and leave the generated suffix byte-identical.
Visible profile keys, in order, are:

- `llm_minimax` (5 visible, 10 hidden): `minimax-m2`, `minimax-m3`, `minimax-m2-7`, `minimax-m2-7-highspeed`, `minimax-m2-7-local`.
- `llm_mistral` (3 visible, 40 hidden): `mistral-large`, `mistral-medium-2604`, `mistral-small-2603`.
- `llm_ollama` (3 visible, 20 hidden): `llama3_3`, `llama4-latest`, `qwen3-latest`.
- `llm_openai` (5 visible, 44 hidden): `openai-5-2`, `gpt-5-6-sol`, `gpt-5-6-terra`, `gpt-5-6-luna`, `gpt-5-5`.
- `llm_qwen` (4 visible, 5 hidden): `qwen-flash`, `qwen-plus`, `qwen-plus-2025-07-28`, `qwen-plus-2025-07-28-thinking`.
- `llm_xai` (4 visible, 15 hidden): `grok-3`, `grok-4-5`, `grok-4-20`, `grok-4-20-multi-agent`.

The OpenAI list intentionally surfaces the three base 5.6 variants and 5.5, matching the approved recommendation; Pro variants remain in the complete collapsed table.

- [ ] **Step 3: Validate the batch and generated-region integrity**

Run the validator on the six directories. Compare every generated suffix against commit `faf9599c`; all must be byte-identical.

- [ ] **Step 4: Commit Task 3**

```bash
git add nodes/src/nodes/llm_minimax/README.md nodes/src/nodes/llm_mistral/README.md nodes/src/nodes/llm_ollama/README.md nodes/src/nodes/llm_openai/README.md nodes/src/nodes/llm_qwen/README.md nodes/src/nodes/llm_xai/README.md
git commit -m "docs(nodes): migrate large LLM profiles batch two"
```

---

### Task 4: Ordinary-table LLM-family READMEs and family integration

**Files:**
- Modify: `nodes/src/nodes/llm_baidu_qianfan/README.md`
- Modify: `nodes/src/nodes/llm_openai_api/README.md`
- Modify: `nodes/src/nodes/llm_perplexity/README.md`
- Modify: `nodes/src/nodes/llm_vision_gemini/README.md`
- Modify: `nodes/src/nodes/llm_vision_mistral/README.md`
- Modify: `nodes/src/nodes/llm_vision_ollama/README.md`
- Modify: `nodes/src/nodes/llm_vision_openai/README.md`

**Interfaces:**
- Consumes: Task 1 validator/schema and the two completed large-table batches.
- Produces: all 19 in-scope LLM-family READMEs passing the schema validator.

- [ ] **Step 1: Record the RED validator baseline for this batch**

Run the validator on the seven directories. Expected: all seven fail their current schema migration.

- [ ] **Step 2: Migrate all seven hand-written regions with one ordinary profile table each**

Use all declared profiles exactly once and do not add `<details>`. `llm_baidu_qianfan`, `llm_openai_api`, and `llm_perplexity` have no more than six merged profiles. The four `llm_vision_*` nodes have `classType: ["image"]`, so they retain an ordinary table even when their directory name begins with `llm` or their profile count exceeds six.

Add these exact lane rows:

- Text nodes: `questions` → `answers`.
- Vision nodes: `image` → `text` and `documents` → `documents`.

For `llm_openai_api`, keep one combined Profiles table for the merged directory and retain the useful Nebius-specific guidance under `## Configuration` or `## Notes`. Keep each generated suffix unchanged.

- [ ] **Step 3: Validate all 19 LLM-family nodes**

Run:

```bash
python3 scripts/validate-node-readme.py \
  nodes/src/nodes/llm_anthropic nodes/src/nodes/llm_baidu_qianfan \
  nodes/src/nodes/llm_bedrock nodes/src/nodes/llm_deepseek \
  nodes/src/nodes/llm_gemini nodes/src/nodes/llm_gmi_cloud \
  nodes/src/nodes/llm_kimi nodes/src/nodes/llm_minimax \
  nodes/src/nodes/llm_mistral nodes/src/nodes/llm_ollama \
  nodes/src/nodes/llm_openai nodes/src/nodes/llm_openai_api \
  nodes/src/nodes/llm_perplexity nodes/src/nodes/llm_qwen \
  nodes/src/nodes/llm_vision_gemini nodes/src/nodes/llm_vision_mistral \
  nodes/src/nodes/llm_vision_ollama nodes/src/nodes/llm_vision_openai \
  nodes/src/nodes/llm_xai
```

Expected: 19 PASS results, zero failures.

- [ ] **Step 4: Run validator tests, the informational repository sweep, and docs build**

Run:

```bash
python3 -m pytest tests/test_validate_node_readme.py -v
python3 scripts/validate-node-readme.py --all nodes/src/nodes
./builder docs:build
```

The focused tests and docs build must exit zero. The all-node sweep is informational while other node families remain unmigrated; confirm none of the 19 LLM-family nodes appears as a failure.

- [ ] **Step 5: Verify scope and generated-region integrity**

Confirm the branch diff contains only the design/spec/plan, schema, validator, validator tests, and the 19 allowlisted READMEs. Compare every README suffix from the generated start marker against `faf9599c`; all 19 must match byte-for-byte. Confirm `git diff -- '*.json'` and runtime-source diffs are empty.

- [ ] **Step 6: Commit Task 4**

```bash
git add nodes/src/nodes/llm_baidu_qianfan/README.md nodes/src/nodes/llm_openai_api/README.md nodes/src/nodes/llm_perplexity/README.md nodes/src/nodes/llm_vision_gemini/README.md nodes/src/nodes/llm_vision_mistral/README.md nodes/src/nodes/llm_vision_ollama/README.md nodes/src/nodes/llm_vision_openai/README.md
git commit -m "docs(nodes): finish LLM README migration"
```
