# Multimeter·Live

Real-time dashboard for the **ZOYI ZT703s** multimeter, running entirely in the
browser. Connect the meter over the **Web Serial API**, watch live readings on a
large digital display and a rolling trend chart, capture a logging session with
running statistics, and export the result to CSV — no backend, no installation.

![Stack: Next.js · React · TypeScript · Tailwind · Chart.js](https://img.shields.io/badge/stack-Next.js%2016%20·%20React%2019%20·%20TypeScript%20·%20Tailwind%20v4-3b82f6)

> **Device support:** This app is built specifically for the **ZOYI ZT703s** and
> its serial packet format. The **ZT703s+** and **ZT706** likely use the same
> protocol and may work, but they are **untested**. Other multimeters are not
> supported — the parser is tuned to this meter's exact token/unit scheme.

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

- A **ZOYI ZT703s** multimeter connected over USB serial (see device note above).
- A **Chromium-based browser** (Chrome, Edge, Opera). The Web Serial API is not
  available in Firefox or Safari.
- A served origin of **`https://` or `localhost`** — Web Serial requires a secure context.

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

## License

[MIT](./LICENSE)
