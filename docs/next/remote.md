---
title: Remote access
description: Supported OpenSSH loopback forwarding and reconnect behavior
ms.date: 2026-08-30
ms.topic: how-to
---

## Supported topology

The supported remote path is OpenSSH local forwarding from a private local loopback port to the remote daemon loopback listener. Nanasa validates the SSH target and absolute repository path, then discovers exact repository, instance, build, protocol, and systemd service identity.

Run the remote project service first, then use `nanasa remote connect <user@host> --repo <absolute-path>`. The tunnel uses `ExitOnForwardFailure`, keepalives, batch authentication, and no Nanasa-managed password or private-key input.

## Reconnect

Tunnel loss means transport is offline. It does not prove remote process loss and does not restart remote tmux. Recreate the tunnel with the printed reconnect command, reload the portal, and let the client resnapshot.

Direct public portal exposure, multi-user tenancy, and distributed runners are unsupported.
