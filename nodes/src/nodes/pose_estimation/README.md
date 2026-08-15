# pose_estimation

A RocketRide image node that estimates human poses and produces a per-person set of COCO keypoints with an annotated skeleton. Choose it when a pipeline needs body position or joints, rather than only person detections or face locations.

## About RTMPose

RTMPose is the human-pose-estimation engine used here through the rtmlib ONNX wrapper. This node first detects people, then uses RTMPose to predict the keypoints for each retained person crop.

## What it does

For every input image frame, the node estimates people and emits a JSON array of person boxes with 17 COCO keypoints, as well as an annotated JPEG with skeleton lines and points. The configured threshold controls what is drawn, and the retained-person limit bounds crowded-frame processing. Use it instead of face detection when full human pose matters, and instead of object detection when downstream work needs joint locations.

## Lanes

| Lane in | Lane out | Description |
| ------- | -------- | ----------- |
| `image` | `image` | JPEG copy of the frame annotated with person boxes, skeleton edges, and qualifying keypoints. |
| `image` | `text` | JSON array of people, each with a `person` label, a box, and 17 named COCO keypoints containing coordinates and scores. |

## Profiles

| Profile | Default keypoint threshold | Default maximum persons |
| ------- | -------------------------- | ----------------------- |
| RTMPose Tiny | `0.3` | `20` |
| RTMPose Medium *(default)* | `0.3` | `20` |
| RTMPose Large | `0.3` | `20` |

## Configuration

Select a pose profile first, then use the threshold and person cap to balance useful annotation against work on each frame. The implementation normalizes invalid values at startup, so keeping the configuration within its declared range makes the chosen behavior explicit.

### Model

The Tiny, Medium, and Large profiles select their corresponding RTMPose modes; the default is Medium. Use a smaller profile where response time matters more than pose detail, and a larger profile where the available compute justifies it. An unknown profile falls back to the implementation's default mode.

### Keypoint score threshold

This `0.0`–`1.0` threshold controls skeleton rendering: keypoints below it are not drawn, and an edge is omitted if either endpoint is below it. The default `0.3` gives a moderately permissive overlay. Raise it to remove uncertain joints from the image output; lower it to show more tentative joints. The text output still receives the estimator's keypoint array, so consumers that make their own confidence decision should use the scores in JSON rather than relying on the drawing.

### Max persons per frame

The node keeps at most this many people after sorting by detection score. The default is `20`; reduce it for crowd scenes when latency or memory usage matters, and increase it when every person in a dense image is important. The runtime clamps the value to the `1`–`200` range.

## Requirements

This node declares GPU capability. It creates the pose-estimation facade with no fixed device: with a model server configured, inference is delegated there; otherwise it runs locally and serializes device access with a shared lock. Plan accelerator capacity for local high-throughput processing, especially when retaining many people per frame.

## Notes

### Output and failures

The text and image outputs are emitted only when their lanes have listeners. If an image cannot be decoded or inference fails, the node logs a warning, drops the frame, and prevents default forwarding instead of producing a partial pose result.

## Upstream docs

- [RTMPose documentation](https://mmpose.readthedocs.io/)
