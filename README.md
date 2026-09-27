# Multimeter·Live

Real-time dashboard for the **ZOYI ZT703s** multimeter, running entirely in the
browser. Connect the meter over the Web Serial API and watch the readout, trend and
distribution of your measurements live, log them for up to a week, and export them to
CSV. There is no backend and nothing to install.

[![Build](https://img.shields.io/github/actions/workflow/status/Fyfar/multimeter-live/deploy.yml?branch=main&label=build)](https://github.com/Fyfar/multimeter-live/actions/workflows/deploy.yml)
[![Version](https://img.shields.io/github/package-json/v/Fyfar/multimeter-live?label=version&color=3b82f6)](https://github.com/Fyfar/multimeter-live/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](./LICENSE)
![Stack: Next.js · React · TypeScript · Tailwind · Chart.js](https://img.shields.io/badge/stack-Next.js%2016%20·%20React%2019%20·%20TypeScript%20·%20Tailwind%20v4-3b82f6)

![Multimeter·Live dashboard with the live digital readout, trend chart, and session statistics](./images/dashboard.png)

## Live demo

**<https://fyfar.github.io/multimeter-live/>**

Open it in a supported browser (Chrome, Edge, Opera, or Firefox 151+), connect your
meter, and click **Connect**. Everything runs locally in your browser and no data
leaves your machine.

After the first time, you mostly stop clicking Connect. The app remembers the adapter
you used and picks it back up when you reload or reopen the tab, without the browser's
port chooser. Pressing Disconnect forgets it again, so if you free the port for
something else, a reload will not quietly take it back.

### Install and offline use

Multimeter·Live is a Progressive Web App, so there is no `.exe`, no `.dmg`, and no app
store listing. The web app is the app. In a supporting browser you can install it from
the address-bar install icon and launch it in its own window with its own icon, the way
you would a native desktop program.

After your first visit it works fully offline, which is useful on a bench or in the
field with no Wi-Fi. The meter connects over USB, so nothing in the app needs the
network anyway. The same install runs on Windows, macOS, Linux, and ChromeOS, and the
browser handles the packaging, so there are no separate binaries to maintain or trust.

When a new version is published the app does not reload on its own, because that would
interrupt a recording. It shows a small "A new version is available" notice with Reload
and Later buttons, so you update when it suits you. If a session has rows in it, the
browser will also ask before the page goes away. You never reinstall to update.

> **Not an official ZOYI / ZOTEK product.** Multimeter·Live is an independent,
> community-built project and is **not affiliated with, endorsed by, or supported
> by ZOYI or ZOTEK**. "ZOYI", "ZOTEK", and "ZT703s" are referenced only to describe
> the hardware this tool works with.

> **Device support:** Built specifically for the **ZOYI ZT703s** and its serial
> packet format, tested on firmware **1.6.27**. The **ZT703s+** and **ZT706** likely
> use the same protocol and may work, but they are **untested**. Other multimeters are
> not supported.

## Features

- **Live readout and trend chart.** A large digital display with mode, unit and
  resolution, next to a rolling chart with 10 s, 1 m, 10 m, 1 h or whole-session windows.
- **Histogram view** of how your readings are distributed, binned to the meter's own
  resolution. Handy for seeing noise, drift, or how tightly a batch of parts clusters.
- **Continuous logging for up to 7 days.** Leave a session running and it keeps every
  sample for a full week, with running statistics (average, min, max, peak-to-peak,
  standard deviation) over the whole run.
- **Searchable data log** with a note field on every row, and **CSV export** of the
  session.
- **Pass/Fail component testing.** Set a reference and tolerance, touch parts one after
  another, and get a beep and a verdict for each. See below.
- **Smart capture.** Log only stable values, or arm a trigger threshold so recording
  starts and stops by itself as the signal crosses it.
- **Installable and offline.** A PWA that reconnects to your last adapter on its own and
  needs no network once loaded.

A week of samples lives in the open tab's memory, so it survives as long as the tab does:
the connection and your view come back after a reload, but the recorded data does not.
That is deliberate, not an oversight. Export a CSV before you close it.

## Pass/Fail component testing

Type in a reference value and a tolerance, then touch parts one after another. Each
part that settles gets a PASS or FAIL against the band, lands in a table, and can
optionally beep. The pass and fail tones are far apart in pitch and length so you can
tell them apart without looking at the screen, which is the point when you are sorting
a tray of resistors. Verdicts export to their own CSV, separate from the data log.

Some honest limits. It covers resistance, diode, and capacitance only: voltage and
current have no overload reading on lifted probes, so there is no reliable way to tell
where one part ends and the next begins. A part that reads as a dead short is reported
as "no part connected" rather than as a failure, so Pass/Fail finds out-of-tolerance
parts rather than shorts. Meter accuracy is not modelled, though the app warns you if
your tolerance band is narrower than the meter can resolve.

## Limitations

The meter can measure both DC and AC voltage and current, and shows frequency for AC
signals on its own display. It does **not** send any of that over UART. The serial
stream carries only the value and its unit (V, mV, A, mA), the same for DC and AC, so
the app cannot tell the two apart. Voltage and current are therefore shown simply as
"Voltage" and "Current", and there is no frequency data anywhere in the app. Read
frequency, and check whether you are measuring DC or AC, on the meter itself.

Tested on a ZT703s with firmware 1.6.27. Other firmware versions may send different
data.

## Requirements

- A **ZOYI ZT703s** multimeter connected over USB serial (see the device note above).
- A browser with the Web Serial API: any Chromium-based browser (Chrome, Edge, Opera)
  or **Firefox 151+** on desktop ([added May 2026](https://hacks.mozilla.org/2026/05/web-serial-support-in-firefox/)).
  Safari is not supported. On Firefox Enterprise builds, Web Serial is off by default
  and has to be enabled with the `DefaultSerialGuardSetting` policy.
- An origin served over `https://` or `localhost`, because Web Serial requires a secure
  context. The live demo is served over HTTPS, so it works as-is.

## Run it locally

```sh
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), click **Connect**, and pick your
serial port from the browser prompt.

## Contributing

Issues and pull requests are welcome. If you have a ZT703s+ or ZT706 and can confirm
whether it works, or you would like to add a feature or fix a bug, please open an
[issue](https://github.com/Fyfar/multimeter-live/issues) or send a PR.

## License

[MIT](./LICENSE)
