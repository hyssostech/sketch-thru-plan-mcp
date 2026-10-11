---
sidebar_label: Running the STP engine
sidebar_position: 3
description: Install and run the STP engine in Docker or on Windows, the ports SDK apps need, how to check that it is running, the settings you are expected to change, and what to check when an app cannot connect.
---

# Installing and running the STP engine

The SDKs are clients: every app built with them connects to a running STP
engine. This page is for whoever sets that engine up, for development or for
a deployment.

This page answers these questions:

- Which ways can I run the STP engine, and which one should I pick?
- Which ports does an SDK app need, and which can stay closed?
- How do I run the engine in Docker, or install it on Windows?
- How do I check that the engine is running and that my app can reach it?
- Which settings am I expected to change, and where do I change them?
- What do I check when my app cannot connect?

## Choose a deployment

STP is distributed by Hyssos Technology as a container image and as Windows
installers. Contact Hyssos to obtain them. Every option below contains the
whole engine, including the WebSocket bridge the SDKs connect to and the
[REST connector](./reference/rest-connector.md).

| Option | What it is | Use it for |
|---|---|---|
| **Docker image** | A Linux x64 container running the engine headless | Servers, cloud and lab deployments, and development on a machine with Docker |
| **Windows Server installer** | `STP.Server-<version>.Bundle.exe`. The engine runs headless, per machine. | A Windows server that SDK apps connect to over the network |
| **Windows Server Core installer** | `STP.ServerCore-<version>.Bundle.exe`. As Server, without task recognition. | A server where your app does not use [tasks](./guides/tasks.md) |
| **Windows Development installer** | `STP.Development-<version>.Bundle.exe`. Installed per user, with a desktop window to start and stop the engine. | Writing and testing an SDK app on one Windows machine |

There is also a **Desktop** installer, the end-user product with the ArcGIS
Pro add-in. It is not needed for SDK development and is not covered here.

The headless options (Docker, Server, Server Core) also serve a management
console, health probes and a management API on port 9500. The Development
install has a desktop window instead.

### What the engine does not need

- **No speech service key.** Speech recognition for SDK apps runs in the
  client, through a [speech plugin](./plugins/speech.md), and the client sends
  STP the recognized text. The speech service key belongs to the client app,
  not to the engine.
- **No separate runtime installs.** The container image is self-contained.
  Each Windows installer is a single file that installs without network
  access: it carries the Visual C++ Redistributable, the .NET 10 runtime and
  the ASP.NET Core 10 runtime (and, for Development, the .NET Windows Desktop
  Runtime), and installs whichever are missing. Task recognition is built in;
  nothing else, such as Prolog, has to be installed.

## Ports

