# LLM profile table progressive disclosure

## Goal

Make large LLM profile lists useful at a glance without hiding the full set of
supported models. An LLM node README should lead with its default and newest
models, while older, custom, and deprecated profiles remain available in a
portable expandable section.

This is a documentation-contract change. It does not change model metadata,
runtime defaults, profile ordering in `services*.json`, or how profiles are
generated.

## Constraints

- Keep `## Profiles` in its current schema slot: after `## As a tool` and
  before `## Configuration`.
- Use Markdown and native HTML that render in Docusaurus, GitHub, Cursor, and
  VS Code preview. Do not introduce MDX-only tabs or components.
- Preserve every profile declared by protocol-bearing `services*.json`
  entries exactly once in the README.
- Do not edit `services*.json` to encode presentation order or recency.
- Do not change `nodes:docs-generate`; profile tables remain hand-authored.
- Continue to allow column names after `Profile` to match the provider's
  useful metadata, as the existing schema does.

## Schema behavior

The existing `## Profiles` trigger remains unchanged:
`preconfig.profiles` contains at least two entries other than `custom`.

For a node whose `classType` does not contain `llm`, or whose merged service
metadata declares six or fewer profiles, the section remains one ordinary
table. No expandable block is allowed or required.

For a node whose `classType` contains `llm` and whose merged service metadata
declares more than six profiles, `## Profiles` has two tables:

1. A visible table with at most six unique profiles.
2. A second table inside a native `<details>` element containing every
   remaining profile.

The visible set is selected in this order:

1. The declared default profile.
2. Profiles from the provider's two newest recognizable release groups,
   newest group first, until the visible table reaches six rows.

A release group is a provider's human-recognizable model release or version,
not the order of keys in JSON. For example, one release may contain several
variants such as Sol, Terra, and Luna. If the default is already in a newest
release group, it appears only once. The default row is first and is marked
`(default)`.

Recency is an editorial judgment because the current service metadata does
not contain release dates or a dependable newest-first order. Authors make
that choice from provider naming and documentation; human review and
CodeRabbit check it. The deterministic validator does not attempt to infer
which release groups are newest.

The collapsed table contains all profiles not selected for the visible table.
`custom` profiles and profiles with a `deprecated` marker must be collapsed.
For a large-table node, a default that is also `custom` or deprecated makes
the requirements contradictory; validation should report a targeted metadata
inconsistency instead of silently hiding the default or changing metadata.

For directories with multiple protocol-bearing service files, profile counts
and parity follow the validator's current merged-service behavior. Authors may
use `###` service labels when that improves clarity, but the combined set of
rows is evaluated once for the directory.

## Required Markdown shape

Large LLM profile sections use this structure:

```markdown
## Profiles

Default: **GPT-5.2** (`openai-5-2`).

| Profile | Model | Context | Output |
| ------- | ----- | ------- | ------ |
| `openai-5-2` **(default)** | `gpt-5.2` | 400,000 | 128,000 |
| `gpt-5-6-sol` | `gpt-5.6-sol` | 1,050,000 | 128,000 |
| `gpt-5-6-terra` | `gpt-5.6-terra` | 1,050,000 | 128,000 |
| `gpt-5-6-luna` | `gpt-5.6-luna` | 1,050,000 | 128,000 |
| `gpt-5-5` | `gpt-5.5` | 1,050,000 | 128,000 |

<details>
<summary><strong>View 44 more models</strong></summary>

| Profile | Model | Context | Output |
| ------- | ----- | ------- | ------ |
| `openai-5-4` | `gpt-5.4` | 400,000 | 128,000 |
| `custom` | _(user-specified)_ | editable | editable |

</details>
```

The exact columns after `Profile` may be adapted to the node, but the visible
and collapsed tables must use the same column structure. The blank lines
after `</summary>` and before `</details>` are required so the nested Markdown
table is parsed by CommonMark renderers. The summary text is exactly
`View N more models`, where `N` equals the number of rows in the collapsed
table.

The introductory default sentence is retained. It must name the same profile
that is marked in the visible table.

## Validator changes

`scripts/validate-node-readme.py` should parse the whole `## Profiles`
section, including tables inside `<details>`, rather than flattening the first
two columns into an unordered set.

For every triggered Profiles section, validation checks:

- Every declared profile appears exactly once across all profile tables.
- No unknown or duplicate profile appears.
- The declared default is identified in the prose and marked on its row.
- Displayed model identifiers and context/output token values match the
  corresponding `services*.json` profile fields when those semantic columns
  are present. Header aliases such as `Model ID`, `Context tokens`, and
  `Output tokens` remain valid.

For an LLM node with more than six declared profiles, validation additionally
checks:

- A single, well-formed `<details>` block exists in `## Profiles`.
- The visible table contains no more than six profile rows.
- The default is visible.
- `custom` and deprecated profiles are in the collapsed table.
- The details summary count equals the number of collapsed rows.
- The required blank lines around the nested table are present.

For every other triggered Profiles section, validation rejects the expandable
large-table shape and continues to require one ordinary table.

The validator deliberately does not check that the chosen releases are the
newest. That fact is not encoded in the repository and should not be guessed
from object order or profile names.

## Migration scope

The LLM-family documentation change updates:

- `docs/development/nodes/readme-schema.md`
- `scripts/validate-node-readme.py`
- Validator tests or fixtures for the new profile-table rules
- The 18 LLM READMEs not yet migrated to the node README schema:
  `llm_baidu_qianfan`, `llm_bedrock`, `llm_deepseek`, `llm_gemini`,
  `llm_gmi_cloud`, `llm_kimi`, `llm_minimax`, `llm_mistral`, `llm_ollama`,
  `llm_openai`, `llm_openai_api`, `llm_perplexity`, `llm_qwen`,
  `llm_vision_gemini`, `llm_vision_mistral`, `llm_vision_ollama`,
  `llm_vision_openai`, and `llm_xai`
- `llm_anthropic`, already migrated, only to fold its existing large profile
  table into the new shape

`llm_ibm_watson` has no `services*.json`, so it remains outside validator and
profile-table migration scope until its missing service metadata is handled
separately.

No other completed node README changes. In particular, the migration does not
edit service metadata, runtime code, defaults, or generated README regions.

The work ships as one LLM-family pull request targeting `fix/docs`.

## Verification

Automated validator coverage includes:

- Six profiles: one table and no expander.
- Seven or more profiles: a visible table plus expander.
- Default visible and consistently marked.
- Custom and deprecated profiles collapsed.
- Missing, duplicate, and unknown profiles fail.
- Mismatched model or token values fail.
- Incorrect `View N more models` count fails.
- Broken details or blank-line structure fails.
- Non-LLM profile sections retain the single-table behavior.

Before the pull request is ready, run the node README validator across all
nodes and build the complete documentation site. Review the staged pages for
at least one small LLM list, one large list, the migrated Anthropic list, and
the multi-service OpenAI API directory in addition to the automated checks.

## Non-goals

- Automatically synchronizing model releases or release dates.
- Reordering or annotating `services*.json` for documentation presentation.
- Generating profile tables or generated-region markers.
- Changing which model is the runtime default.
- Redesigning the node README section order or other node families.
