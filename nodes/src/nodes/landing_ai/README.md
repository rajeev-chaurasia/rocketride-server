# landing_ai

A RocketRide document-processing package with separate Landing.ai Parse and Extract services: use Parse to turn an incoming document into Markdown and tables, then Extract when that Markdown must conform to a JSON Schema.

## About Landing.ai

Landing.ai provides Agentic Document Extraction (ADE), a document-processing
service for converting unstructured files into usable text and structured
data. In this package, ADE supplies a parsing operation and a schema-guided
extraction operation, which can be composed in a RocketRide pipeline.

## What it does

Landing.ai Parse receives document bytes on the `tags` lane and emits the ADE
Markdown response and any table chunks. Landing.ai Extract receives parsed
Markdown on `text`, calls ADE with an uploaded JSON Schema, and emits the
result as either an answer or one or more documents. Pick this package when
you need both operations from the same ADE service; choose Parse alone when
you only need readable document text and tables.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `tags` | `text` | Landing.ai Parse writes the document Markdown response. |
| `tags` | `table` | Landing.ai Parse writes each ADE chunk whose type is `table`. |
| `text` | `answers` | Landing.ai Extract writes its structured extraction as a JSON answer. |
| `text` | `documents` | Landing.ai Extract writes the extraction as JSON document content. |

## Configuration

Both services have one default profile. Configure the service that is placed
on the canvas: Parse needs a key and, normally, its default model and region;
Extract additionally needs an uploaded schema. The services look up a nested
`default` configuration when one is present.

### Landing.ai Parse

**Model** controls the value sent to ADE's `parse` call; its default is
`dpt-2-latest`, the only value offered by this node. Keep that default unless
the node's configuration is extended with another supported ADE model. The
**Region** defaults to `production`; select `eu` when the EU deployment is
required. Any other configured region is silently reset to `production` by
the parser, so use one of the two offered values.

### Landing.ai Extract

**Extraction Schema (JSON Schema file)** is required by the service metadata.
Upload a JSON-object data URL, not a plain value or array: the node decodes it,
rejects malformed JSON and uploads over 2 MiB, then serializes the object for
ADE. Use it to define the fields the response must contain; a bad upload is
reported during validation as a warning and fails when extraction runs.

**Strict** defaults to off. Leave it off when a partial extraction is useful;
enable it when a document that does not satisfy the schema must fail instead
of yielding a partial result. **Region** has the same `production`/`eu`
behavior as Parse and is likewise normalized to `production` for any other
value.

## Authentication

Set each service's **API Key** to a Landing.ai ADE key, or set
`ROCKETRIDE_LANDING_AI_KEY` when the field is blank. Save-time credential
checks make a small read-only `parse_jobs.list` call and report problems as
warnings; they do not block editing the pipeline.

## Notes

### Processing and failure behavior

Parse skips the ADE call entirely when neither its `text` nor `table` output
has a listener. With an API key missing or an empty document, it returns empty
text and no tables; an ADE request failure is logged and re-raised. Extract
joins all received text with blank lines. Empty input or a missing key produces
an empty extraction, while an invalid schema or ADE failure is logged and
re-raised. If the upstream response includes extraction warnings, the node
logs them but returns the response extraction.

### Extract document output

When `documents` is connected, Extract turns an object result into one JSON
document. If the extracted value is a list, it emits one JSON document per
item, numbering their chunk IDs from zero for each input object.

## Upstream docs

- [Landing.ai ADE Python documentation](https://docs.landing.ai/ade/ade-python)