| Port | Protocol | Used by | Open it? |
|---|---|---|---|
| **9599** | WebSocket | The JavaScript and .NET SDKs: `ws://<host>:9599` | **Yes.** This is the port SDK apps use. |
| **9500** | HTTP | Management console (`http://<host>:9500/`), health probes `/healthz` and `/readyz`, management API, and the REST connector under `/api/stp/` | Recommended on headless deployments, for health checks. Limit who can reach it (see [Protect the management port](#protect-the-management-port)). |
| **9575** | HTTP | The REST connector directly: `http://<host>:9575/api/v1`, Swagger UI | Only if REST clients cannot use port 9500. |
| **9555** | TCP | Communication between STP's own components inside the engine | **No.** SDK apps never use it. |

The ports SDK apps use can be changed (see [Settings you can change](#settings-you-can-change)).

## Run the engine in Docker

**Requirements:** Docker on an x64 (amd64) host, Linux or Docker Desktop.
Give the container 2 GB of memory and 2 CPUs. It starts and serves light use
with 512 MB and one CPU. Memory use grows with the number of sessions and the
size of their scenarios.

### Get the image

Hyssos provides the image either through a container registry or as an
archive file. If you received an archive, load it:

```bash
docker load -i <image-archive>.tar
```

`docker load` prints the image's name and tag. Below, `<stp-image>` stands for
that name and tag.

### Start the container

```bash
docker run -d --name stp-server \
  -p 9599:9599 \
  -p 9500:9500 \
  -v stp-data:/var/lib/stp \
  -v stp-logs:/var/log/stp \
  --restart unless-stopped \
  <stp-image>
```

- **`-p 9599:9599`** is the port SDK apps connect to. **`-p 9500:9500`** gives
  you the health probes, the management console and the REST connector. Add
  `-p 9575:9575` only if a REST client must reach the connector directly.
- **`/var/lib/stp`** holds the scenarios of every session and the settings
  saved from the management console. With a volume there, they survive
  `docker rm` and an image upgrade. Without one they survive a restart but are
  lost when the container is removed.
- **`/var/log/stp`** holds the log files (see [Logs](#logs)).
- The container runs as a non-root user (`stp`, UID 10654). Do not mount a
  volume over `/usr/share/STP/Config`: it would hide the configuration that
  later images ship.

### Stop the container

```bash
docker stop -t 30 stp-server
```

The engine shuts down cleanly on `SIGTERM`, but it takes longer than Docker's
default of 10 seconds, after which Docker kills it. Allow 30.

### Docker Compose

```yaml
services:
  stp:
    image: <stp-image>
    restart: unless-stopped
    stop_grace_period: 30s
    ports:
      - "9599:9599"   # WebSocket: SDK clients
      - "9500:9500"   # management console, health probes, REST connector
    volumes:
      - stp-data:/var/lib/stp
      - stp-logs:/var/log/stp
    environment:
      - STP_Nucleus__Deployment__FileTraceLevel=Info
      # - STP_Nucleus__Management__ApiKey=change-me
      # - STP_Nucleus__Cors__AllowedOrigins__0=https://app.example.com
    mem_limit: 2g
    cpus: 2.0

volumes:
  stp-data:
  stp-logs:
```

```bash
docker compose up -d      # start in the background
docker compose ps         # STATUS shows (healthy) once the engine is up
docker compose logs -f    # follow the log (one JSON object per line)
docker compose down       # stop and remove the container; the volumes stay
```

The image has a built-in health check on `/healthz`, so `docker ps` and
`docker compose ps` show `(healthy)` once the engine is up.

## Install the engine on Windows

### Server and Server Core

1. Run `STP.Server-<version>.Bundle.exe` (or `STP.ServerCore-<version>.Bundle.exe`)
   with administrator rights. It installs for all users. Accept the license
   and choose the folder. The default is
   `C:\Program Files\STP-Server-<version>\` (`STP-ServerCore-<version>` for
   Server Core).
2. Start the engine from the install folder:
   - `STP_ServerAdvanced.bat` starts it with task recognition (Server only).
   - `STP_ServerCore.bat` starts it without task recognition.

   These installers add no Start menu shortcuts.
3. Check it as in [Check that the engine is running](#check-that-the-engine-is-running).

The installers add inbound Windows Firewall rules for ports 9555, 9599 and
9575, named *STP Facilitator*, *STP WebSocket Bridge* and *STP REST
Connector*. The rules allow the local subnet only, on the domain and private
network profiles. Clients outside the local subnet, or a server on a public
network profile, need a rule of your own. Port 9500 has no rule; add one if
you need the management console from another machine:

```powershell
New-NetFirewallRule -DisplayName "STP management (TCP-In)" -Direction Inbound `
  -Protocol TCP -LocalPort 9500 -RemoteAddress LocalSubnet -Action Allow
```

The installer does not register a Windows service. Contact Hyssos if the
engine must start with the machine.

### Development

1. Run `STP.Development-<version>.Bundle.exe`. It installs STP for the
   current user only, under `%LOCALAPPDATA%\STP-Development-<version>\`.
2. Start **STP Development &lt;version&gt; (w Tasks)** from the desktop or
   the Start menu (or `STP_DevelopmentAdvanced.bat` in the install folder).
   The *wo Tasks* shortcut starts it without task recognition.
3. In the Nucleus window that opens, select **Start STP**.

A Development install accepts SDK connections **from the same computer only**
(`ws://localhost:9599`). To let apps on other machines connect, set the
WebSocket bridge's address to `any` before starting it, for example as a user
environment variable, and allow port 9599 through the firewall (this installer
adds no firewall rules):

```powershell
[Environment]::SetEnvironmentVariable("STP_Nucleus__WebSocket__Address", "any", "User")
```

For a machine that other people's apps connect to, prefer the Server installer
or the Docker image.

## Check that the engine is running

### Health probes (Docker, Server, Server Core)

```bash
curl http://localhost:9500/healthz    # "Healthy": the process is up
curl http://localhost:9500/readyz     # "Ready": the engine accepts work
```

`/readyz` answers `503` while the engine is starting. Wait for `200` before
connecting apps or routing traffic. Startup usually takes seconds; allow up to
a minute. On Windows, use `curl.exe` or `Invoke-RestMethod`.

For more detail, `GET /api/mgmt/status` lists the engine's components and
whether each is online:

```bash
curl http://localhost:9500/api/mgmt/status
```

```json
{"engineState":"Running","components":[
  {"name":"Nucleus","service":"Nucleus","status":"Online","pid":"7"},
  {"name":"TaskRecognizer","service":"Task Recognition","status":"Online","pid":"38"},
  {"name":"RESTConnector","service":"RESTConnector","status":"Online","pid":"47"}]}
```

Server Core has no `TaskRecognizer`. The same information, with live logs, is
in the management console at `http://localhost:9500/`.

### Connect from the JavaScript SDK

This is the check that matters: it connects the way your app will. It runs
in Node.js 22 or later, which has a built-in WebSocket.

```bash
npm install sketch-thru-plan-sdk
```

```javascript
// check-stp.mjs - connect to an STP engine and ask whether a scenario is loaded
import { StpWebSocketsConnector, StpRecognizer } from "sketch-thru-plan-sdk";

const url = process.argv[2] ?? "ws://localhost:9599";
const connector = new StpWebSocketsConnector(url);
const stp = new StpRecognizer(connector);
stp.onStpMessage = (msg, level) => console.log(`STP message (${level}): ${msg}`);

try {
  const session = await stp.connect("StpInstallCheck", 10);
  console.log(`Connected to ${url}, session ${session}`);
  console.log(`Active scenario: ${await stp.hasActiveScenario()}`);
  await connector.disconnect();
  process.exit(0);
} catch (e) {
  console.error(`Could not reach STP at ${url}: ${e?.message ?? e}`);
  process.exit(1);
}
```

```bash
node check-stp.mjs ws://localhost:9599
```

A working engine prints:

```
Connected to ws://localhost:9599, session 3AD46DE54163
Active scenario: false
```

`Active scenario` is `false` on a new engine and `true` once a client has
created or loaded a scenario in that session. From C#, the same check is
`ConnectAndRegisterAsync` followed by `HasActiveScenarioAsync`, as in the
[.NET quickstart](./getting-started-dotnet.md).

### The REST connector

```bash
curl -i http://localhost:9500/api/stp/api/v1/health   # through port 9500
curl -i http://localhost:9575/api/v1/health           # directly, if 9575 is open
```

`200` means the connector is connected to STP. The connector starts a few
seconds after the engine, so right after startup port 9500 can answer `502`
for a moment. See [REST connector](./reference/rest-connector.md) for its API.

## Settings you can change

Change settings with environment variables or with the operator settings
file. **Do not edit `appsettings.json`**: it holds the shipped defaults, and
every install and upgrade replaces it.

**Environment variables** are named `STP_Nucleus__<Section>__<Key>` for the
engine and `STP_RESTConnector__<Section>__<Key>` for the REST connector:

| Setting | Environment variable | Default | Meaning |
|---|---|---|---|
| `WebSocket:Port` | `STP_Nucleus__WebSocket__Port` | `9599` | Port SDK apps connect to |
| `WebSocket:Address` | `STP_Nucleus__WebSocket__Address` | `any` in the Docker image and the Server installers, `loopback` (this computer only) in a Development install | Address the WebSocket bridge listens on |
| `Management:Port` | `STP_Nucleus__Management__Port` | `9500` | Management console, health probes and REST proxy |
| `Management:ApiKey` | `STP_Nucleus__Management__ApiKey` | none | When set, the management API requires this key (see below) |
| `Cors:AllowedOrigins` | `STP_Nucleus__Cors__AllowedOrigins__0`, `__1`, ... | none | Browser origins allowed to call the HTTP APIs on port 9500 |
| `Deployment:FileTraceLevel` | `STP_Nucleus__Deployment__FileTraceLevel` | `Info` | Log detail: `Trace`, `Debug`, `Info`, `Warning` |
| `Listen:Port` (REST connector) | `STP_RESTConnector__Listen__Port` | `9575` | The REST connector's own port |

In Docker, pass them with `-e`, for example
`-e STP_Nucleus__WebSocket__Port=9600`. Change the container side of `-p`
to match (`-p 9600:9600`), or keep the engine's port and change only the host
side (`-p 9600:9599`).

**The operator settings file** `nucleus.local.json` is what the management
console's **Save** writes, and it can be edited by hand. It is in
`/usr/share/STP/Data/Settings/` in the container (on the `/var/lib/stp`
volume) and in `%ProgramData%\STP\Data\Settings\` for a Server install. It
uses the same names as JSON sections:

```json
{
  "Management": { "ApiKey": "change-me" },
  "Cors": { "AllowedOrigins": ["https://app.example.com"] }
}
```

Environment variables take precedence over the file. Settings take effect
when the engine starts.

### Protect the management port

Port 9500 has no authentication by default: anyone who can reach it can shut
the engine down or change its settings. On any shared network, set an API key
and limit who can reach the port:

```bash
docker run -d --name stp-server \
  -e STP_Nucleus__Management__ApiKey="$(openssl rand -base64 32)" \
  -p 9599:9599 -p 9500:9500 \
  -v stp-data:/var/lib/stp -v stp-logs:/var/log/stp \
  <stp-image>
```

With a key set, `/api/mgmt/*` requests without the key in an `X-API-Key`
header are refused, and the console asks for the key. The health probes and
the REST connector under `/api/stp/` stay open.

```bash
curl -H "X-API-Key: <your key>" http://localhost:9500/api/mgmt/status
```

### Browser apps on another origin, and TLS

The WebSocket bridge itself does not check origins, so a browser app can
connect to `ws://<host>:9599` from any page. A page served over HTTPS,
however, may only open `wss://` connections. Put a reverse proxy with TLS in
front of port 9599 and give your app the proxy's `wss://` URL. The proxy must
pass WebSocket upgrades through and allow long-lived connections.

`Cors:AllowedOrigins` matters only for browser code that calls the HTTP APIs
on port 9500, such as the REST connector under `/api/stp/`.

### Several engines

An engine keeps each [session](./guides/sessions.md) in its own memory, and
a session cannot span engines. If you run several engines behind a load
balancer, every client of a session must reach the same engine: route by
session or use sticky sessions, and allow WebSocket upgrades.

### C2SIM

To exchange plans with a C2SIM server (see [C2SIM](./guides/c2sim.md)), set
the server's addresses:

```bash
-e STP_C2SimBridge__App__RestUrl=http://<c2sim-host>:8080/C2SIMServer \
-e STP_C2SimBridge__App__StompUrl=http://<c2sim-host>:61613/topic/C2SIM
```

The defaults point at `127.0.0.1`, which inside a container is the container
itself. If the C2SIM server is unreachable, STP logs the failed connection
and everything else works normally.

## Logs

- **Docker:** `docker logs stp-server` shows the engine's log, one JSON
  object per line. Fuller log files are in `/var/log/stp`:
  `Nucleus-<date>.log`, `RESTConnector-<date>.log` and
  `TaskRecognizer-<date>.log`.
- **Headless deployments:** the management console's **Logs** tab streams
  the log files.

Raise the detail with `STP_Nucleus__Deployment__FileTraceLevel=Debug` when
Hyssos support asks for it.

## Troubleshooting

### The app cannot connect

The JavaScript SDK reports `Failed to connect: Unspecified error
communicating with STP`. The .NET SDK throws `StpCommunicationException`. Check,
in this order:

1. **Is the engine up?** `/readyz` returns `Ready`, or the Nucleus window
   shows STP started (Development).
2. **Is the right port reachable?** Use `ws://<host>:9599` (not `http://`).
   For Docker, `docker ps` must show `0.0.0.0:9599->9599/tcp` in PORTS.
3. **Is the bridge listening on the network?** The engine logs the address at
   startup: `WebSocketsBridgeAgent listening at 0.0.0.0:9599` accepts
   connections from other machines, `127.0.0.1:9599` only from the same one.
   Set `WebSocket:Address` to `any` (see [Settings](#settings-you-can-change)).
4. **Is a firewall in the way?** The Windows installer rules allow the local
   subnet only, on domain and private networks.
5. **Is the page served over HTTPS?** Then it needs a `wss://` URL (see
   [Browser apps on another origin, and TLS](#browser-apps-on-another-origin-and-tls)).

After a lost connection, see [Connection lifecycle and reconnecting](./guides/connection-lifecycle.md).

### `/readyz` stays at 503

The engine did not finish starting. `/api/mgmt/status` shows which component
is not `Online`, and the end of the log shows where startup stopped:

```bash
docker logs --tail 50 stp-server
```

A healthy engine also logs some `ERROR` lines, for example a refused
connection to a C2SIM server that is not configured. Look at the last messages
before startup stopped, rather than at every error.

### The container exits right after starting

Look at `docker logs stp-server`. The usual causes are a port already in use
on the host, or too little memory for the container.

### The management API answers 403

An API key is set. Send it in the `X-API-Key` header.

### Scenarios are gone after recreating the container

`/var/lib/stp` was not on a volume. Start the new container with
`-v stp-data:/var/lib/stp`, as above.

## See also

- [Installation](./installation.md): install the JavaScript SDK
- [Getting Started](./getting-started.md) and the [.NET quickstart](./getting-started-dotnet.md): your first app
- [Sessions](./guides/sessions.md): sharing a scenario between clients
- [REST connector](./reference/rest-connector.md): the HTTP API
