# Multimeter·Live

Real-time multimeter dashboard that runs entirely in the browser. Connect a USB
multimeter over the **Web Serial API**, watch live readings on a large digital
display and a rolling trend chart, capture a logging session with running
statistics, and export the result to CSV — no backend, no installation.

![Stack: Next.js · React · TypeScript · Tailwind · Chart.js](https://img.shields.io/badge/stack-Next.js%2016%20·%20React%2019%20·%20TypeScript%20·%20Tailwind%20v4-3b82f6)

## Features

- **Live digital readout** of the current measurement, mode, unit, and resolution
- **Rolling trend chart** (Chart.js) with selectable time windows — 10 s, 1 m, 5 m, 1 h
- **Session logging** — start/stop recording with running statistics:
  average, min, max, peak-to-peak, sample count, and standard deviation (Welford)
- **Auto-scale or manual Y-axis range**, with out-of-range samples flagged on the chart
- **CSV export** of the recorded session (timestamp, mode, value, unit)
- **Configurable baud rate** (9600–115200)
- Supported modes: voltage, current, resistance, continuity, diode, capacitance.
  Values are normalized to canonical base units (e.g. mV → V) so a mid-stream
  unit switch doesn't make the chart jump.

## Requirements

- A **Chromium-based browser** (Chrome, Edge, Opera). The Web Serial API is not
  available in Firefox or Safari.
- A served origin of **`https://` or `localhost`** — Web Serial requires a secure context.
- A USB multimeter that streams ASCII measurements over a serial connection.

## Getting Started

```sh
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), click **Connect**, and pick
your serial port from the browser prompt.

## Build

```sh
npm run build
npm run start
```

## Lint

```sh
npm run lint
```

## Architecture

The app is **client-only** — all parsing and processing happen in the browser;
there are no API routes or server-side data fetching (Web Serial is browser-only
and cannot be proxied).

```
app/page.tsx            Orchestrator: Web Serial lifecycle, session state, CSV export
components/
  DigitalDisplay.tsx    Current reading, mode, resolution
  RealtimeChart.tsx     Chart.js line chart with streaming updates
  StatisticsPanel.tsx   Session statistics
  Controls.tsx          Recording, Y-range, export controls
  Sidebar.tsx           Connection panel
lib/
  parser.ts             Stateful, buffer-safe parser for the serial stream
  useSerial.ts          Web Serial lifecycle hook (connect, read loop, cleanup)
```

The serial parser buffers raw chunks and only emits a measurement once the next
token delimits its end, so a packet cut mid-word never loses data.

## Stack

- [Next.js](https://nextjs.org/) 16 (App Router, client-only)
- React 19
- TypeScript 5
- Tailwind CSS v4
- Chart.js 4 (tree-shaken to the components actually used)

## License

[MIT](./LICENSE)
