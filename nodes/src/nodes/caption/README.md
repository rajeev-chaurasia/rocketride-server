# caption

A RocketRide image node that turns each input image into a natural-language caption. Choose it when downstream text processing needs an image description rather than boxes, masks, or extracted text.

## About Florence-2

Florence-2 is the image captioning model used by this node. The node loads the configured model identifier and optional revision, and sends its configured caption task to the model for each image.

## What it does

The node buffers each incoming image stream, captions the completed image, and writes the resulting string on the `text` lane. It offers short, detailed, and more-detailed caption tasks through its configuration. Choose it for a general natural-language description of image content; the node metadata directs object-detection use cases to Object Detection and text-reading use cases to OCR.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `image` | `text` | Caption string for the completed input image. |

## Configuration

The single supplied profile selects the Florence-2 Base model, so most use cases only need a granularity choice. The implementation uses its default model and task if either value is empty.

### Granularity

Granularity selects one of three configured tasks: `caption` (the default, shown as Short), `detailed_caption`, or `more_detailed_caption`. Keep the default when a concise description is sufficient; use a more detailed task when the next node needs richer text to reason over. The task is passed directly to the captioning facade, so choose one of the values exposed in the configuration panel.

## Requirements

This node is marked as GPU-capable. Its metadata declares local CPU, Apple Silicon (MPS), and CUDA operation; when a model server is configured the captioning facade uses it, otherwise it runs locally. Local inference is guarded by a device lock, which serializes caption generation. The source does not state VRAM requirements or a CPU-versus-accelerator speed comparison.

## Notes

### Empty captions on failure

The node runs captioning only when the `text` lane has a listener. If image decoding or caption inference raises an exception, it logs a warning and writes an empty string to that listener instead of propagating a result from the failed image.

## Upstream docs

- [Florence-2 Base model page](https://huggingface.co/microsoft/Florence-2-base)
