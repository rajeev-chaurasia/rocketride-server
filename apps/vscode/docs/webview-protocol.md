---
title: Webview Protocol
sidebar_position: 4
---

## Pipeline Canvas Cloud Setup

The pipeline custom editor exchanges the following Cloud onboarding messages:

| Direction       | Message                             | Purpose                                                                                 |
| --------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| Host to webview | `project:cloudConnectionConfigured` | Updates whether Development or Deployment uses Cloud.                                   |
| Host to webview | `shell:viewActivated`               | Marks a hidden-to-visible custom-editor activation so temporary canvas state can reset. |
| Webview to host | `project:openCloudSetup`            | Opens RocketRide Settings on Development with Cloud preselected.                        |

`project:load` may include `cloudConnectionConfigured`. The field is optional
for compatibility with hosts that do not implement Cloud onboarding.

## Settings Command

`rocketride.page.settings.open` accepts these positional arguments:

1. An optional focus section, such as `development` or `deployment`.
2. An optional connection mode, such as `cloud`.
3. An optional authentication error message.

The two-argument legacy form remains supported. When the second argument is not
a recognized connection mode, it is treated as the authentication error.
