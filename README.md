# Multimeter·Live

Real-time dashboard for the **ZOYI ZT703s** multimeter, running entirely in the
browser. Connect the meter over the **Web Serial API**, watch live readings on a
large digital display and a rolling trend chart, capture a logging session with
running statistics, and export the result to CSV — no backend, no installation.

![Stack: Next.js · React · TypeScript · Tailwind · Chart.js](https://img.shields.io/badge/stack-Next.js%2016%20·%20React%2019%20·%20TypeScript%20·%20Tailwind%20v4-3b82f6)

![Multimeter·Live dashboard — live digital readout, trend chart, and session statistics](./images/dashboard.png)

## Live demo

**<https://fyfar.github.io/multimeter-live/>**

Open it in a supported browser (Chrome, Edge, Opera, or Firefox 151+), connect
your meter, and click **Connect**.
Everything runs locally in your browser — no data leaves your machine.

### Install & offline — no native app needed

Multimeter·Live is a **Progressive Web App (PWA)**, so there is **nothing to
download and no platform-specific build** — no `.exe`, no `.dmg`, no app store.
The web app *is* the app. In a supporting browser you can **install** it (the
address-bar install icon) to launch it in its own window, with its own icon, just
like a native desktop program.

After your first visit it also works **fully offline** — handy on a bench or in
the field with no Wi-Fi, since the meter connects over USB and nothing in the app
needs the network. The same install runs on Windows, macOS, Linux, and ChromeOS;
the browser handles the packaging, so there are no separate binaries to maintain
or trust.

When a new version is published, the app doesn't reload on its own (that would
interrupt a recording). Instead it shows a small **"A new version is available —
Reload / Later"** message, so you update on your terms. You never reinstall to
update.

> **Not an official ZOYI / ZOTEK product.** Multimeter·Live is an independent,
> community-built project and is **not affiliated with, endorsed by, or supported
> by ZOYI or ZOTEK**. "ZOYI", "ZOTEK", and "ZT703s" are referenced only to describe
> the hardware this tool works with.

> **Device support:** Built specifically for the **ZOYI ZT703s** and its serial
> packet format. The **ZT703s+** and **ZT706** likely use the same protocol and may
> work, but they are **untested**. Other multimeters are not supported.

## Features

- **Live digital readout** of the current measurement, mode, unit, and resolution
- **Rolling trend chart** with selectable time windows — 10 s, 1 m, 10 m, 1 h, or
  **all** (plots the entire session)
- **Session logging** with running statistics: average, min, max, peak-to-peak,
  sample count, and standard deviation
- **Trigger auto-logging** — arm a threshold and recording starts automatically when
  the measured magnitude crosses it, then stops once it falls back below (hysteresis,
  so a signal hovering at the edge doesn't flap logging on and off)
- **Auto-scale or manual Y-axis range**, with out-of-range samples flagged on the chart
- **CSV export** of the recorded session (timestamp, mode, value, unit)
- **Configurable baud rate** (9600–115200)
- Supported modes: voltage, current, resistance, continuity, diode, capacitance.
  Values are normalized to canonical base units (e.g. mV → V) so a mid-stream unit
  switch doesn't make the chart jump.

## Requirements

- A **ZOYI ZT703s** multimeter connected over USB serial (see device note above).
- A browser with the **Web Serial API**: any **Chromium-based browser** (Chrome,
  Edge, Opera) or **Firefox 151+** on desktop ([added May 2026](https://hacks.mozilla.org/2026/05/web-serial-support-in-firefox/)).
  Safari is not supported. On Firefox Enterprise builds, Web Serial is disabled by default
  and must be enabled via the `DefaultSerialGuardSetting` policy.
- A served origin of **`https://` or `localhost`** — Web Serial requires a secure
  context. The live demo is served over HTTPS, so it works out of the box.

## Run it locally

```sh
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), click **Connect**, and pick
your serial port from the browser prompt.

## Contributing

Issues and pull requests are welcome! If you have a ZT703s+ or ZT706 and can confirm
whether it works, or you'd like to add a feature or fix a bug, please open an
[issue](https://github.com/Fyfar/multimeter-live/issues) or send a PR.

## License

[MIT](./LICENSE)
