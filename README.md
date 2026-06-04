# Bluetooth Devices Indicator

A GNOME Shell extension that adds a panel indicator showing every **connected**
Bluetooth device as a type icon (headphones, mouse, keyboard, trackpad, …) with
a small battery-level bar beside it. Hover a device to see a tooltip with its
name (and battery percentage).

## How it works

- Device list, type icon and connection state come from **BlueZ** over the
  system D-Bus (`org.bluez.Device1`). The `Icon` property BlueZ reports is a
  freedesktop icon name (`audio-headset`, `input-mouse`, …), so the right glyph
  is picked automatically from your icon theme.
- Battery level comes from `org.bluez.Battery1` (`Percentage`). Devices that
  don't expose a battery simply show the icon with no bar.
- The indicator updates live by subscribing to BlueZ's `ObjectManager` and
  `PropertiesChanged` D-Bus signals — no polling.

The battery bar is colour-coded: green > 50%, amber 21–50%, red ≤ 20%.

## Layout

| File            | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `metadata.json` | Extension manifest (UUID, name, supported shell versions).     |
| `extension.js`  | All the logic: D-Bus wiring, panel indicator, battery bar, tooltip. |
| `stylesheet.css`| Styling for the indicator, battery bar and tooltip.            |
| `Makefile`      | Install / uninstall / check / pack helpers.                    |

## Install

Install (symlinks this repo into the extensions dir and enables it — ideal for
development, since edits are picked up without copying):

```bash
make install
```

This links the repo into
`~/.local/share/gnome-shell/extensions/bluetooth-devices-indicator@guido.local`.

**Wayland:** log out and back in for the shell to pick up the new extension.
**X11:** Alt+F2 → `r` → Enter to restart the shell.

To remove it again:

```bash
make uninstall
```

## Other Makefile targets

| Target          | What it does                                              |
| --------------- | --------------------------------------------------------- |
| `make enable`   | Enable the extension.                                     |
| `make disable`  | Disable the extension.                                    |
| `make check`    | Syntax-check `extension.js` and validate `metadata.json`. |
| `make pack`     | Build a distributable `.shell-extension.zip`.             |
| `make logs`     | Follow the GNOME Shell journal (handy for debugging).     |

Run `make help` for the full list.

## Debugging

Watch the shell logs while it loads:

```bash
make logs
```
